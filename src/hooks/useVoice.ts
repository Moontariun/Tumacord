import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorkletSource from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw';
import gtcrnWasmPath from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import type { PublicUser, StreamMeta, VoiceState } from '../../shared/types';
import type { DevicePreferences } from './useDevices';
import { playSound } from '../lib/sound';
import { isPolitePeer, shouldInitiateRecovery, shouldQueueIceCandidate, shouldRecoverMutedAudio } from '../lib/rtcPolicy';
import { activePathMetrics, adaptScreenBitrate, inboundAudioMetrics, median, outboundVideoMetrics, type RtcStatLike } from '../lib/networkQuality';

export type StreamQuality = 'source' | 'ultra60' | 'ultra30' | 'high' | 'balanced' | 'data';

const QUALITY: Record<StreamQuality, { label: string; width: number; height: number; frameRate: number; bitrate: number }> = {
  source: { label: 'Fonte · até 1080p60', width: 1920, height: 1080, frameRate: 60, bitrate: 8_000_000 },
  ultra60: { label: '2.5K · 60 FPS', width: 2560, height: 1440, frameRate: 60, bitrate: 14_000_000 },
  ultra30: { label: '2.5K · 30 FPS', width: 2560, height: 1440, frameRate: 30, bitrate: 10_000_000 },
  high: { label: 'Alta · 1080p30', width: 1920, height: 1080, frameRate: 30, bitrate: 5_000_000 },
  balanced: { label: 'Equilibrada · 720p30', width: 1280, height: 720, frameRate: 30, bitrate: 2_500_000 },
  data: { label: 'Econômica · 480p15', width: 854, height: 480, frameRate: 15, bitrate: 900_000 },
};

interface PeerConnectionState {
  pc: RTCPeerConnection;
  user?: PublicUser;
  makingOffer: boolean;
  ignoreOffer: boolean;
  needsNegotiation: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  recoveryAttempts: number;
  recoveryTimer?: number;
  mutedAudioTimers: Map<string, number>;
  screenBitrate?: number;
  healthyScreenSamples: number;
  lastScreenBytes?: number;
  lastScreenPackets?: number;
  stalledScreenSamples: number;
  lastScreenRecoveryAt: number;
  inboundVoice: Map<string, { packets?: number; stalled: number }>;
  lastVoiceRecoveryAt: number;
  remoteStreams: Map<string, MediaStream>;
}

function closePeerState(state: PeerConnectionState): void {
  if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
  for (const timer of state.mutedAudioTimers.values()) window.clearTimeout(timer);
  state.mutedAudioTimers.clear();
  state.pc.close();
}

export type PeerHealth = 'connecting' | 'connected' | 'recovering' | 'failed';

export interface RemoteMedia {
  peerId: string;
  user?: PublicUser;
  stream: MediaStream;
  kind: 'camera' | 'screen' | 'audio';
}

interface UseVoiceOptions {
  socket: Socket | null;
  user: PublicUser;
  preferences: DevicePreferences;
  onError: (message: string) => void;
  onDevicesChanged: () => Promise<void>;
  onHostHandoff: (host: VoiceState, channelId: string, abrupt: boolean) => void;
  dynamicHosting: boolean;
}

export const qualityOptions = Object.entries(QUALITY) as [StreamQuality, (typeof QUALITY)[StreamQuality]][];

// O Chromium costuma negociar Opus com bitrate conservador. Um teto de 96 kbps
// mantém a voz limpa sem transformar a malha P2P em uma transmissão pesada.
async function tuneVoiceSender(sender: RTCRtpSender): Promise<void> {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate: 96_000, dtx: false }));
  await sender.setParameters(parameters).catch(() => undefined);
}

async function tuneScreenSender(sender: RTCRtpSender, config: (typeof QUALITY)[StreamQuality], maxBitrate = config.bitrate): Promise<void> {
  const parameters = sender.getParameters();
  const current = parameters.encodings?.[0] ?? {};
  parameters.encodings = [{
    ...current,
    maxBitrate,
    maxFramerate: config.frameRate,
    priority: 'high',
    networkPriority: 'high',
  } as RTCRtpEncodingParameters];
  // Keep the requested frame rate when possible; this avoids the browser
  // oscillating between a sharp but jerky stream and a blurry one.
  (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = config.frameRate >= 60 ? 'maintain-framerate' : 'balanced';
  await sender.setParameters(parameters).catch(() => undefined);
}

interface MicrophoneProcessing {
  rawStream: MediaStream;
  outputStream: MediaStream;
  deviceId: string;
  neural: boolean;
  noiseSuppression: boolean;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  highPass?: BiquadFilterNode;
  suppressor?: GtcrnWorkletNode;
  compressor?: DynamicsCompressorNode;
  destination?: MediaStreamAudioDestinationNode;
}

let gtcrnBinaryPromise: Promise<ArrayBuffer> | null = null;

function loadGtcrnBinary(): Promise<ArrayBuffer> {
  if (!gtcrnBinaryPromise) {
    gtcrnBinaryPromise = fetch(gtcrnWasmPath).then((response) => {
      if (!response.ok) throw new Error(`GTCRN não carregou (${response.status}).`);
      return response.arrayBuffer();
    });
  }
  return gtcrnBinaryPromise;
}

async function createNeuralMicrophone(rawStream: MediaStream, deviceId: string): Promise<MicrophoneProcessing> {
  const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet não está disponível.');
  const context = new AudioContextClass({ sampleRate: 48_000, latencyHint: 'interactive' });
  try {
    await context.resume();
    const workletUrl = URL.createObjectURL(new Blob([gtcrnWorkletSource], { type: 'text/javascript' }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const wasmBinary = await loadGtcrnBinary();
    const source = context.createMediaStreamSource(rawStream);
    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 78;
    highPass.Q.value = 0.72;
    const suppressor = new GtcrnWorkletNode(context, { wasmBinary, maxChannels: 1 });
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.14;
    const destination = context.createMediaStreamDestination();
    source.connect(highPass).connect(suppressor).connect(compressor).connect(destination);
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error('O filtro neural não criou uma faixa de áudio.');
    if ('contentHint' in outputTrack) outputTrack.contentHint = 'speech';
    const outputStream = new MediaStream([outputTrack]);
    return { rawStream, outputStream, deviceId, neural: true, noiseSuppression: true, context, source, highPass, suppressor, compressor, destination };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

async function disposeMicrophoneProcessing(processing: MicrophoneProcessing | null): Promise<void> {
  if (!processing) return;
  processing.source?.disconnect();
  processing.highPass?.disconnect();
  processing.suppressor?.destroy();
  processing.suppressor?.disconnect();
  processing.compressor?.disconnect();
  processing.destination?.disconnect();
  processing.outputStream.getTracks().forEach((track) => track.stop());
  if (processing.rawStream !== processing.outputStream) processing.rawStream.getTracks().forEach((track) => track.stop());
  await processing.context?.close().catch(() => undefined);
}

function normalizedDeviceName(value: string): string {
  return value.toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
}

async function captureIsolatedScreenAudio(deviceName: string): Promise<MediaStream> {
  const wanted = normalizedDeviceName(deviceName || 'Tumacord Stream Audio');
  let device: MediaDeviceInfo | undefined;
  // PipeWire notifica a entrada virtual de forma assíncrona. Estas tentativas
  // curtas evitam obrigar o usuário a fechar e abrir o seletor novamente.
  for (let attempt = 0; attempt < 24 && !device; attempt += 1) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    device = devices.find((candidate) => candidate.kind === 'audioinput' && (
      normalizedDeviceName(candidate.label).includes(wanted)
      || normalizedDeviceName(candidate.label).includes('tumacordstreamaudio')
    ));
    if (!device) await new Promise((resolve) => window.setTimeout(resolve, 125));
  }
  if (!device) throw new Error('A fonte virtual de áudio do Tumacord não apareceu no PipeWire.');
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48_000 },
      sampleSize: { ideal: 16 },
    },
    video: false,
  });
}

