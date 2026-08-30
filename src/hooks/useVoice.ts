import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorkletSource from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw';
import gtcrnWasmPath from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import type { PublicUser, StreamMeta, VoiceState } from '../../shared/types';
import type { DevicePreferences } from './useDevices';
import { playSound } from '../lib/sound';

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
  remoteStreams: Map<string, MediaStream>;
}

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

async function tuneScreenSender(sender: RTCRtpSender, config: (typeof QUALITY)[StreamQuality]): Promise<void> {
  const parameters = sender.getParameters();
  const current = parameters.encodings?.[0] ?? {};
  parameters.encodings = [{
    ...current,
    maxBitrate: config.bitrate,
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
  for (let attempt = 0; attempt < 8 && !device; attempt += 1) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    device = devices.find((candidate) => candidate.kind === 'audioinput' && (
      normalizedDeviceName(candidate.label).includes(wanted)
      || normalizedDeviceName(candidate.label).includes('tumacordstreamaudio')
    ));
    if (!device) await new Promise((resolve) => window.setTimeout(resolve, 100));
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
  const [cameraOn, setCameraOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [quality, setQuality] = useState<StreamQuality>('balanced');
  const [remoteMedia, setRemoteMedia] = useState<RemoteMedia[]>([]);
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const peers = useRef(new Map<string, PeerConnectionState>());
  const localStreams = useRef(new Map<'microphone' | 'camera' | 'screen', MediaStream>());
  const streamMeta = useRef(new Map<string, StreamMeta['kind']>());
  const selfId = useRef('');
  const handoffStarted = useRef(false);
  const speakingRef = useRef(false);
  const speakingMonitor = useRef<{ context: AudioContext; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; timer: number } | null>(null);
  const microphoneProcessing = useRef<MicrophoneProcessing | null>(null);

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

  const sendStreamMeta = useCallback((target: string, stream: MediaStream, kind: StreamMeta['kind']) => {
    socket?.emit('rtc:stream-meta', { target, meta: { streamId: stream.id, kind } });
  }, [socket]);

  const addLocalStreams = useCallback((target: string, pc: RTCPeerConnection) => {
    for (const [kind, stream] of localStreams.current) {
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (kind === 'microphone') void tuneVoiceSender(sender);
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
    const state: PeerConnectionState = { pc, user: remoteUser, makingOffer: false, ignoreOffer: false, remoteStreams: new Map() };
    peers.current.set(peerId, state);
    addLocalStreams(peerId, pc);
    pc.onicecandidate = ({ candidate }) => candidate && socket?.emit('rtc:ice', { target: peerId, candidate });
    pc.ontrack = (event) => {
      for (const stream of event.streams) state.remoteStreams.set(stream.id, stream);
      event.track.onunmute = refreshRemote;
      event.track.onended = () => {
        for (const [streamId, stream] of state.remoteStreams) {
          if (stream.getTracks().every((track) => track.readyState === 'ended')) state.remoteStreams.delete(streamId);
        }
        refreshRemote();
      };
      refreshRemote();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected') {
        // Wi‑Fi/ZeroTier can briefly lose a route. Give ICE a chance to heal
        // before tearing down the peer and interrupting the live.
        window.setTimeout(async () => {
          if (pc.connectionState !== 'disconnected' || state.makingOffer || pc.signalingState !== 'stable') return;
          try {
            state.makingOffer = true;
            pc.restartIce();
            await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
            socket?.emit('rtc:offer', { target: peerId, sdp: pc.localDescription });
          } catch {
            // The normal connection-state handler below will clean up if it fails.
          } finally {
            state.makingOffer = false;
          }
        }, 1400);
      }
      if (['failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        peers.current.delete(peerId);
        refreshRemote();
      }
    };
    return state;
  }, [addLocalStreams, refreshRemote, socket]);

  const negotiate = useCallback(async (peerId: string) => {
    const state = peers.current.get(peerId);
    if (!state || state.pc.signalingState !== 'stable') return;
    try {
      state.makingOffer = true;
      await state.pc.setLocalDescription(await state.pc.createOffer());
      socket?.emit('rtc:offer', { target: peerId, sdp: state.pc.localDescription });
    } finally {
      state.makingOffer = false;
    }
  }, [socket]);

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
      setScreenOn(false);
      setShowSourcePicker(false);
      publishState({ screen: false });
      await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
    }
    playSound('stream');
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
        }
      }
      void negotiate(peerId);
    }
    stream.getTracks().forEach((track) => {
      if (kind === 'screen' && track.kind === 'video' && 'contentHint' in track) track.contentHint = 'detail';
      track.onended = () => void stopStream(kind);
    });
    if (kind === 'camera') {
      setCameraOn(true);
      publishState({ camera: true });
    } else {
      setScreenOn(true);
      setShowSourcePicker(false);
      publishState({ screen: true });
    }
    playSound('stream');
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
    newTrack.enabled = !muted;
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
  }, [muted, onDevicesChanged, onError, preferences.microphoneId, preferences.noiseSuppression, startSpeakingMonitor]);

  const join = useCallback(async (nextChannelId: string) => {
    if (!socket) return;
    try {
      await ensureMicrophone();
    } catch {
      setMuted(true);
      onError('Microfone indisponível. Você entrou mutado; confira as permissões nas configurações.');
    }
    if (channelRef.current) {
      peers.current.forEach(({ pc }) => pc.close());
      peers.current.clear();
      setRemoteMedia([]);
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
      publishState({ muted, deafened, camera: cameraOn, screen: screenOn, speaking: false });
      playSound('join');
    });
  }, [cameraOn, createPeer, deafened, ensureMicrophone, muted, negotiate, onError, publishState, screenOn, socket, startSpeakingMonitor]);

  const leave = useCallback(() => {
    const wasInCall = Boolean(channelRef.current);
    stopSpeakingMonitor();
    socket?.emit('voice:leave');
    peers.current.forEach(({ pc }) => pc.close());
    peers.current.clear();
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
    setCameraOn(false);
    setScreenOn(false);
    if (wasInCall) playSound('leave');
  }, [socket, stopSpeakingMonitor]);

  useEffect(() => {
    if (!socket) return;
    const onMembers = (next: VoiceState[]) => {
      membersRef.current = next;
      setMembers(next);
    };
    const onPeerLeft = (peerId: string) => {
      peers.current.get(peerId)?.pc.close();
      peers.current.delete(peerId);
      refreshRemote();
      playSound('leave');
    };
    const onPeerJoined = (peer: VoiceState | undefined) => {
      if (!peer || peer.socketId === selfId.current || !channelRef.current) return;
      createPeer(peer.socketId, peer);
      // O estado vem das trilhas reais, não de um valor React possivelmente
      // antigo durante uma reconexão rápida.
      publishState({
        muted,
        deafened,
        camera: localStreams.current.has('camera'),
        screen: localStreams.current.has('screen'),
        speaking: speakingRef.current,
      });
    };
    const onOffer = async ({ from, user: remoteUser, sdp }: { from: string; user: PublicUser; sdp: RTCSessionDescriptionInit }) => {
      const state = createPeer(from, remoteUser);
      const collision = state.makingOffer || state.pc.signalingState !== 'stable';
      const polite = selfId.current.localeCompare(from) > 0;
      state.ignoreOffer = !polite && collision;
      if (state.ignoreOffer) return;
      if (collision) await state.pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined);
      await state.pc.setRemoteDescription(sdp);
      await state.pc.setLocalDescription(await state.pc.createAnswer());
      socket.emit('rtc:answer', { target: from, sdp: state.pc.localDescription });
    };
    const onAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const state = peers.current.get(from);
      if (state && state.pc.signalingState === 'have-local-offer') await state.pc.setRemoteDescription(sdp);
    };
    const onIce = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const state = peers.current.get(from);
      if (!state || state.ignoreOffer) return;
      await state.pc.addIceCandidate(candidate).catch(() => undefined);
    };
    const onMeta = ({ from, meta }: { from: string; meta: StreamMeta }) => {
      if (!meta) return;
      streamMeta.current.set(`${from}:${meta.streamId}`, meta.kind);
      refreshRemote();
    };
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
      socket.off('voice:host-handoff', onHandoff);
      socket.off('disconnect', onDisconnect);
    };
  }, [createPeer, deafened, dynamicHosting, muted, onHostHandoff, publishState, refreshRemote, socket]);

  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // Limpa captura somente quando o hook realmente desmonta. Trocar do host
  // P2P antigo para o novo troca o socket, mas deve preservar a tela/câmera.
  useEffect(() => () => leaveRef.current(), []);

  useEffect(() => {
    if (!socket) return;
    const rejoinAfterReconnect = () => {
      const activeChannel = channelRef.current;
      if (activeChannel) void join(activeChannel);
    };
    socket.on('connect', rejoinAfterReconnect);
    if (socket.connected && channelRef.current) void join(channelRef.current);
    return () => { socket.off('connect', rejoinAfterReconnect); };
  }, [join, socket]);

  useEffect(() => {
    if (!socket || !channelId) return;
    const publishLatency = async () => {
      const samples: number[] = [];
      for (const state of peers.current.values()) {
        const report = await state.pc.getStats().catch(() => null);
        report?.forEach((stat) => {
          if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && typeof stat.currentRoundTripTime === 'number') samples.push(stat.currentRoundTripTime * 1000);
        });
      }
      const average = samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 9999;
      socket.emit('voice:latency', average);
    };
    void publishLatency();
    const timer = window.setInterval(() => void publishLatency(), 2000);
    return () => window.clearInterval(timer);
  }, [channelId, socket]);

  useEffect(() => {
    if (!channelRef.current || !localStreams.current.has('microphone')) return;
    void ensureMicrophone().catch(() => onError('Não foi possível atualizar o processamento do microfone.'));
  }, [ensureMicrophone, onError]);

  const toggleMute = async () => {
    const next = !muted;
    if (!next && !localStreams.current.has('microphone')) await ensureMicrophone().catch(() => onError('Não consegui abrir o microfone.'));
    localStreams.current.get('microphone')?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
    publishState({ muted: next, speaking: false });
    if (next && speakingRef.current) {
      speakingRef.current = false;
    }
    playSound(next ? 'mute' : 'unmute');
  };

  const toggleDeafen = () => {
    const next = !deafened;
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
    if (window.tumacordDesktop) {
      const sources = await window.tumacordDesktop.getSources();
      setDesktopSources(sources);
      setShowSourcePicker(true);
      return;
    }
    try {
      const config = QUALITY[quality];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: config.width, max: config.width }, height: { ideal: config.height, max: config.height }, frameRate: { ideal: config.frameRate, max: config.frameRate } },
        audio: true,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
        windowAudio: 'window',
      } as DisplayMediaStreamOptions);
      await attachStream('screen', stream, quality);
    } catch (error) {
      if ((error as DOMException).name !== 'NotAllowedError') onError('Não consegui compartilhar a tela.');
    }
  };

  const shareDesktopSource = async (sourceId: string, includeAudio: boolean, selectedQuality: StreamQuality, _sourceKind: DesktopSource['kind']) => {
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
          capturedAudio = await captureIsolatedScreenAudio(prepared.deviceName || 'Tumacord Stream Audio');
        } else {
          throw new Error(prepared.error ?? 'PipeWire indisponível');
        }
      }
      // O vídeo e o áudio são capturados separadamente no Linux. Assim o
      // portal só cuida da imagem, enquanto o som vem da fonte virtual já
      // filtrada que exclui Tumacord/Discord.
      if (window.tumacordDesktop) window.tumacordDesktop.selectDesktopSource(sourceId, false);
      capturedDisplay = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: config.width, max: config.width }, height: { ideal: config.height, max: config.height }, frameRate: { ideal: config.frameRate, max: config.frameRate } },
        audio: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'exclude',
      } as DisplayMediaStreamOptions);
      const stream = new MediaStream([
        ...capturedDisplay.getVideoTracks(),
        ...(capturedAudio?.getAudioTracks() ?? []),
      ]);
      await attachStream('screen', stream, selectedQuality);
    } catch (error) {
      capturedDisplay?.getTracks().forEach((track) => track.stop());
      capturedAudio?.getTracks().forEach((track) => track.stop());
      if (routedScreenAudio) await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
      onError(`Não consegui iniciar a transmissão${includeAudio ? ' com áudio isolado' : ''}: ${error instanceof Error ? error.message : 'captura indisponível'}`);
    }
  };

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
    }
  };

  return {
    channelId, members, muted, deafened, cameraOn, screenOn, remoteMedia,
    quality, setQuality: changeQuality, join, leave, toggleMute, toggleDeafen, toggleCamera,
    requestScreenShare, desktopSources, showSourcePicker, setShowSourcePicker,
    shareDesktopSource,
    localCamera: localStreams.current.get('camera'),
    localScreen: localStreams.current.get('screen'),
    user,
  };
}