export function useVoice({ socket, user, preferences, onError, onDevicesChanged, onHostHandoff, dynamicHosting }: UseVoiceOptions) {
  const [channelId, setChannelId] = useState<string | null>(null);
  const channelRef = useRef<string | null>(null);
  const [members, setMembers] = useState<VoiceState[]>([]);
  const membersRef = useRef<VoiceState[]>([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [quality, setQuality] = useState<StreamQuality>('balanced');
  const qualityRef = useRef<StreamQuality>('balanced');
  qualityRef.current = quality;
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([]);
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [showShareSetup, setShowShareSetup] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [peerHealth, setPeerHealth] = useState<Record<string, PeerHealth>>({});
  const peers = useRef(new Map<string, PeerConnectionState>());
  const localStreams = useRef(new Map<'microphone' | 'camera' | 'screen', MediaStream>());
  const streamMeta = useRef(new Map<string, StreamMeta['kind']>());
  const selfId = useRef('');
  const handoffStarted = useRef(false);
  const speakingRef = useRef(false);
  const speakingMonitor = useRef<{ context: AudioContext; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; timer: number } | null>(null);
  const microphoneProcessing = useRef<MicrophoneProcessing | null>(null);
  const negotiateRef = useRef<(peerId: string, iceRestart?: boolean) => Promise<void>>(async () => undefined);
  const recoverPeerRef = useRef<(peerId: string, reason?: string, notifyRemote?: boolean) => void>(() => undefined);
  const recoveryCooldown = useRef(new Map<string, number>());
  const missingScreenSince = useRef(new Map<string, number>());
  const missingVoiceSince = useRef(new Map<string, number>());
  const screenAudioRecovery = useRef<{ enabled: boolean; deviceName: string; attempts: number; notified?: boolean; timer?: number }>({ enabled: false, deviceName: '', attempts: 0 });
  const pendingShareOptions = useRef<{ includeAudio: boolean; quality: StreamQuality }>({ includeAudio: true, quality: 'balanced' });
  const shareListing = useRef(false);
  const shareCapture = useRef(false);
  const screenAudioEnabled = useRef(false);
  const screenAudioHealthCheck = useRef(false);
  const screenAudioEndedRef = useRef<(endedTrack: MediaStreamTrack) => void>(() => undefined);

  const publishState = useCallback((patch: Record<string, boolean>) => socket?.emit('voice:state', patch), [socket]);

  const stopSpeakingMonitor = useCallback(() => {
    const monitor = speakingMonitor.current;
    if (!monitor) return;
    window.clearInterval(monitor.timer);
    monitor.source.disconnect();
    monitor.analyser.disconnect();
    void monitor.context.close();
    speakingMonitor.current = null;
    if (speakingRef.current) {
      speakingRef.current = false;
      publishState({ speaking: false });
    }
  }, [publishState]);

  const startSpeakingMonitor = useCallback((stream: MediaStream) => {
    stopSpeakingMonitor();
    if (typeof window === 'undefined') return;
    const AudioContextClass = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const track = stream.getAudioTracks()[0];
    if (!AudioContextClass || !track) return;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      if (!track.enabled || !channelRef.current) {
        if (speakingRef.current) {
          speakingRef.current = false;
          publishState({ speaking: false });
        }
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normalized = (sample - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / samples.length);
      const nextSpeaking = speakingRef.current ? rms > 0.025 : rms > 0.045;
      if (nextSpeaking !== speakingRef.current) {
        speakingRef.current = nextSpeaking;
        publishState({ speaking: nextSpeaking });
      }
    }, 80);
    speakingMonitor.current = { context, source, analyser, timer };
    if (context.state === 'suspended') void context.resume();
  }, [publishState, stopSpeakingMonitor]);

  const refreshRemote = useCallback(() => {
    const media: RemoteMedia[] = [];
    for (const [peerId, peer] of peers.current) {
      for (const stream of peer.remoteStreams.values()) {
        if (!stream.getTracks().some((track) => track.readyState !== 'ended')) continue;
        const meta = streamMeta.current.get(`${peerId}:${stream.id}`);
        media.push({ peerId, user: peer.user, stream, kind: meta ?? (stream.getVideoTracks().length ? 'camera' : 'audio') });
      }
    }
    setRemoteMedia(media);
  }, []);

  const updatePeerHealth = useCallback((peerId: string, health?: PeerHealth) => {
    setPeerHealth((current) => {
      if (health && current[peerId] === health) return current;
      const next = { ...current };
      if (health) next[peerId] = health;
      else delete next[peerId];
      return next;
    });
  }, []);

  const flushPendingCandidates = useCallback(async (state: PeerConnectionState) => {
    if (!state.pc.remoteDescription) return;
    const candidates = state.pendingCandidates.splice(0);
    for (const candidate of candidates) await state.pc.addIceCandidate(candidate).catch(() => undefined);
  }, []);

  const sendStreamMeta = useCallback((target: string, stream: MediaStream, kind: StreamMeta['kind']) => {
    socket?.emit('rtc:stream-meta', { target, meta: { streamId: stream.id, kind } });
  }, [socket]);

  const addLocalStreams = useCallback((target: string, pc: RTCPeerConnection) => {
    for (const [kind, stream] of localStreams.current) {
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (kind === 'microphone') void tuneVoiceSender(sender);
        if (kind === 'screen' && track.kind === 'video') void tuneScreenSender(sender, QUALITY[qualityRef.current]);
      }
      if (kind === 'camera' || kind === 'screen') sendStreamMeta(target, stream, kind);
    }
  }, [sendStreamMeta]);

  const createPeer = useCallback((peerId: string, remoteUser?: PublicUser) => {
    const found = peers.current.get(peerId);
    if (found) {
      if (remoteUser) found.user = remoteUser;
      return found;
    }
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [], iceCandidatePoolSize: 4 });
    const state: PeerConnectionState = {
      pc,
      user: remoteUser,
      makingOffer: false,
      ignoreOffer: false,
      needsNegotiation: false,
      pendingCandidates: [],
      recoveryAttempts: 0,
      mutedAudioTimers: new Map(),
      screenBitrate: localStreams.current.has('screen') ? QUALITY[qualityRef.current].bitrate : undefined,
      healthyScreenSamples: 0,
      stalledScreenSamples: 0,
      lastScreenRecoveryAt: 0,
      inboundVoice: new Map(),
      lastVoiceRecoveryAt: 0,
      remoteStreams: new Map(),
    };
    peers.current.set(peerId, state);
    updatePeerHealth(peerId, 'connecting');
    addLocalStreams(peerId, pc);
    pc.onicecandidate = ({ candidate }) => candidate && socket?.emit('rtc:ice', { target: peerId, candidate });
    pc.onnegotiationneeded = () => void negotiateRef.current(peerId);
    pc.ontrack = (event) => {
      for (const stream of event.streams) state.remoteStreams.set(stream.id, stream);
      const stream = event.streams[0];
      const clearMutedAudioTimer = () => {
        const timer = state.mutedAudioTimers.get(event.track.id);
        if (timer) window.clearTimeout(timer);
        state.mutedAudioTimers.delete(event.track.id);
      };
      event.track.onmute = () => {
        refreshRemote();
        if (event.track.kind !== 'audio') return;
        clearMutedAudioTimer();
        state.mutedAudioTimers.set(event.track.id, window.setTimeout(() => {
          state.mutedAudioTimers.delete(event.track.id);
          if (peers.current.get(peerId) !== state || !event.track.muted) return;
          const member = membersRef.current.find((candidate) => candidate.socketId === peerId);
          const meta = stream ? streamMeta.current.get(`${peerId}:${stream.id}`) : undefined;
          const screen = meta === 'screen' || Boolean(stream?.getVideoTracks().length && member?.screen);
          if (shouldRecoverMutedAudio({
            trackMuted: event.track.muted,
            remoteMuted: member?.muted ?? true,
            screen,
            screenAudioExpected: member?.screenAudio ?? false,
          })) recoverPeerRef.current(peerId, screen ? 'áudio da live interrompido' : 'áudio da call interrompido', true);
        }, 4_000));
      };
      event.track.onunmute = () => {
        clearMutedAudioTimer();
        updatePeerHealth(peerId, 'connected');
        refreshRemote();
      };
      event.track.onended = () => {
        clearMutedAudioTimer();
        for (const [streamId, stream] of state.remoteStreams) {
          if (stream.getTracks().every((track) => track.readyState === 'ended')) state.remoteStreams.delete(streamId);
        }
        refreshRemote();
      };
      refreshRemote();
    };
    pc.onconnectionstatechange = () => {
      if (peers.current.get(peerId) !== state) return;
      if (pc.connectionState === 'connected') {
        if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
        state.recoveryTimer = undefined;
        state.recoveryAttempts = 0;
        updatePeerHealth(peerId, 'connected');
        return;
      }
      if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
        updatePeerHealth(peerId, state.recoveryAttempts ? 'recovering' : 'connecting');
        return;
      }
      if (pc.connectionState === 'disconnected') {
        updatePeerHealth(peerId, 'recovering');
        if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
        state.recoveryTimer = window.setTimeout(() => {
          if (peers.current.get(peerId) !== state || pc.connectionState !== 'disconnected') return;
          void negotiateRef.current(peerId, true);
          state.recoveryTimer = window.setTimeout(() => {
            if (peers.current.get(peerId) === state && pc.connectionState !== 'connected') recoverPeerRef.current(peerId, 'conexão interrompida', true);
          }, 5_500);
        }, 1_500);
        return;
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        updatePeerHealth(peerId, 'failed');
        recoverPeerRef.current(peerId, `estado ${pc.connectionState}`, true);
      }
    };
    return state;
  }, [addLocalStreams, refreshRemote, socket, updatePeerHealth]);

  const negotiate = useCallback(async (peerId: string, iceRestart = false) => {
    const state = peers.current.get(peerId);
    if (!state) return;
    if (state.makingOffer || state.pc.signalingState !== 'stable') {
      state.needsNegotiation = true;
      return;
    }
    try {
      state.makingOffer = true;
      state.needsNegotiation = false;
      if (iceRestart) state.pc.restartIce();
      await state.pc.setLocalDescription(await state.pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
      socket?.emit('rtc:offer', { target: peerId, sdp: state.pc.localDescription });
    } catch {
      state.needsNegotiation = true;
    } finally {
      state.makingOffer = false;
      if (state.needsNegotiation && state.pc.signalingState === 'stable' && peers.current.get(peerId) === state) {
        window.setTimeout(() => void negotiateRef.current(peerId), 0);
      }
    }
  }, [socket]);
  negotiateRef.current = negotiate;

  const recoverPeer = useCallback((peerId: string, _reason = 'recuperação manual', notifyRemote = true) => {
    if (!channelRef.current || peerId === selfId.current) return;
    const now = Date.now();
    if (now - (recoveryCooldown.current.get(peerId) ?? 0) < 500) return;
    recoveryCooldown.current.set(peerId, now);
    const previous = peers.current.get(peerId);
    const remoteUser = previous?.user ?? membersRef.current.find((member) => member.socketId === peerId);
    const attempt = Math.min(6, (previous?.recoveryAttempts ?? 0) + 1);
    peers.current.delete(peerId);
    if (previous) closePeerState(previous);
    for (const key of [...streamMeta.current.keys()]) if (key.startsWith(`${peerId}:`)) streamMeta.current.delete(key);
    refreshRemote();
    updatePeerHealth(peerId, 'recovering');
    const next = createPeer(peerId, remoteUser);
    next.recoveryAttempts = attempt;
    if (notifyRemote) socket?.emit('rtc:resync', { target: peerId });
    if (shouldInitiateRecovery(selfId.current, peerId)) window.setTimeout(() => void negotiateRef.current(peerId, attempt > 1), 80);
  }, [createPeer, refreshRemote, socket, updatePeerHealth]);
  recoverPeerRef.current = recoverPeer;

  const recoverAllPeers = useCallback(() => {
    const targets = membersRef.current.filter((member) => member.socketId !== selfId.current);
    for (const member of targets) recoverPeer(member.socketId, 'reconexão manual da malha P2P', true);
    return targets.length;
  }, [recoverPeer]);

  const recoverScreenAudio = useCallback((endedTrack: MediaStreamTrack) => {
    const recovery = screenAudioRecovery.current;
    const screen = localStreams.current.get('screen');
    if (!recovery.enabled || !screen || !screen.getVideoTracks().some((track) => track.readyState === 'live')) return;
    screen.removeTrack(endedTrack);
    if (recovery.timer) window.clearTimeout(recovery.timer);
    const delay = Math.min(8_000, 750 * (2 ** recovery.attempts));
    recovery.timer = window.setTimeout(async () => {
      if (!recovery.enabled || localStreams.current.get('screen') !== screen) return;
      try {
        const prepared = await window.tumacordDesktop?.prepareScreenAudio();
        if (window.tumacordDesktop && !prepared?.ok) throw new Error(prepared?.error ?? 'O PipeWire não recriou o barramento da live.');
        if (prepared?.deviceName) recovery.deviceName = prepared.deviceName;
        const replacement = await captureIsolatedScreenAudio(recovery.deviceName);
        const newTrack = replacement.getAudioTracks()[0];
        if (!newTrack) throw new Error('Faixa de áudio não apareceu.');
        if (!recovery.enabled || localStreams.current.get('screen') !== screen) {
          replacement.getTracks().forEach((track) => track.stop());
          return;
        }
        screen.addTrack(newTrack);
        newTrack.onended = () => screenAudioEndedRef.current(newTrack);
        for (const [peerId, state] of peers.current) {
          const sender = state.pc.getSenders().find((candidate) => candidate.track === endedTrack);
          if (sender) await sender.replaceTrack(newTrack);
          else state.pc.addTrack(newTrack, screen);
          sendStreamMeta(peerId, screen, 'screen');
          if (!sender) void negotiateRef.current(peerId);
        }
        recovery.attempts = 0;
        recovery.notified = false;
        screenAudioEnabled.current = true;
        publishState({ screenAudio: true });
      } catch {
        recovery.attempts += 1;
        if (recovery.attempts >= 5 && !recovery.notified) {
          recovery.notified = true;
          onError('O áudio da live está sendo reconstruído automaticamente; o vídeo continua ativo.');
        }
        screenAudioEndedRef.current(endedTrack);
      }
    }, delay);
  }, [onError, publishState, sendStreamMeta]);
  screenAudioEndedRef.current = recoverScreenAudio;

  const stopStream = useCallback(async (kind: 'camera' | 'screen') => {
    const stream = localStreams.current.get(kind);
    if (!stream) return;
    for (const [peerId, state] of peers.current) {
      for (const track of stream.getTracks()) {
        const sender = state.pc.getSenders().find((candidate) => candidate.track === track);
        if (sender) state.pc.removeTrack(sender);
      }
      void negotiate(peerId);
    }
    stream.getTracks().forEach((track) => track.stop());
    localStreams.current.delete(kind);
    if (kind === 'camera') {
      setCameraOn(false);
      publishState({ camera: false });
    } else {
      screenAudioRecovery.current.enabled = false;
      screenAudioEnabled.current = false;
      screenAudioRecovery.current.attempts = 0;
      if (screenAudioRecovery.current.timer) window.clearTimeout(screenAudioRecovery.current.timer);
      screenAudioRecovery.current.timer = undefined;
      setScreenOn(false);
      setShowShareSetup(false);
      setShowSourcePicker(false);
      publishState({ screen: false, screenAudio: false });
      await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
    }
    playSound(kind === 'screen' ? 'streamStop' : 'notification');
  }, [negotiate, publishState]);

  const attachStream = useCallback(async (kind: 'camera' | 'screen', stream: MediaStream, screenQuality: StreamQuality = quality) => {
    localStreams.current.set(kind, stream);
    for (const [peerId, state] of peers.current) {
      for (const track of stream.getTracks()) state.pc.addTrack(track, stream);
      sendStreamMeta(peerId, stream, kind);
      if (kind === 'screen') {
        const videoTrack = stream.getVideoTracks()[0];
        const sender = state.pc.getSenders().find((candidate) => candidate.track === videoTrack);
        const config = QUALITY[screenQuality];
        if (sender) {
          await tuneScreenSender(sender, config);
          state.screenBitrate = config.bitrate;
          state.healthyScreenSamples = 0;
          state.lastScreenBytes = undefined;
          state.lastScreenPackets = undefined;
          state.stalledScreenSamples = 0;
        }
      }
      void negotiate(peerId);
    }
    stream.getTracks().forEach((track) => {
      if (kind === 'screen' && track.kind === 'video' && 'contentHint' in track) track.contentHint = 'detail';
      if (kind === 'screen' && track.kind === 'audio') track.onended = () => screenAudioEndedRef.current(track);
      else track.onended = () => void stopStream(kind);
    });
    if (kind === 'camera') {
      setCameraOn(true);
      publishState({ camera: true });
    } else {
      setScreenOn(true);
      setShowSourcePicker(false);
      screenAudioEnabled.current = stream.getAudioTracks().some((track) => track.readyState === 'live');
      publishState({ screen: true, screenAudio: screenAudioEnabled.current });
    }
    playSound(kind === 'screen' ? 'streamStart' : 'notification');
  }, [negotiate, publishState, quality, sendStreamMeta, stopStream]);

  const ensureMicrophone = useCallback(async () => {
    const current = localStreams.current.get('microphone');
    const currentProcessing = microphoneProcessing.current;
    if (current && currentProcessing?.deviceId === preferences.microphoneId && currentProcessing.noiseSuppression === preferences.noiseSuppression) return current;

    const captureRawMicrophone = (browserNoiseSuppression: boolean) => navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: preferences.microphoneId ? { exact: preferences.microphoneId } : undefined,
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: browserNoiseSuppression },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48_000 },
        sampleSize: { ideal: 16 },
      },
      video: false,
    });

    let rawStream = await captureRawMicrophone(false);
    let nextProcessing: MicrophoneProcessing;
    if (preferences.noiseSuppression) {
      try {
        nextProcessing = await createNeuralMicrophone(rawStream, preferences.microphoneId);
      } catch {
        rawStream.getTracks().forEach((track) => track.stop());
        rawStream = await captureRawMicrophone(true);
        nextProcessing = { rawStream, outputStream: rawStream, deviceId: preferences.microphoneId, neural: false, noiseSuppression: true };
        onError('O filtro neural não iniciou; ativei a supressão compatível do microfone como reserva.');
      }
    } else {
      nextProcessing = { rawStream, outputStream: rawStream, deviceId: preferences.microphoneId, neural: false, noiseSuppression: false };
    }

    const stream = nextProcessing.outputStream;
    const old = localStreams.current.get('microphone');
    localStreams.current.set('microphone', stream);
    microphoneProcessing.current = nextProcessing;
    const newTrack = stream.getAudioTracks()[0];
    if ('contentHint' in newTrack) newTrack.contentHint = 'speech';
    newTrack.enabled = !mutedRef.current;
    for (const state of peers.current.values()) {
      const oldTrack = old?.getAudioTracks()[0];
      const sender = state.pc.getSenders().find((candidate) => candidate.track === oldTrack);
      if (sender) {
        await sender.replaceTrack(newTrack);
        await tuneVoiceSender(sender);
      }
    }
    if (currentProcessing) await disposeMicrophoneProcessing(currentProcessing);
    else old?.getTracks().forEach((track) => track.stop());
    await onDevicesChanged();
    if (channelRef.current) startSpeakingMonitor(stream);
    return stream;
  }, [onDevicesChanged, onError, preferences.microphoneId, preferences.noiseSuppression, startSpeakingMonitor]);

  const join = useCallback(async (nextChannelId: string) => {
    if (!socket) return;
    try {
      await ensureMicrophone();
    } catch {
      mutedRef.current = true;
      setMuted(true);
      onError('Microfone indisponível. Você entrou mutado; confira as permissões nas configurações.');
    }
    if (channelRef.current) {
      const previousPeers = [...peers.current.values()];
      peers.current.clear();
      previousPeers.forEach(closePeerState);
      setRemoteMedia([]);
      setPeerHealth({});
    }
    socket.emit('voice:join', nextChannelId, (result: { ok: boolean; selfId: string; peers: VoiceState[] }) => {
      if (!result?.ok) return onError('Não foi possível entrar nessa call.');
      selfId.current = result.selfId;
      channelRef.current = nextChannelId;
      handoffStarted.current = false;
      setChannelId(nextChannelId);
      const microphone = localStreams.current.get('microphone');
      if (microphone) startSpeakingMonitor(microphone);
      for (const peer of result.peers) {
        createPeer(peer.socketId, peer);
        void negotiate(peer.socketId);
      }
      publishState({
        muted: mutedRef.current,
        deafened: deafenedRef.current,
        camera: localStreams.current.has('camera'),
        screen: localStreams.current.has('screen'),
        screenAudio: screenAudioEnabled.current,
        speaking: false,
      });
      playSound('join');
    });
  }, [createPeer, ensureMicrophone, negotiate, onError, publishState, socket, startSpeakingMonitor]);

  const leave = useCallback(() => {
    const wasInCall = Boolean(channelRef.current);
    stopSpeakingMonitor();
    socket?.emit('voice:leave');
    const previousPeers = [...peers.current.values()];
    peers.current.clear();
    previousPeers.forEach(closePeerState);
    for (const stream of localStreams.current.values()) stream.getTracks().forEach((track) => track.stop());
    localStreams.current.clear();
    const processing = microphoneProcessing.current;
    microphoneProcessing.current = null;
    void disposeMicrophoneProcessing(processing);
    void window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
    channelRef.current = null;
    handoffStarted.current = false;
    setChannelId(null);
    setMembers([]);
    setRemoteMedia([]);
    setPeerHealth({});
    setCameraOn(false);
    setScreenOn(false);
    screenAudioEnabled.current = false;
    if (wasInCall) playSound('leave');
  }, [socket, stopSpeakingMonitor]);

  useEffect(() => {
    if (!socket) return;
    const onMembers = (next: VoiceState[]) => {
      const previous = membersRef.current;
      const remoteStreamStarted = next.some((member) => member.socketId !== selfId.current && member.screen && !previous.some((candidate) => candidate.id === member.id && candidate.screen));
      const remoteStreamStopped = previous.some((member) => member.socketId !== selfId.current && member.screen && !next.some((candidate) => candidate.id === member.id && candidate.screen));
      membersRef.current = next;
      setMembers(next);
      if (remoteStreamStarted) playSound('streamStart');
      else if (remoteStreamStopped) playSound('streamStop');
    };
    const onPeerLeft = (peerId: string) => {
      const peer = peers.current.get(peerId);
      peers.current.delete(peerId);
      if (peer) closePeerState(peer);
      for (const key of [...streamMeta.current.keys()]) if (key.startsWith(`${peerId}:`)) streamMeta.current.delete(key);
      updatePeerHealth(peerId);
      refreshRemote();
      playSound('leave');
    };
    const onPeerJoined = (peer: VoiceState | undefined) => {
      if (!peer || peer.socketId === selfId.current || !channelRef.current) return;
      createPeer(peer.socketId, peer);
      // O estado vem das trilhas reais, não de um valor React possivelmente
      // antigo durante uma reconexão rápida.
      publishState({
        muted: mutedRef.current,
        deafened: deafenedRef.current,
        camera: localStreams.current.has('camera'),
        screen: localStreams.current.has('screen'),
        screenAudio: screenAudioEnabled.current,
        speaking: speakingRef.current,
      });
      if (shouldInitiateRecovery(selfId.current, peer.socketId)) void negotiateRef.current(peer.socketId);
    };
    const onOffer = async ({ from, user: remoteUser, sdp }: { from: string; user: PublicUser; sdp: RTCSessionDescriptionInit }) => {
      const state = createPeer(from, remoteUser);
      const collision = state.makingOffer || state.pc.signalingState !== 'stable';
      const polite = isPolitePeer(selfId.current, from);
      state.ignoreOffer = !polite && collision;
      if (state.ignoreOffer) return;
      try {
        if (collision) await state.pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
        await state.pc.setRemoteDescription(sdp);
        state.ignoreOffer = false;
        await flushPendingCandidates(state);
        await state.pc.setLocalDescription(await state.pc.createAnswer());
        socket.emit('rtc:answer', { target: from, sdp: state.pc.localDescription });
        if (state.needsNegotiation) window.setTimeout(() => void negotiateRef.current(from), 0);
      } catch {
        state.needsNegotiation = true;
        recoverPeer(from, 'erro ao aplicar oferta', true);
      }
    };
    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const state = peers.current.get(from);
      if (state && state.pc.signalingState === 'have-local-offer') {
        try {
          await state.pc.setRemoteDescription(sdp);
          state.ignoreOffer = false;
          await flushPendingCandidates(state);
          if (state.needsNegotiation) window.setTimeout(() => void negotiateRef.current(from), 0);
        } catch {
          recoverPeer(from, 'erro ao aplicar resposta', true);
        }
      }
    };
    const onIce = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const state = peers.current.get(from);
      if (!state || state.ignoreOffer) return;
      if (shouldQueueIceCandidate(Boolean(state.pc.remoteDescription))) state.pendingCandidates.push(candidate);
      else await state.pc.addIceCandidate(candidate).catch(() => undefined);
    };
    const onMeta = ({ from, meta }: { from: string; meta: StreamMeta }) => {
      if (!meta) return;
      streamMeta.current.set(`${from}:${meta.streamId}`, meta.kind);
      refreshRemote();
    };
    const onResync = ({ from }: { from: string }) => recoverPeer(from, 'pedido do outro participante', false);
    const onHandoff = ({ channelId: handoffChannel, host }: { channelId: string; host: VoiceState }) => {
      if (!dynamicHosting) return;
      if (handoffStarted.current || handoffChannel !== channelRef.current) return;
      handoffStarted.current = true;
      onHostHandoff(host, handoffChannel, false);
    };
    const onDisconnect = (reason: string) => {
      if (reason === 'io client disconnect') return;
      if (!dynamicHosting) return;
      const activeChannel = channelRef.current;
      if (!activeChannel || handoffStarted.current) return;
      const candidate = membersRef.current
        .filter((member) => !member.isHost)
        .sort((a, b) => (a.pingMs - b.pingMs) || a.id.localeCompare(b.id))[0];
      if (!candidate) return;
      handoffStarted.current = true;
      onHostHandoff(candidate, activeChannel, true);
    };
    socket.on('voice:members', onMembers);
    socket.on('voice:peer-joined', onPeerJoined);
    socket.on('voice:peer-left', onPeerLeft);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);
    socket.on('rtc:stream-meta', onMeta);
    socket.on('rtc:resync', onResync);
    socket.on('voice:host-handoff', onHandoff);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('voice:members', onMembers);
      socket.off('voice:peer-joined', onPeerJoined);
      socket.off('voice:peer-left', onPeerLeft);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
      socket.off('rtc:stream-meta', onMeta);
      socket.off('rtc:resync', onResync);
      socket.off('voice:host-handoff', onHandoff);
      socket.off('disconnect', onDisconnect);
    };
  }, [createPeer, dynamicHosting, flushPendingCandidates, onHostHandoff, publishState, recoverPeer, refreshRemote, socket, updatePeerHealth]);

  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // Limpa captura somente quando o hook realmente desmonta. Trocar do host
  // P2P antigo para o novo troca o socket, mas deve preservar a tela/câmera.
  useEffect(() => () => leaveRef.current(), []);

  const joinRef = useRef(join);
  joinRef.current = join;
  useEffect(() => {
    if (!socket) return;
    const rejoinAfterReconnect = () => {
      const activeChannel = channelRef.current;
      if (activeChannel) void joinRef.current(activeChannel);
    };
    socket.on('connect', rejoinAfterReconnect);
    if (socket.connected && channelRef.current) void joinRef.current(channelRef.current);
    return () => { socket.off('connect', rejoinAfterReconnect); };
  }, [socket]);

  useEffect(() => {
    if (!socket || !channelId) return;
    let running = false;
    const publishLatency = async () => {
      if (running) return;
      running = true;
      const samples: number[] = [];
      const stalledPeers: string[] = [];
      const stalledVoicePeers = new Set<string>();
      try {
        for (const [peerId, state] of peers.current) {
          const report = await state.pc.getStats().catch(() => null);
          if (!report) continue;
          const stats: RtcStatLike[] = [];
          report.forEach((stat) => stats.push(stat as unknown as RtcStatLike));
          const path = activePathMetrics(stats);
          if (path.rttMs !== undefined) samples.push(path.rttMs);

          const remoteMember = membersRef.current.find((member) => member.socketId === peerId);
          for (const receiver of state.pc.getReceivers().filter((candidate) => candidate.track?.kind === 'audio')) {
            const receiverStream = [...state.remoteStreams.values()].find((stream) => stream.getTracks().some((track) => track.id === receiver.track.id));
            const meta = receiverStream ? streamMeta.current.get(`${peerId}:${receiverStream.id}`) : undefined;
            const isScreenAudio = meta === 'screen' || Boolean(receiverStream?.getVideoTracks().length && remoteMember?.screen);
            if (isScreenAudio || remoteMember?.muted !== false) {
              state.inboundVoice.delete(receiver.track.id);
              continue;
            }
            const receiverReport = await receiver.getStats().catch(() => null);
            const receiverStats: RtcStatLike[] = [];
            receiverReport?.forEach((stat) => receiverStats.push(stat as unknown as RtcStatLike));
            const inbound = inboundAudioMetrics(receiverStats);
            if (inbound.packetsReceived === undefined) continue;
            const previous = state.inboundVoice.get(receiver.track.id) ?? { stalled: 0 };
            const stalled = previous.packets !== undefined && inbound.packetsReceived <= previous.packets ? previous.stalled + 1 : 0;
            state.inboundVoice.set(receiver.track.id, { packets: inbound.packetsReceived, stalled });
            const now = Date.now();
            if (stalled >= 4 && now - state.lastVoiceRecoveryAt >= 15_000) {
              state.lastVoiceRecoveryAt = now;
              stalledVoicePeers.add(peerId);
            }
          }

          const screen = localStreams.current.get('screen');
          const screenTrack = screen?.getVideoTracks().find((track) => track.readyState === 'live');
          const sender = screenTrack ? state.pc.getSenders().find((candidate) => candidate.track === screenTrack) : undefined;
          if (!sender || !screenTrack) continue;
          const senderReport = await sender.getStats().catch(() => null);
          const senderStats: RtcStatLike[] = [];
          senderReport?.forEach((stat) => senderStats.push(stat as unknown as RtcStatLike));
          const outbound = outboundVideoMetrics(senderStats.length ? senderStats : stats);
          const config = QUALITY[qualityRef.current];
          const decision = adaptScreenBitrate({
            targetBitrate: config.bitrate,
            currentBitrate: state.screenBitrate ?? config.bitrate,
            healthySamples: state.healthyScreenSamples,
            rttMs: path.rttMs,
            availableOutgoingBitrate: path.availableOutgoingBitrate,
            fractionLost: outbound.fractionLost,
          });
          state.healthyScreenSamples = decision.healthySamples;
          if (Math.abs(decision.bitrate - (state.screenBitrate ?? config.bitrate)) >= 50_000) {
            state.screenBitrate = decision.bitrate;
            await tuneScreenSender(sender, config, decision.bitrate);
          }

          if (outbound.bytesSent !== undefined && outbound.packetsSent !== undefined && state.pc.connectionState === 'connected' && screenTrack.enabled) {
            state.stalledScreenSamples = state.lastScreenBytes !== undefined
              && state.lastScreenPackets !== undefined
              && outbound.bytesSent <= state.lastScreenBytes
              && outbound.packetsSent <= state.lastScreenPackets
              ? state.stalledScreenSamples + 1
              : 0;
            state.lastScreenBytes = outbound.bytesSent;
            state.lastScreenPackets = outbound.packetsSent;
            const now = Date.now();
            if (state.stalledScreenSamples >= 5 && now - state.lastScreenRecoveryAt >= 20_000) {
              state.lastScreenRecoveryAt = now;
              state.stalledScreenSamples = 0;
              stalledPeers.push(peerId);
            }
          }
        }
        socket.emit('voice:latency', median(samples) ?? 9999);
        for (const peerId of stalledPeers) recoverPeerRef.current(peerId, 'live local sem tráfego', true);
        for (const peerId of stalledVoicePeers) recoverPeerRef.current(peerId, 'áudio remoto sem tráfego RTP', true);
      } finally {
        running = false;
      }
    };
    void publishLatency();
    const timer = window.setInterval(() => void publishLatency(), 2000);
    return () => window.clearInterval(timer);
  }, [channelId, socket]);

  useEffect(() => {
    if (!channelRef.current || !localStreams.current.has('microphone')) return;
    void ensureMicrophone().catch(() => onError('Não foi possível atualizar o processamento do microfone.'));
  }, [ensureMicrophone, onError]);

  useEffect(() => {
    if (!channelId) return;
    const inspectExpectedMedia = () => {
      const now = Date.now();
      const expectedScreens = new Map(membersRef.current
        .filter((member) => member.socketId !== selfId.current && member.screen)
        .map((member) => [member.socketId, member]));
      for (const peerId of [...missingScreenSince.current.keys()]) if (!expectedScreens.has(peerId)) missingScreenSince.current.delete(peerId);
      for (const [peerId, member] of expectedScreens) {
        const screenMedia = remoteMedia.find((media) => media.peerId === peerId && media.kind === 'screen' && media.stream.getVideoTracks().some((track) => track.readyState === 'live'));
        const hasExpectedAudio = !member.screenAudio || Boolean(screenMedia?.stream.getAudioTracks().some((track) => track.readyState === 'live'));
        if (screenMedia && hasExpectedAudio) {
          missingScreenSince.current.delete(peerId);
          continue;
        }
        const missingSince = missingScreenSince.current.get(peerId) ?? now;
        missingScreenSince.current.set(peerId, missingSince);
        const lastRecovery = recoveryCooldown.current.get(peerId) ?? 0;
        if (now - missingSince >= 5_000 && now - lastRecovery >= 8_000) {
          missingScreenSince.current.set(peerId, now);
          recoverPeer(peerId, screenMedia ? 'live anunciada sem trilha de áudio' : 'live anunciada sem trilha de vídeo', true);
        }
      }

      const expectedVoices = new Set(membersRef.current
        .filter((member) => member.socketId !== selfId.current && !member.muted)
        .map((member) => member.socketId));
      for (const peerId of [...missingVoiceSince.current.keys()]) if (!expectedVoices.has(peerId)) missingVoiceSince.current.delete(peerId);
      for (const peerId of expectedVoices) {
        const hasVoice = remoteMedia.some((media) => media.peerId === peerId && media.kind === 'audio' && media.stream.getAudioTracks().some((track) => track.readyState === 'live'));
        if (hasVoice) {
          missingVoiceSince.current.delete(peerId);
          continue;
        }
        const missingSince = missingVoiceSince.current.get(peerId) ?? now;
        missingVoiceSince.current.set(peerId, missingSince);
        const lastRecovery = recoveryCooldown.current.get(peerId) ?? 0;
        if (now - missingSince >= 5_000 && now - lastRecovery >= 8_000) {
          missingVoiceSince.current.set(peerId, now);
          recoverPeer(peerId, 'participante sem trilha de voz', true);
        }
      }
    };
    inspectExpectedMedia();
    const timer = window.setInterval(inspectExpectedMedia, 2_000);
    return () => window.clearInterval(timer);
  }, [channelId, recoverPeer, remoteMedia]);

  useEffect(() => {
    if (!screenOn || !screenAudioEnabled.current || !window.tumacordDesktop) return;
    const keepScreenAudioHealthy = async () => {
      if (screenAudioHealthCheck.current || !screenAudioRecovery.current.enabled) return;
      screenAudioHealthCheck.current = true;
      try {
        const prepared = await window.tumacordDesktop?.prepareScreenAudio();
        if (prepared?.ok && prepared.deviceName) screenAudioRecovery.current.deviceName = prepared.deviceName;
      } finally {
        screenAudioHealthCheck.current = false;
      }
    };
    void keepScreenAudioHealthy();
    const timer = window.setInterval(() => void keepScreenAudioHealthy(), 4_000);
    return () => window.clearInterval(timer);
  }, [screenOn]);

  const toggleMute = async () => {
    const next = !mutedRef.current;
    if (!next && !localStreams.current.has('microphone')) await ensureMicrophone().catch(() => onError('Não consegui abrir o microfone.'));
    localStreams.current.get('microphone')?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    mutedRef.current = next;
    setMuted(next);
    publishState({ muted: next, speaking: false });
    if (next && speakingRef.current) {
      speakingRef.current = false;
    }
    playSound(next ? 'mute' : 'unmute');
  };

  const toggleDeafen = () => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    publishState({ deafened: next });
    playSound(next ? 'mute' : 'unmute');
  };

  const toggleCamera = async () => {
    if (cameraOn) return stopStream('camera');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: preferences.cameraId ? { exact: preferences.cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      await attachStream('camera', stream);
      await onDevicesChanged();
    } catch { onError('Câmera indisponível ou permissão negada.'); }
  };

  const requestScreenShare = async () => {
    if (screenOn) return stopStream('screen');
    if (shareListing.current || shareCapture.current) return;
    setShowShareSetup(true);
  };

  const prepareScreenShare = async (includeAudio: boolean, selectedQuality: StreamQuality) => {
    if (shareListing.current || shareCapture.current) return;
    shareListing.current = true;
    setShareBusy(true);
    pendingShareOptions.current = { includeAudio, quality: selectedQuality };
    setQuality(selectedQuality);
    try {
      if (window.tumacordDesktop) {
        const sources = await window.tumacordDesktop.getSources();
        if (!sources.length) throw new Error('Nenhuma tela ou janela foi encontrada.');
        setDesktopSources(sources);
        setShowShareSetup(false);
        // No Wayland/PipeWire, getSources já abre o seletor do sistema e
        // devolve somente a fonte escolhida. Começar direto evita pedir a
        // mesma tela novamente em um segundo seletor.
        if (sources.length === 1) await shareDesktopSource(sources[0].id, sources[0].kind);
        else setShowSourcePicker(true);
        return;
      }
      const config = QUALITY[selectedQuality];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: config.width, max: config.width }, height: { ideal: config.height, max: config.height }, frameRate: { ideal: config.frameRate, max: config.frameRate } },
        audio: includeAudio,
        selfBrowserSurface: 'exclude',
        systemAudio: includeAudio ? 'include' : 'exclude',
        windowAudio: 'window',
      } as DisplayMediaStreamOptions);
      setShowShareSetup(false);
      await attachStream('screen', stream, selectedQuality);
    } catch (error) {
      if ((error as DOMException).name !== 'NotAllowedError') onError(error instanceof Error ? error.message : 'Não consegui compartilhar a tela.');
    } finally {
      shareListing.current = false;
      if (!shareCapture.current) setShareBusy(false);
    }
  };

  async function shareDesktopSource(sourceId: string, _sourceKind: DesktopSource['kind']): Promise<void> {
    if (shareCapture.current) return;
    shareCapture.current = true;
    setShareBusy(true);
    setShowShareSetup(false);
    setShowSourcePicker(false);
    const { includeAudio, quality: selectedQuality } = pendingShareOptions.current;
    setQuality(selectedQuality);
    const config = QUALITY[selectedQuality];
    let routedScreenAudio = false;
    let capturedAudio: MediaStream | null = null;
    let capturedDisplay: MediaStream | null = null;
    try {
      if (window.tumacordDesktop && includeAudio) {
        const prepared = await window.tumacordDesktop.prepareScreenAudio();
        if (prepared.ok && prepared.deviceId) {
          routedScreenAudio = true;
          screenAudioRecovery.current = {
            enabled: true,
            deviceName: prepared.deviceName || 'Tumacord Stream Audio',
            attempts: 0,
          };
          capturedAudio = await captureIsolatedScreenAudio(prepared.deviceName || 'Tumacord Stream Audio');
        } else {
          throw new Error(prepared.error ?? 'PipeWire indisponível');
        }
      }
      // A fonte já foi escolhida pelo usuário. chromeMediaSourceId captura
      // diretamente essa escolha e não abre outro portal do PipeWire.
      capturedDisplay = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: config.width,
            maxHeight: config.height,
            maxFrameRate: config.frameRate,
          },
        } as unknown as MediaTrackConstraints,
      });
      const stream = new MediaStream([
        ...capturedDisplay.getVideoTracks(),
        ...(capturedAudio?.getAudioTracks() ?? []),
      ]);
      if (!includeAudio) screenAudioRecovery.current = { enabled: false, deviceName: '', attempts: 0 };
      await attachStream('screen', stream, selectedQuality);
    } catch (error) {
      capturedDisplay?.getTracks().forEach((track) => track.stop());
      capturedAudio?.getTracks().forEach((track) => track.stop());
      if (routedScreenAudio) await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
      screenAudioRecovery.current = { enabled: false, deviceName: '', attempts: 0 };
      onError(`Não consegui iniciar a transmissão${includeAudio ? ' com áudio isolado' : ''}: ${error instanceof Error ? error.message : 'captura indisponível'}`);
      if (desktopSources.length > 1) setShowSourcePicker(true);
      else setShowShareSetup(true);
    } finally {
      shareCapture.current = false;
      if (!shareListing.current) setShareBusy(false);
    }
  }

  const changeQuality = async (next: StreamQuality) => {
    setQuality(next);
    const stream = localStreams.current.get('screen');
    if (!stream) return;
    const config = QUALITY[next];
    await stream.getVideoTracks()[0]?.applyConstraints({ width: { ideal: config.width, max: config.width }, height: { ideal: config.height, max: config.height }, frameRate: { ideal: config.frameRate, max: config.frameRate } }).catch(() => undefined);
    for (const state of peers.current.values()) {
      const videoTrack = stream.getVideoTracks()[0];
      const sender = state.pc.getSenders().find((candidate) => candidate.track === videoTrack);
      if (!sender) continue;
      await tuneScreenSender(sender, config);
      state.screenBitrate = config.bitrate;
      state.healthyScreenSamples = 0;
      state.lastScreenBytes = undefined;
      state.lastScreenPackets = undefined;
      state.stalledScreenSamples = 0;
    }
  };

  return {
    channelId, members, muted, deafened, cameraOn, screenOn, remoteMedia,
    peerHealth, recoverPeer, recoverAllPeers,
    quality, setQuality: changeQuality, join, leave, toggleMute, toggleDeafen, toggleCamera,
    requestScreenShare, desktopSources, showSourcePicker, setShowSourcePicker,
    showShareSetup, setShowShareSetup, shareBusy, prepareScreenShare, shareDesktopSource,
    localCamera: localStreams.current.get('camera'),
    localScreen: localStreams.current.get('screen'),
    user,
  };
}
