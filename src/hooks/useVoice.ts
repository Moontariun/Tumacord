import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { GtcrnWorkletNode } from '@sapphi-red/web-noise-suppressor';
import gtcrnWorkletSource from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?raw';
import gtcrnWasmPath from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import type { PublicUser, StreamMeta, VoiceState } from '../../shared/types';
import type { DevicePreferences } from './useDevices';
import { playSound } from '../lib/sound';
import { resumeSharedAudio, sharedAudioContext } from '../lib/audioBus';
import { isPolitePeer, planPeerRecovery, shouldInitiateRecovery, shouldQueueIceCandidate, shouldRecoverMutedAudio, stallSignalIsTrustworthy, RECOVERY_GRACE_MS, type RecoverySeverity } from '../lib/rtcPolicy';
import { activePathMetrics, adaptEncoderScale, adaptScreenBitrate, inboundAudioMetrics, inboundVideoMetrics, median, outboundVideoMetrics, shouldApplyBitrateChange, shouldApplyScaleChange, type RtcStatLike } from '../lib/networkQuality';
import { desktopScreenCaptureConstraints, maximumAdaptiveScreenScale, parseStreamQuality, SCREEN_QUALITIES, screenBitrateHints, screenCaptureConstraints, screenQualityOptions, screenScaleForQuality, type ScreenQualityConfig, type StreamQuality } from '../lib/screenQuality';
import { applyVideoBitrateHints } from '../lib/sdp';
import { classifyRemoteStream, prunePeerStreamMetadata, streamMetadataKey } from '../lib/streamMeta';
import { currentNetworkPreferences, iceServersFor } from '../lib/networkPreferences';
import { capturedDeviceIsGone, defaultAudioInputSignature, describeMicrophoneFault, faultFromLevel, microphoneIdentityOf, planMicrophoneRecovery, type MicrophoneFault, type MicrophoneIdentity } from '../lib/microphoneHealth';
import { readDirectReport } from '../lib/directLink';

export type { StreamQuality } from '../lib/screenQuality';

const QUALITY = SCREEN_QUALITIES;
const QUALITY_STORAGE_KEY = 'tumacord.stream-quality';

interface PeerConnectionState {
  pc: RTCPeerConnection;
  user?: PublicUser;
  makingOffer: boolean;
  ignoreOffer: boolean;
  needsNegotiation: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  recoveryAttempts: number;
  connectedSince: number;
  screenSenderSince: number;
  screenWarmupHeld: boolean;
  recoveryTimer?: number;
  escalationTimer?: number;
  negotiationRecoveryTimer?: number;
  mutedAudioTimers: Map<string, number>;
  screenBitrate?: number;
  healthyScreenSamples: number;
  screenBaseScale: number;
  screenScale: number;
  healthyEncoderSamples: number;
  encoderPressureSamples: number;
  lastFramesEncoded?: number;
  lastTotalEncodeTime?: number;
  receiverFrozenUntil: number;
  lastScreenBytes?: number;
  lastScreenPackets?: number;
  rateBytes?: number;
  rateAt?: number;
  lastScaleChangeAt: number;
  stalledScreenSamples: number;
  lastScreenRecoveryAt: number;
  inboundVoice: Map<string, { packets?: number; stalled: number }>;
  inboundScreen: Map<string, { bytes?: number; packets?: number; framesReceived?: number; framesDecoded?: number; freezeCount?: number; freezeDuration?: number; stalled: number; since: number }>;
  lastScreenDecodeRecoveryAt: number;
  lastVoiceRecoveryAt: number;
  remoteStreams: Map<string, MediaStream>;
  screenTuning: Promise<void>;
  screenTuningPending: boolean;
}

function closePeerState(state: PeerConnectionState): void {
  if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
  if (state.escalationTimer) window.clearTimeout(state.escalationTimer);
  if (state.negotiationRecoveryTimer) window.clearTimeout(state.negotiationRecoveryTimer);
  for (const timer of state.mutedAudioTimers.values()) window.clearTimeout(timer);
  state.mutedAudioTimers.clear();
  state.screenTuningPending = false;
  state.pc.onicecandidate = null;
  state.pc.onnegotiationneeded = null;
  state.pc.ontrack = null;
  state.pc.onconnectionstatechange = null;
  for (const receiver of state.pc.getReceivers()) receiver.track?.stop();
  state.remoteStreams.clear();
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

export const qualityOptions = screenQualityOptions;

// O Chromium costuma negociar Opus com bitrate conservador. Um teto de 96 kbps
// mantém a voz limpa sem transformar a malha P2P em uma transmissão pesada.
async function tuneVoiceSender(sender: RTCRtpSender): Promise<void> {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate: 96_000, dtx: false }));
  await sender.setParameters(parameters).catch(() => undefined);
}

// Perfis de 60 FPS existem para jogo e movimento; os de 30 FPS ou menos são
// escolhidos para ler tela, código e planilha, onde nitidez vale mais que
// fluidez. O par contentHint/degradationPreference precisa contar a mesma
// história, senão o encoder derruba a resolução e a live fica borrada.
function screenContentHint(config: ScreenQualityConfig): 'motion' | 'detail' {
  return config.frameRate >= 60 ? 'motion' : 'detail';
}

function screenDegradationPreference(config: ScreenQualityConfig): 'maintain-framerate' | 'maintain-resolution' {
  return config.frameRate >= 60 ? 'maintain-framerate' : 'maintain-resolution';
}

// A dica de bitrate viaja na seção de vídeo inteira. Sem um teto próprio a
// câmera passaria a disputar a banda reservada para a transmissão.
async function tuneCameraSender(sender: RTCRtpSender): Promise<void> {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, maxBitrate: 2_500_000, maxFramerate: 30 }));
  await sender.setParameters(parameters).catch(() => undefined);
}

// O Chromium recusa editar codecs na própria descrição local, mas configura o
// encoder a partir do que o outro lado pede. Por isso as dicas de bitrate
// entram na descrição remota: é ela que define com quanto a nossa live abre.
async function setTunedRemoteDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit, hints?: ReturnType<typeof screenBitrateHints>): Promise<void> {
  if (hints && description.sdp) {
    try {
      await pc.setRemoteDescription({ type: description.type, sdp: applyVideoBitrateHints(description.sdp, hints) });
      return;
    } catch {
      // SDP recusada: a live continua, apenas com a rampa padrão do navegador.
    }
  }
  await pc.setRemoteDescription(description);
}

function currentScreenHints(active: boolean, quality: StreamQuality): ReturnType<typeof screenBitrateHints> | undefined {
  return active ? screenBitrateHints(QUALITY[quality]) : undefined;
}

async function tuneScreenSender(sender: RTCRtpSender, config: ScreenQualityConfig, maxBitrate = config.bitrate, scale = 1, holdResolution = false): Promise<boolean> {
  const parameters = sender.getParameters();
  const current = parameters.encodings?.[0] ?? {};
  parameters.encodings = [{
    ...current,
    maxBitrate,
    maxFramerate: config.frameRate,
    scaleResolutionDownBy: Math.min(4, Math.max(1, scale)),
    priority: 'high',
    networkPriority: 'high',
  } as RTCRtpEncodingParameters];
  // Nos primeiros segundos o encoder ainda não sabe quanta banda tem. Segurar
  // a resolução nessa janela é o que faz a live abrir nítida; depois dela o
  // perfil volta a mandar, então jogo em 60 FPS continua fluido.
  (parameters as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = holdResolution ? 'maintain-resolution' : screenDegradationPreference(config);
  try {
    await sender.setParameters(parameters);
    return true;
  } catch {
    return false;
  }
}

const SCREEN_WARMUP_MS = 9_000;

async function tuneScreenPeer(state: PeerConnectionState, sender: RTCRtpSender, config: ScreenQualityConfig, maxBitrate = config.bitrate, scale = 1, holdResolution = false): Promise<boolean> {
  let applied = false;
  const operation = state.screenTuning.catch(() => undefined).then(async () => {
    applied = await tuneScreenSender(sender, config, maxBitrate, scale, holdResolution);
  });
  state.screenTuning = operation.then(() => undefined, () => undefined);
  await operation;
  return applied;
}

function savedStreamQuality(): StreamQuality {
  try { return parseStreamQuality(localStorage.getItem(QUALITY_STORAGE_KEY)); }
  catch { return 'source'; }
}

function persistStreamQuality(quality: StreamQuality): void {
  try { localStorage.setItem(QUALITY_STORAGE_KEY, quality); }
  catch { /* armazenamento indisponível; a troca ainda vale nesta sessão */ }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface MicrophoneProcessing {
  rawStream: MediaStream;
  outputStream: MediaStream;
  deviceId: string;
  // O que a preferência pedia e o que o navegador realmente abriu são coisas
  // diferentes: com "Padrão do sistema" a preferência é vazia e só a
  // identidade resolvida revela para qual aparelho a captura foi.
  identity: MicrophoneIdentity;
  defaultSignature: string;
  neural: boolean;
  noiseSuppression: boolean;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  highPass?: BiquadFilterNode;
  suppressor?: GtcrnWorkletNode;
  compressor?: DynamicsCompressorNode;
  destination?: MediaStreamAudioDestinationNode;
  inputMeter?: AnalyserNode;
  outputMeter?: AnalyserNode;
}

function analyserLevel(analyser: AnalyserNode | undefined): number {
  if (!analyser) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
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
    // Sem um gesto do usuário o Chromium mantém o contexto suspenso e o
    // worklet não processa nada: a faixa continua "live" e habilitada, mas só
    // silêncio chega do outro lado. Era isso que fazia o microfone não sair ao
    // abrir o aplicativo e voltar sozinho depois de mexer nas configurações.
    await Promise.race([context.resume(), new Promise((resolve) => window.setTimeout(resolve, 400))]);
    if (context.state !== 'running') throw new Error('O processamento do microfone não iniciou nesta sessão.');
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
    // Comparar a energia antes e depois do filtro é a única forma de perceber
    // que o worklet WASM travou: a faixa continua "live" e habilitada, mas só
    // silêncio chega do outro lado.
    const inputMeter = context.createAnalyser();
    const outputMeter = context.createAnalyser();
    inputMeter.fftSize = 256;
    outputMeter.fftSize = 256;
    source.connect(inputMeter);
    compressor.connect(outputMeter);
    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error('O filtro neural não criou uma faixa de áudio.');
    if ('contentHint' in outputTrack) outputTrack.contentHint = 'speech';
    const outputStream = new MediaStream([outputTrack]);
    return { rawStream, outputStream, deviceId, identity: { deviceId: '', groupId: '' }, defaultSignature: '', neural: true, noiseSuppression: true, context, source, highPass, suppressor, compressor, destination, inputMeter, outputMeter };
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
  processing.inputMeter?.disconnect();
  processing.outputMeter?.disconnect();
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
  const [quality, setQuality] = useState<StreamQuality>(savedStreamQuality);
  const qualityRef = useRef<StreamQuality>(quality);
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
  const microphoneRecoveryTimer = useRef<number | undefined>(undefined);
  const microphoneCaptureGeneration = useRef(0);
  const neuralFallback = useRef(false);
  const microphoneFallbackNotice = useRef(false);
  const microphoneSignal = useRef({ lastSignalAt: 0, warned: false });
  const microphoneFault = useRef<{ kind: MicrophoneFault; since: number; recaptures: number; lastRecaptureAt: number; warned: boolean }>({ kind: 'none', since: 0, recaptures: 0, lastRecaptureAt: 0, warned: false });
  const ensureMicrophoneRef = useRef<(options?: { force?: boolean }) => Promise<MediaStream>>(async () => { throw new Error('Microfone ainda não inicializado.'); });
  const negotiateRef = useRef<(peerId: string, iceRestart?: boolean) => Promise<void>>(async () => undefined);
  const recoverPeerRef = useRef<(peerId: string, reason?: string, notifyRemote?: boolean, severity?: RecoverySeverity | 'force') => void>(() => undefined);
  const recoveryCooldown = useRef(new Map<string, number>());
  const recoveryAttemptCount = useRef(new Map<string, number>());
  const missingScreenSince = useRef(new Map<string, number>());
  const missingVoiceSince = useRef(new Map<string, number>());
  const screenAudioRecovery = useRef<{ enabled: boolean; deviceName: string; attempts: number; notified?: boolean; timer?: number }>({ enabled: false, deviceName: '', attempts: 0 });
  const pendingShareOptions = useRef<{ includeAudio: boolean; quality: StreamQuality }>({ includeAudio: true, quality: 'balanced' });
  const shareListing = useRef(false);
  const shareCapture = useRef(false);
  const screenAudioEnabled = useRef(false);
  const screenAudioHealthCheck = useRef(false);
  const screenAudioEndedRef = useRef<(endedTrack: MediaStreamTrack) => void>(() => undefined);
  const activeCameraDeviceId = useRef('');
  const cameraSwitching = useRef(false);
  const mediaCaptureGeneration = useRef({ camera: 0, screen: 0 });
  const joinGeneration = useRef(0);
  const qualityChangeGeneration = useRef(0);
  const preferencesRef = useRef(preferences);
  const [, retryCameraSwitch] = useState(0);
  preferencesRef.current = preferences;

  // Uma falha do microfone é registrada com o instante em que começou. O que
  // fazer com ela — esperar, recapturar ou avisar — é decidido por
  // `planMicrophoneRecovery`, no monitor mais abaixo.
  const noteMicrophoneFault = useCallback((kind: MicrophoneFault) => {
    const state = microphoneFault.current;
    if (kind === 'none') {
      if (state.kind !== 'none') microphoneFault.current = { ...state, kind: 'none', since: 0 };
      return;
    }
    if (state.kind === kind) return;
    microphoneFault.current = { ...state, kind, since: Date.now() };
  }, []);

  const publishState = useCallback((patch: Record<string, boolean>) => socket?.emit('voice:state', patch), [socket]);

  const stopSpeakingMonitor = useCallback(() => {
    const monitor = speakingMonitor.current;
    if (!monitor) return;
    window.clearInterval(monitor.timer);
    monitor.source.disconnect();
    monitor.analyser.disconnect();
    speakingMonitor.current = null;
    if (speakingRef.current) {
      speakingRef.current = false;
      publishState({ speaking: false });
    }
  }, [publishState]);

  const startSpeakingMonitor = useCallback((stream: MediaStream) => {
    stopSpeakingMonitor();
    if (typeof window === 'undefined') return;
    // O monitor divide o mesmo AudioContext do restante do aplicativo: um
    // contexto por finalidade era o que estourava o limite do Chromium.
    const context = sharedAudioContext();
    const track = stream.getAudioTracks()[0];
    if (!context || !track) return;
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
      if (context.state !== 'running') return;
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
    void resumeSharedAudio();
  }, [publishState, stopSpeakingMonitor]);

  const refreshRemote = useCallback(() => {
    const media: RemoteMedia[] = [];
    for (const [peerId, peer] of peers.current) {
      const remoteMember = membersRef.current.find((member) => member.socketId === peerId);
      const liveVideoStreamCount = [...peer.remoteStreams.values()].filter((stream) => stream.getVideoTracks().some((track) => track.readyState === 'live')).length;
      for (const stream of peer.remoteStreams.values()) {
        if (!stream.getTracks().some((track) => track.readyState !== 'ended')) continue;
        const meta = streamMeta.current.get(streamMetadataKey(peerId, stream.id));
        // Sem dono identificado, o volume individual cai no padrão e o
        // controle da barra lateral parece não fazer efeito.
        media.push({ peerId, user: peer.user ?? remoteMember, stream, kind: classifyRemoteStream(meta, stream, remoteMember, liveVideoStreamCount) });
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

  const addLocalStreams = useCallback((target: string, state: PeerConnectionState) => {
    for (const [kind, stream] of localStreams.current) {
      for (const track of stream.getTracks()) {
        const sender = state.pc.addTrack(track, stream);
        if (kind === 'microphone') void tuneVoiceSender(sender);
        if (kind === 'camera' && track.kind === 'video') void tuneCameraSender(sender);
        if (kind === 'screen' && track.kind === 'video') {
          const config = QUALITY[qualityRef.current];
          const baseScale = screenScaleForQuality(track.getSettings(), config);
          state.screenSenderSince = Date.now();
          state.screenWarmupHeld = true;
          state.screenBaseScale = baseScale;
          state.screenScale = baseScale;
          state.screenTuningPending = true;
          void tuneScreenPeer(state, sender, config, config.bitrate, baseScale, true).then((applied) => {
            if (peers.current.get(target) !== state) return;
            state.screenTuningPending = !applied;
            if (!applied) onError('A transmissão iniciou, mas o navegador recusou o perfil de qualidade deste enlace.');
          });
        }
      }
      if (kind === 'camera' || kind === 'screen') sendStreamMeta(target, stream, kind);
    }
  }, [onError, sendStreamMeta]);

  const createPeer = useCallback((peerId: string, remoteUser?: PublicUser) => {
    const found = peers.current.get(peerId);
    if (found) {
      if (remoteUser) found.user = remoteUser;
      return found;
    }
    // Até a 0.7.8 a lista de servidores ICE era vazia: o navegador só oferecia
    // o endereço da própria interface, e por isso a call exigia que todo mundo
    // estivesse na mesma rede — na prática, no ZeroTier. Com STUN o Chromium
    // aprende o endereço público, gera candidato refletido e fura o NAT
    // sozinho; onde há IPv6, ele ainda oferece o endereço global, que não tem
    // NAT no meio. A mídia continua cifrada de ponta a ponta por DTLS-SRTP e
    // não passa por nenhum servidor: o STUN só informa o endereço.
    const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: iceServersFor(currentNetworkPreferences()), iceCandidatePoolSize: 4 });
    const currentScreenTrack = localStreams.current.get('screen')?.getVideoTracks().find((track) => track.readyState === 'live');
    const screenBaseScale = currentScreenTrack ? screenScaleForQuality(currentScreenTrack.getSettings(), QUALITY[qualityRef.current]) : 1;
    const state: PeerConnectionState = {
      pc,
      user: remoteUser,
      makingOffer: false,
      ignoreOffer: false,
      needsNegotiation: false,
      pendingCandidates: [],
      recoveryAttempts: 0,
      connectedSince: 0,
      screenSenderSince: localStreams.current.has('screen') ? Date.now() : 0,
      screenWarmupHeld: localStreams.current.has('screen'),
      lastScaleChangeAt: 0,
      mutedAudioTimers: new Map(),
      screenBitrate: localStreams.current.has('screen') ? QUALITY[qualityRef.current].bitrate : undefined,
      healthyScreenSamples: 0,
      screenBaseScale,
      screenScale: screenBaseScale,
      healthyEncoderSamples: 0,
      encoderPressureSamples: 0,
      receiverFrozenUntil: 0,
      stalledScreenSamples: 0,
      lastScreenRecoveryAt: 0,
      inboundVoice: new Map(),
      inboundScreen: new Map(),
      lastScreenDecodeRecoveryAt: 0,
      lastVoiceRecoveryAt: 0,
      remoteStreams: new Map(),
      screenTuning: Promise.resolve(),
      screenTuningPending: localStreams.current.has('screen'),
    };
    peers.current.set(peerId, state);
    updatePeerHealth(peerId, 'connecting');
    addLocalStreams(peerId, state);
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
        // Uma faixa fica "muted" em toda renegociação normal. Reconstruir o
        // enlace por isso depois de quatro segundos era o gatilho mais comum
        // de tela preta em sequência.
        state.mutedAudioTimers.set(event.track.id, window.setTimeout(() => {
          state.mutedAudioTimers.delete(event.track.id);
          if (peers.current.get(peerId) !== state || !event.track.muted) return;
          if (state.pc.connectionState !== 'connected') return;
          const member = membersRef.current.find((candidate) => candidate.socketId === peerId);
          const meta = stream ? streamMeta.current.get(streamMetadataKey(peerId, stream.id)) : undefined;
          const screen = meta === 'screen' || Boolean(stream?.getVideoTracks().length && member?.screen);
          if (shouldRecoverMutedAudio({
            trackMuted: event.track.muted,
            remoteMuted: member?.muted ?? true,
            screen,
            screenAudioExpected: member?.screenAudio ?? false,
          })) recoverPeerRef.current(peerId, screen ? 'áudio da live interrompido' : 'áudio da call interrompido', true, 'soft');
        }, 12_000));
      };
      event.track.onunmute = () => {
        clearMutedAudioTimer();
        updatePeerHealth(peerId, 'connected');
        refreshRemote();
      };
      event.track.onended = () => {
        clearMutedAudioTimer();
        if (peers.current.get(peerId) !== state) return;
        for (const [streamId, stream] of state.remoteStreams) {
          if (stream.getTracks().every((track) => track.readyState === 'ended')) {
            state.remoteStreams.delete(streamId);
            streamMeta.current.delete(streamMetadataKey(peerId, streamId));
          }
        }
        refreshRemote();
      };
      refreshRemote();
    };
    pc.onconnectionstatechange = () => {
      if (peers.current.get(peerId) !== state) return;
      if (pc.connectionState === 'connected') {
        if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
        if (state.escalationTimer) window.clearTimeout(state.escalationTimer);
        state.recoveryTimer = undefined;
        state.escalationTimer = undefined;
        state.recoveryAttempts = 0;
        state.connectedSince = Date.now();
        updatePeerHealth(peerId, 'connected');
        if (state.screenTuningPending) {
          const screenTrack = localStreams.current.get('screen')?.getVideoTracks().find((track) => track.readyState === 'live');
          const sender = screenTrack ? pc.getSenders().find((candidate) => candidate.track === screenTrack) : undefined;
          if (screenTrack && sender) {
            const config = QUALITY[qualityRef.current];
            const baseScale = screenScaleForQuality(screenTrack.getSettings(), config);
            void tuneScreenPeer(state, sender, config, state.screenBitrate ?? config.bitrate, Math.max(baseScale, state.screenScale), Date.now() - state.screenSenderSince < SCREEN_WARMUP_MS).then((applied) => {
              if (peers.current.get(peerId) === state) state.screenTuningPending = !applied;
            });
          }
        }
        return;
      }
      if (pc.connectionState === 'connecting' || pc.connectionState === 'new') {
        updatePeerHealth(peerId, state.recoveryAttempts ? 'recovering' : 'connecting');
        return;
      }
      state.connectedSince = 0;
      if (pc.connectionState === 'disconnected') {
        updatePeerHealth(peerId, 'recovering');
        // "disconnected" costuma ser um soluço de rede de poucos segundos. Um
        // ICE restart preserva o decodificador; só depois de dez segundos sem
        // voltar vale reconstruir o enlace e piscar a tela de quem assiste.
        if (state.recoveryTimer) window.clearTimeout(state.recoveryTimer);
        state.recoveryTimer = window.setTimeout(() => {
          state.recoveryTimer = undefined;
          if (peers.current.get(peerId) !== state || pc.connectionState !== 'disconnected') return;
          void negotiateRef.current(peerId, true);
          if (state.escalationTimer) window.clearTimeout(state.escalationTimer);
          state.escalationTimer = window.setTimeout(() => {
            state.escalationTimer = undefined;
            if (peers.current.get(peerId) === state && pc.connectionState !== 'connected') recoverPeerRef.current(peerId, 'conexão interrompida', true, 'hard');
          }, 10_000);
        }, 2_000);
        return;
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        updatePeerHealth(peerId, 'failed');
        recoverPeerRef.current(peerId, `estado ${pc.connectionState}`, true, 'hard');
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
    let recoverAfterFailure = false;
    try {
      state.makingOffer = true;
      state.needsNegotiation = false;
      if (iceRestart) state.pc.restartIce();
      await state.pc.setLocalDescription(await state.pc.createOffer(iceRestart ? { iceRestart: true } : undefined));
      socket?.emit('rtc:offer', { target: peerId, sdp: state.pc.localDescription });
      if (state.negotiationRecoveryTimer) window.clearTimeout(state.negotiationRecoveryTimer);
      state.negotiationRecoveryTimer = undefined;
    } catch {
      state.needsNegotiation = true;
      recoverAfterFailure = state.pc.signalingState === 'stable' && state.pc.connectionState !== 'closed';
    } finally {
      state.makingOffer = false;
      if (recoverAfterFailure && peers.current.get(peerId) === state) {
        state.needsNegotiation = false;
        if (state.negotiationRecoveryTimer) window.clearTimeout(state.negotiationRecoveryTimer);
        state.negotiationRecoveryTimer = window.setTimeout(() => {
          state.negotiationRecoveryTimer = undefined;
          if (peers.current.get(peerId) === state) recoverPeerRef.current(peerId, 'falha ao criar oferta', true);
        }, 250);
      } else if (state.needsNegotiation && state.pc.signalingState === 'stable' && peers.current.get(peerId) === state) {
        window.setTimeout(() => void negotiateRef.current(peerId), 0);
      }
    }
  }, [socket]);
  negotiateRef.current = negotiate;

  const recoverPeer = useCallback((peerId: string, _reason = 'recuperação manual', notifyRemote = true, severity: RecoverySeverity | 'force' = 'force') => {
    if (!channelRef.current || peerId === selfId.current) return;
    const now = Date.now();
    const previous = peers.current.get(peerId);
    const lastAttemptAt = recoveryCooldown.current.get(peerId) ?? 0;
    const attempts = recoveryAttemptCount.current.get(peerId) ?? 0;
    if (severity === 'force') {
      if (now - lastAttemptAt < 500) return;
      recoveryAttemptCount.current.set(peerId, Math.min(6, attempts + 1));
    } else {
      const plan = planPeerRecovery({ now, lastAttemptAt, attempts, connectionState: previous?.pc.connectionState ?? 'closed', severity });
      if (plan.action === 'wait') return;
      recoveryAttemptCount.current.set(peerId, plan.attempts);
      recoveryCooldown.current.set(peerId, now);
      // Reiniciar o ICE mantém transceivers, decodificador e faixas de pé: o
      // espectador vê no máximo um engasgo, não a tela preta de uma
      // renegociação inteira. Só escalamos quando isso não resolve.
      if (plan.action === 'ice-restart' && previous) {
        updatePeerHealth(peerId, 'recovering');
        void negotiateRef.current(peerId, true);
        return;
      }
    }
    recoveryCooldown.current.set(peerId, now);
    const remoteUser = previous?.user ?? membersRef.current.find((member) => member.socketId === peerId);
    const attempt = recoveryAttemptCount.current.get(peerId) ?? 1;
    peers.current.delete(peerId);
    if (previous) closePeerState(previous);
    prunePeerStreamMetadata(streamMeta.current, peerId, 'recovery');
    refreshRemote();
    updatePeerHealth(peerId, 'recovering');
    // O pedido precisa chegar antes dos metadados reenviados por createPeer.
    // Socket.IO mantém essa ordem e o destinatário não apaga a classificação
    // da live recém-publicada durante a própria reconstrução.
    if (notifyRemote) socket?.emit('rtc:resync', { target: peerId });
    const next = createPeer(peerId, remoteUser);
    next.recoveryAttempts = attempt;
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
    // Invalida getUserMedia/getDisplayMedia ainda pendentes antes de consultar
    // o mapa. Assim uma permissão que termina depois de “Sair” não ressuscita
    // a captura nem deixa um sender órfão.
    mediaCaptureGeneration.current[kind] += 1;
    if (kind === 'screen') qualityChangeGeneration.current += 1;
    const stream = localStreams.current.get(kind);
    if (!stream) return;
    for (const [peerId, state] of peers.current) {
      for (const track of stream.getTracks()) {
        const sender = state.pc.getSenders().find((candidate) => candidate.track === track);
        if (sender) state.pc.removeTrack(sender);
      }
      if (kind === 'screen') state.screenTuningPending = false;
      void negotiate(peerId);
    }
    stream.getTracks().forEach((track) => track.stop());
    localStreams.current.delete(kind);
    if (kind === 'camera') {
      activeCameraDeviceId.current = '';
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

  const attachStream = useCallback(async (kind: 'camera' | 'screen', stream: MediaStream, screenQuality: StreamQuality = quality, captureGeneration = mediaCaptureGeneration.current[kind]) => {
    if (!stream.getVideoTracks().some((track) => track.readyState === 'live')) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('A captura não criou uma faixa de vídeo ativa.');
    }
    if (captureGeneration !== mediaCaptureGeneration.current[kind] || !channelRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    if (kind === 'screen') {
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) videoTrack.contentHint = screenContentHint(QUALITY[screenQuality]);
    }
    localStreams.current.set(kind, stream);
    for (const [peerId, state] of peers.current) {
      if (captureGeneration !== mediaCaptureGeneration.current[kind] || !channelRef.current || localStreams.current.get(kind) !== stream) break;
      for (const track of stream.getTracks()) {
        const sender = state.pc.addTrack(track, stream);
        if (kind === 'camera' && track.kind === 'video') void tuneCameraSender(sender);
      }
      sendStreamMeta(peerId, stream, kind);
      if (kind === 'screen') {
        const videoTrack = stream.getVideoTracks()[0];
        const sender = state.pc.getSenders().find((candidate) => candidate.track === videoTrack);
        const config = QUALITY[screenQuality];
        if (sender) {
          const baseScale = screenScaleForQuality(videoTrack?.getSettings() ?? {}, config);
          state.screenSenderSince = Date.now();
          state.screenWarmupHeld = true;
          state.screenTuningPending = true;
          const applied = await tuneScreenPeer(state, sender, config, config.bitrate, baseScale, true);
          state.screenTuningPending = !applied;
          if (!applied) onError('A transmissão iniciou, mas o navegador recusou o perfil de qualidade deste enlace.');
          state.screenBitrate = config.bitrate;
          state.healthyScreenSamples = 0;
          state.screenBaseScale = baseScale;
          state.screenScale = baseScale;
          state.healthyEncoderSamples = 0;
          state.encoderPressureSamples = 0;
          state.lastScaleChangeAt = 0;
          state.lastFramesEncoded = undefined;
          state.lastTotalEncodeTime = undefined;
          state.receiverFrozenUntil = 0;
          state.lastScreenBytes = undefined;
          state.lastScreenPackets = undefined;
          state.stalledScreenSamples = 0;
        }
      }
      if (captureGeneration !== mediaCaptureGeneration.current[kind] || !channelRef.current || localStreams.current.get(kind) !== stream) break;
      void negotiate(peerId);
    }
    if (captureGeneration !== mediaCaptureGeneration.current[kind] || !channelRef.current || localStreams.current.get(kind) !== stream) {
      for (const [peerId, state] of peers.current) {
        let changed = false;
        for (const track of stream.getTracks()) {
          const sender = state.pc.getSenders().find((candidate) => candidate.track === track);
          if (!sender) continue;
          try { state.pc.removeTrack(sender); changed = true; } catch { /* o peer já foi encerrado */ }
        }
        if (changed) void negotiate(peerId);
        if (kind === 'screen') state.screenTuningPending = false;
      }
      if (localStreams.current.get(kind) === stream) localStreams.current.delete(kind);
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    stream.getTracks().forEach((track) => {
      if (kind === 'screen' && track.kind === 'audio') track.onended = () => screenAudioEndedRef.current(track);
      else track.onended = () => void stopStream(kind);
    });
    if (kind === 'camera') {
      activeCameraDeviceId.current = preferences.cameraId;
      setCameraOn(true);
      publishState({ camera: true });
    } else {
      setScreenOn(true);
      setShowSourcePicker(false);
      screenAudioEnabled.current = stream.getAudioTracks().some((track) => track.readyState === 'live');
      publishState({ screen: true, screenAudio: screenAudioEnabled.current });
    }
    playSound(kind === 'screen' ? 'streamStart' : 'notification');
    return true;
  }, [negotiate, onError, preferences.cameraId, publishState, quality, sendStreamMeta, stopStream]);

  const ensureMicrophone = useCallback(async ({ force = false } = {}) => {
    const current = localStreams.current.get('microphone');
    const currentProcessing = microphoneProcessing.current;
    const wantsNeural = preferences.noiseSuppression && !neuralFallback.current;
    // Incrementar a geração antes desta verificação abortava uma captura em
    // andamento mesmo quando nada mudou — e o `join` desistia da call.
    //
    // `force` existe porque a recuperação precisa refazer a captura com a
    // mesma preferência de sempre: era justamente por cair neste atalho que a
    // única saída era trocar o dispositivo à mão e voltar.
    if (!force
      && current
      && currentProcessing?.deviceId === preferences.microphoneId
      && currentProcessing.noiseSuppression === preferences.noiseSuppression
      && currentProcessing.neural === wantsNeural) return current;
    const captureGeneration = ++microphoneCaptureGeneration.current;

    // Um id salvo pode existir na lista e mesmo assim recusar a captura: o
    // PipeWire renumera nós ao reconectar e o Chromium guarda ids por origem.
    // Sem esta reserva a pessoa ficava com o microfone escolhido e sem áudio
    // nenhum saindo, e só "Padrão do sistema" funcionava.
    const captureRawMicrophone = async (browserNoiseSuppression: boolean) => {
      const shape = (deviceId?: ConstrainDOMString) => ({
        audio: {
          ...(deviceId === undefined ? {} : { deviceId }),
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: browserNoiseSuppression },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48_000 },
          sampleSize: { ideal: 16 },
        },
        video: false,
      } as MediaStreamConstraints);
      if (!preferences.microphoneId) return navigator.mediaDevices.getUserMedia(shape());
      try {
        return await navigator.mediaDevices.getUserMedia(shape({ exact: preferences.microphoneId }));
      } catch (error) {
        if ((error as DOMException).name === 'NotAllowedError') throw error;
        const stream = await navigator.mediaDevices.getUserMedia(shape());
        microphoneFallbackNotice.current = true;
        return stream;
      }
    };

    let rawStream = await captureRawMicrophone(!wantsNeural && preferences.noiseSuppression);
    let nextProcessing: MicrophoneProcessing;
    if (wantsNeural) {
      try {
        nextProcessing = await createNeuralMicrophone(rawStream, preferences.microphoneId);
      } catch {
        rawStream.getTracks().forEach((track) => track.stop());
        rawStream = await captureRawMicrophone(true);
        neuralFallback.current = true;
        nextProcessing = { rawStream, outputStream: rawStream, deviceId: preferences.microphoneId, identity: { deviceId: '', groupId: '' }, defaultSignature: '', neural: false, noiseSuppression: true };
        onError('O filtro neural não iniciou; ativei a supressão compatível do microfone como reserva.');
      }
    } else {
      nextProcessing = { rawStream, outputStream: rawStream, deviceId: preferences.microphoneId, identity: { deviceId: '', groupId: '' }, defaultSignature: '', neural: false, noiseSuppression: preferences.noiseSuppression };
    }

    // A faixa que carrega a identidade do aparelho é sempre a crua: a saída do
    // filtro neural vem de um AudioContext e não tem `deviceId` nenhum.
    nextProcessing.identity = microphoneIdentityOf(nextProcessing.rawStream.getAudioTracks()[0]);
    nextProcessing.defaultSignature = preferences.microphoneId
      ? ''
      : defaultAudioInputSignature(await navigator.mediaDevices.enumerateDevices().catch(() => []));

    const stream = nextProcessing.outputStream;
    const old = localStreams.current.get('microphone') ?? currentProcessing?.outputStream;
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) {
      await disposeMicrophoneProcessing(nextProcessing);
      throw new Error('A captura não criou uma faixa de microfone.');
    }
    if (captureGeneration !== microphoneCaptureGeneration.current) {
      await disposeMicrophoneProcessing(nextProcessing);
      const latest = localStreams.current.get('microphone');
      if (latest) return latest;
      throw new DOMException('Captura de microfone substituída.', 'AbortError');
    }
    if ('contentHint' in newTrack) newTrack.contentHint = 'speech';
    newTrack.enabled = !mutedRef.current;
    const oldTrack = old?.getAudioTracks()[0];
    const switchedSenders: Array<{ peerId: string; sender: RTCRtpSender; state: PeerConnectionState; added: boolean }> = [];
    try {
      for (const [peerId, state] of peers.current) {
        const existing = state.pc.getSenders().find((candidate) => candidate.track === oldTrack);
        const sender = existing ?? state.pc.addTrack(newTrack, stream);
        if (existing) await sender.replaceTrack(newTrack);
        switchedSenders.push({ peerId, sender, state, added: !existing });
        await tuneVoiceSender(sender);
        if (!existing) void negotiateRef.current(peerId);
        if (captureGeneration !== microphoneCaptureGeneration.current) throw new DOMException('Troca de microfone cancelada.', 'AbortError');
      }
    } catch (error) {
      await Promise.all(switchedSenders.map(async ({ peerId, sender, state, added }) => {
        if (added) {
          if (peers.current.get(peerId) === state && state.pc.signalingState !== 'closed') {
            try { state.pc.removeTrack(sender); } catch { /* o peer já foi encerrado */ }
          }
        } else await sender.replaceTrack(oldTrack ?? null).catch(() => undefined);
      }));
      await disposeMicrophoneProcessing(nextProcessing);
      throw error;
    }
    localStreams.current.set('microphone', stream);
    microphoneProcessing.current = nextProcessing;
    // Um peer pode ser reconstruído enquanto os replaceTrack acima aguardam.
    // Depois do commit, novos peers já usam a faixa nova; esta passagem cobre
    // qualquer peer criado exatamente antes dele e evita áudio preso na faixa
    // encerrada do dispositivo anterior.
    for (const [peerId, state] of peers.current) {
      if (state.pc.getSenders().some((candidate) => candidate.track === newTrack)) continue;
      const staleSender = state.pc.getSenders().find((candidate) => candidate.track === oldTrack);
      try {
        const sender = staleSender ?? state.pc.addTrack(newTrack, stream);
        if (staleSender) await sender.replaceTrack(newTrack);
        await tuneVoiceSender(sender);
        if (!staleSender) void negotiateRef.current(peerId);
      } catch {
        recoverPeerRef.current(peerId, 'troca de microfone durante reconstrução', true);
      }
    }
    const recoverEndedMicrophone = () => {
      if (localStreams.current.get('microphone') !== stream || !channelRef.current) return;
      localStreams.current.delete('microphone');
      if (microphoneRecoveryTimer.current) window.clearTimeout(microphoneRecoveryTimer.current);
      microphoneRecoveryTimer.current = window.setTimeout(async () => {
        microphoneRecoveryTimer.current = undefined;
        if (!channelRef.current || localStreams.current.has('microphone')) return;
        try {
          await ensureMicrophoneRef.current({ force: true });
        } catch {
          mutedRef.current = true;
          setMuted(true);
          publishState({ muted: true, speaking: false });
          onError('O microfone foi desconectado e não encontrei outra entrada disponível.');
        }
      }, 300);
    };
    newTrack.onended = recoverEndedMicrophone;
    // `mute` é o aviso de que a fonte parou de entregar amostras sem a faixa
    // terminar: `readyState` segue `live`, `enabled` segue `true` e só quem
    // escuta percebe. Era o caso mais comum de "trocar o dispositivo resolve".
    for (const rawTrack of nextProcessing.rawStream.getAudioTracks()) {
      if (nextProcessing.rawStream !== stream) rawTrack.onended = recoverEndedMicrophone;
      rawTrack.onmute = () => noteMicrophoneFault('muted');
      rawTrack.onunmute = () => noteMicrophoneFault('none');
    }
    if (nextProcessing.rawStream === stream) {
      newTrack.onmute = () => noteMicrophoneFault('muted');
      newTrack.onunmute = () => noteMicrophoneFault('none');
    }
    microphoneSignal.current = { lastSignalAt: Date.now(), warned: false };
    microphoneFault.current = { ...microphoneFault.current, kind: 'none', since: 0, warned: false };
    if (microphoneFallbackNotice.current) {
      microphoneFallbackNotice.current = false;
      onError('O microfone escolhido não aceitou a captura; voltei para o padrão do sistema.');
    }
    if (currentProcessing) await disposeMicrophoneProcessing(currentProcessing);
    else old?.getTracks().forEach((track) => track.stop());
    await onDevicesChanged();
    if (channelRef.current && localStreams.current.get('microphone') === stream) startSpeakingMonitor(stream);
    return stream;
  }, [noteMicrophoneFault, onDevicesChanged, onError, preferences.microphoneId, preferences.noiseSuppression, publishState, startSpeakingMonitor]);
  ensureMicrophoneRef.current = ensureMicrophone;

  const join = useCallback(async (nextChannelId: string) => {
    if (!socket) return;
    const operation = ++joinGeneration.current;
    try {
      await ensureMicrophone();
    } catch (error) {
      if (operation !== joinGeneration.current) return;
      // AbortError significa apenas que outra captura assumiu no meio do
      // caminho. Cancelar a entrada aqui era o motivo de "clico em entrar e
      // não acontece nada"; seguimos com a faixa que ficou de pé.
      if (!isAbortError(error)) {
        mutedRef.current = true;
        setMuted(true);
        onError('Microfone indisponível. Você entrou mutado; confira as permissões nas configurações.');
      } else if (!localStreams.current.has('microphone')) {
        mutedRef.current = true;
        setMuted(true);
      }
    }
    if (operation !== joinGeneration.current) return;
    if (channelRef.current) {
      const previousPeers = [...peers.current.values()];
      peers.current.clear();
      previousPeers.forEach(closePeerState);
      setRemoteMedia([]);
      setPeerHealth({});
    }
    socket.emit('voice:join', nextChannelId, (result: { ok: boolean; selfId: string; peers: VoiceState[] }) => {
      if (operation !== joinGeneration.current) return;
      if (!result?.ok) return onError('Não foi possível entrar nessa call.');
      selfId.current = result.selfId;
      channelRef.current = nextChannelId;
      handoffStarted.current = false;
      setChannelId(nextChannelId);
      const microphone = localStreams.current.get('microphone');
      if (microphone) startSpeakingMonitor(microphone);
      // O alcance chega depois da entrada porque a sondagem fala com STUN e
      // com o roteador. Quem assume a call quando o host sai depende dele.
      void readDirectReport().then((report) => {
        if (report && channelRef.current === nextChannelId) socket.emit('voice:reachability', report.score);
      });
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
    joinGeneration.current += 1;
    mediaCaptureGeneration.current.camera += 1;
    mediaCaptureGeneration.current.screen += 1;
    microphoneCaptureGeneration.current += 1;
    qualityChangeGeneration.current += 1;
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
    setShowShareSetup(false);
    setShowSourcePicker(false);
    setShareBusy(false);
    shareListing.current = false;
    shareCapture.current = false;
    streamMeta.current.clear();
    recoveryCooldown.current.clear();
    recoveryAttemptCount.current.clear();
    missingScreenSince.current.clear();
    missingVoiceSince.current.clear();
    screenAudioRecovery.current.enabled = false;
    screenAudioRecovery.current.attempts = 0;
    if (screenAudioRecovery.current.timer) window.clearTimeout(screenAudioRecovery.current.timer);
    screenAudioRecovery.current.timer = undefined;
    if (microphoneRecoveryTimer.current) window.clearTimeout(microphoneRecoveryTimer.current);
    microphoneRecoveryTimer.current = undefined;
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
      // A identificação provisória de câmera/tela também depende do estado
      // anunciado. Reclassifique quando esse estado chegar depois da faixa.
      refreshRemote();
      if (remoteStreamStarted) playSound('streamStart');
      else if (remoteStreamStopped) playSound('streamStop');
    };
    const onPeerLeft = (peerId: string) => {
      const peer = peers.current.get(peerId);
      peers.current.delete(peerId);
      if (peer) closePeerState(peer);
      prunePeerStreamMetadata(streamMeta.current, peerId, 'departure');
      recoveryCooldown.current.delete(peerId);
      recoveryAttemptCount.current.delete(peerId);
      missingScreenSince.current.delete(peerId);
      missingVoiceSince.current.delete(peerId);
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
        await setTunedRemoteDescription(state.pc, sdp, currentScreenHints(localStreams.current.has('screen'), qualityRef.current));
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
          await setTunedRemoteDescription(state.pc, sdp, currentScreenHints(localStreams.current.has('screen'), qualityRef.current));
          state.ignoreOffer = false;
          await flushPendingCandidates(state);
          if (state.needsNegotiation) window.setTimeout(() => void negotiateRef.current(from), 0);
        } catch {
          recoverPeer(from, 'erro ao aplicar resposta', true);
        }
      }
    };
    const onIce = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const remoteUser = membersRef.current.find((member) => member.socketId === from);
      const state = peers.current.get(from) ?? (channelRef.current && remoteUser ? createPeer(from, remoteUser) : undefined);
      // ICE de uma oferta ignorada durante glare pertence à geração que o
      // peer impolido rejeitou. Reutilizá-lo depois na resposta aceita mistura
      // credenciais ICE e pode deixar a conexão em "connected" sem mídia.
      if (!state || state.ignoreOffer) return;
      if (shouldQueueIceCandidate(Boolean(state.pc.remoteDescription))) state.pendingCandidates.push(candidate);
      else await state.pc.addIceCandidate(candidate).catch(() => undefined);
    };
    const onMeta = ({ from, meta }: { from: string; meta: StreamMeta }) => {
      if (!meta || (meta.kind !== 'camera' && meta.kind !== 'screen') || typeof meta.streamId !== 'string' || !meta.streamId) return;
      streamMeta.current.set(streamMetadataKey(from, meta.streamId), meta.kind);
      refreshRemote();
    };
    const onStreamHealth = ({ from, frozen }: { from: string; frozen?: boolean }) => {
      if (!frozen) return;
      const state = peers.current.get(from);
      if (state) state.receiverFrozenUntil = Date.now() + 8_000;
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
    socket.on('rtc:stream-health', onStreamHealth);
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
      socket.off('rtc:stream-health', onStreamHealth);
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
      const stalledRemoteScreens = new Set<string>();
      try {
        for (const [peerId, state] of peers.current) {
          const report = await state.pc.getStats().catch(() => null);
          if (!report) continue;
          const stats: RtcStatLike[] = [];
          report.forEach((stat) => stats.push(stat as unknown as RtcStatLike));
          const path = activePathMetrics(stats);
          if (path.rttMs !== undefined) samples.push(path.rttMs);

          const sampledAt = Date.now();
          // Enquanto o enlace acabou de ser reconstruído, os contadores RTP
          // ainda estão zerados: interpretar isso como "sem tráfego" era o que
          // realimentava o ciclo de reconstruções e tela preta.
          const trustworthy = stallSignalIsTrustworthy({
            connectionState: state.pc.connectionState,
            msSinceLastRecovery: sampledAt - (recoveryCooldown.current.get(peerId) ?? 0),
          });
          if (state.connectedSince && sampledAt - state.connectedSince >= 30_000) recoveryAttemptCount.current.set(peerId, 0);

          const remoteMember = membersRef.current.find((member) => member.socketId === peerId);
          for (const receiver of state.pc.getReceivers().filter((candidate) => candidate.track?.kind === 'audio')) {
            const receiverStream = [...state.remoteStreams.values()].find((stream) => stream.getTracks().some((track) => track.id === receiver.track.id));
            const meta = receiverStream ? streamMeta.current.get(streamMetadataKey(peerId, receiverStream.id)) : undefined;
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
            if (stalled >= 5 && trustworthy && sampledAt - state.lastVoiceRecoveryAt >= 20_000) {
              state.lastVoiceRecoveryAt = sampledAt;
              stalledVoicePeers.add(peerId);
            }
          }

          for (const receiver of state.pc.getReceivers().filter((candidate) => candidate.track?.kind === 'video')) {
            const receiverStream = [...state.remoteStreams.values()].find((stream) => stream.getTracks().some((track) => track.id === receiver.track.id));
            const meta = receiverStream ? streamMeta.current.get(streamMetadataKey(peerId, receiverStream.id)) : undefined;
            const isScreenVideo = meta === 'screen' || (meta === undefined && Boolean(receiverStream && remoteMember?.screen));
            if (!isScreenVideo) {
              state.inboundScreen.delete(receiver.track.id);
              continue;
            }
            const receiverReport = await receiver.getStats().catch(() => null);
            const receiverStats: RtcStatLike[] = [];
            receiverReport?.forEach((stat) => receiverStats.push(stat as unknown as RtcStatLike));
            const inbound = inboundVideoMetrics(receiverStats);
            if (inbound.bytesReceived === undefined && inbound.packetsReceived === undefined) continue;
            const previous = state.inboundScreen.get(receiver.track.id) ?? { stalled: 0, since: sampledAt };
            const settled = sampledAt - previous.since >= 8_000;
            const trafficAdvanced = (inbound.bytesReceived !== undefined && previous.bytes !== undefined && inbound.bytesReceived > previous.bytes)
              || (inbound.packetsReceived !== undefined && previous.packets !== undefined && inbound.packetsReceived > previous.packets);
            const framesArrived = inbound.framesReceived !== undefined && previous.framesReceived !== undefined && inbound.framesReceived > previous.framesReceived;
            const decodeAdvanced = inbound.framesDecoded !== undefined && previous.framesDecoded !== undefined && inbound.framesDecoded > previous.framesDecoded;
            const freezeAdvanced = (inbound.freezeCount !== undefined && previous.freezeCount !== undefined && inbound.freezeCount > previous.freezeCount)
              || (inbound.totalFreezesDuration !== undefined && previous.freezeDuration !== undefined && inbound.totalFreezesDuration > previous.freezeDuration + 0.25);
            const decoderStalled = freezeAdvanced || (trafficAdvanced && framesArrived && !decodeAdvanced);
            const transportStalled = previous.bytes !== undefined && previous.packets !== undefined
              && inbound.bytesReceived !== undefined && inbound.packetsReceived !== undefined
              && inbound.bytesReceived <= previous.bytes && inbound.packetsReceived <= previous.packets
              && !receiver.track.muted;
            const stalled = decoderStalled
              ? previous.stalled + 2
              : transportStalled
                ? previous.stalled + 1
                : 0;
            state.inboundScreen.set(receiver.track.id, {
              bytes: inbound.bytesReceived,
              packets: inbound.packetsReceived,
              framesReceived: inbound.framesReceived,
              framesDecoded: inbound.framesDecoded,
              freezeCount: inbound.freezeCount,
              freezeDuration: inbound.totalFreezesDuration,
              stalled,
              since: previous.since,
            });
            // Os primeiros segundos de uma live sempre têm congelamento: o
            // decodificador espera o keyframe. Avisar o transmissor nessa
            // janela fazia o encoder reduzir a resolução logo na abertura.
            if (settled && (freezeAdvanced || stalled >= 2) && previous.stalled < 2) socket.emit('rtc:stream-health', { target: peerId, frozen: true });
            if (stalled >= 5 && settled && trustworthy && sampledAt - state.lastScreenDecodeRecoveryAt >= 20_000) {
              state.lastScreenDecodeRecoveryAt = sampledAt;
              stalledRemoteScreens.add(peerId);
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
          // Taxa real de saída nesta janela. É ela que diz se a estimativa de
          // banda do Chromium tem algo a dizer: com a tela parada enviamos uma
          // fração do teto, e a estimativa acompanha o envio, não a rota.
          const elapsedSeconds = state.rateAt ? (sampledAt - state.rateAt) / 1_000 : 0;
          const sendingBitrate = outbound.bytesSent !== undefined && state.rateBytes !== undefined && elapsedSeconds >= 0.5
            ? Math.max(0, ((outbound.bytesSent - state.rateBytes) * 8) / elapsedSeconds)
            : undefined;
          if (outbound.bytesSent !== undefined) {
            state.rateBytes = outbound.bytesSent;
            state.rateAt = sampledAt;
          }
          const bitrateDecision = adaptScreenBitrate({
            targetBitrate: config.bitrate,
            currentBitrate: state.screenBitrate ?? config.bitrate,
            healthySamples: state.healthyScreenSamples,
            rttMs: path.rttMs,
            availableOutgoingBitrate: path.availableOutgoingBitrate,
            fractionLost: outbound.fractionLost,
            warmingUp: sampledAt - state.screenSenderSince < SCREEN_WARMUP_MS,
            sendingBitrate,
          });
          // Quando a janela de abertura termina, o perfil volta a mandar na
          // troca entre resolução e FPS — e isso precisa ser reaplicado.
          const holdResolution = sampledAt - state.screenSenderSince < SCREEN_WARMUP_MS;
          const warmupChanged = state.screenWarmupHeld !== holdResolution;
          state.screenWarmupHeld = holdResolution;
          const encodedFrames = outbound.framesEncoded;
          const totalEncodeTime = outbound.totalEncodeTime;
          const encodedDelta = encodedFrames !== undefined && state.lastFramesEncoded !== undefined ? encodedFrames - state.lastFramesEncoded : 0;
          const encodeTimeDelta = totalEncodeTime !== undefined && state.lastTotalEncodeTime !== undefined ? totalEncodeTime - state.lastTotalEncodeTime : 0;
          const averageEncodeMs = encodedDelta > 0 && encodeTimeDelta >= 0 ? (encodeTimeDelta * 1_000) / encodedDelta : undefined;
          state.lastFramesEncoded = encodedFrames;
          state.lastTotalEncodeTime = totalEncodeTime;
          const receiverReportedFreeze = state.receiverFrozenUntil > Date.now();
          const encoderDecision = adaptEncoderScale({
            targetFps: config.frameRate,
            currentScale: state.screenScale,
            minimumScale: state.screenBaseScale,
            maximumScale: maximumAdaptiveScreenScale(state.screenBaseScale),
            healthySamples: state.healthyEncoderSamples,
            pressureSamples: state.encoderPressureSamples,
            averageEncodeMs,
            qualityLimitationReason: outbound.qualityLimitationReason,
            receiverFrozen: receiverReportedFreeze,
          });
          if (receiverReportedFreeze) state.receiverFrozenUntil = 0;
          // O que o controlador decide só vira comando quando muda alguma
          // coisa de verdade. `state` guarda o que o encoder realmente tem,
          // para que a próxima decisão parta do valor aplicado.
          const appliedBitrate = state.screenBitrate ?? config.bitrate;
          const bitrateChanged = shouldApplyBitrateChange(appliedBitrate, bitrateDecision.bitrate);
          const nextScale = shouldApplyScaleChange({
            currentScale: state.screenScale,
            nextScale: encoderDecision.scale,
            msSinceChange: sampledAt - (state.lastScaleChangeAt || state.screenSenderSince),
          }) ? encoderDecision.scale : state.screenScale;
          const scaleChanged = Math.abs(nextScale - state.screenScale) >= 0.01;
          if (scaleChanged) state.lastScaleChangeAt = sampledAt;
          state.healthyScreenSamples = bitrateDecision.healthySamples;
          if (bitrateChanged) state.screenBitrate = bitrateDecision.bitrate;
          state.screenScale = nextScale;
          state.healthyEncoderSamples = encoderDecision.healthySamples;
          state.encoderPressureSamples = encoderDecision.pressureSamples;
          if (bitrateChanged || scaleChanged || warmupChanged || state.screenTuningPending) {
            state.screenTuningPending = !(await tuneScreenPeer(state, sender, config, state.screenBitrate ?? config.bitrate, nextScale, holdResolution));
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
            if (state.stalledScreenSamples >= 6 && trustworthy && sampledAt - state.lastScreenRecoveryAt >= 25_000) {
              state.lastScreenRecoveryAt = sampledAt;
              state.stalledScreenSamples = 0;
              stalledPeers.push(peerId);
            }
          }
        }
        socket.emit('voice:latency', median(samples) ?? 9999);
        for (const peerId of stalledPeers) recoverPeerRef.current(peerId, 'live local sem tráfego', true, 'soft');
        for (const peerId of stalledVoicePeers) recoverPeerRef.current(peerId, 'áudio remoto sem tráfego RTP', true, 'soft');
        for (const peerId of stalledRemoteScreens) recoverPeerRef.current(peerId, 'decodificador da live congelado', true, 'soft');
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
    void ensureMicrophone().catch((error) => {
      if (!isAbortError(error)) onError('Não foi possível atualizar o processamento do microfone.');
    });
  }, [ensureMicrophone, onError]);

  // O worklet WASM do filtro neural pode travar sob xrun do PipeWire. A faixa
  // segue "live" e habilitada, então ninguém percebe do lado de cá: só quem
  // ouve nota que o microfone sumiu. Aqui comparamos a energia antes e depois
  // do filtro e voltamos para o caminho simples se o áudio parar de sair.
  useEffect(() => {
    if (!channelId) return;
    let silentSamples = 0;
    const timer = window.setInterval(() => {
      const processing = microphoneProcessing.current;
      const track = processing?.outputStream.getAudioTracks()[0];
      if (!processing?.neural || !track || track.readyState !== 'live' || !track.enabled || mutedRef.current) {
        silentSamples = 0;
        return;
      }
      // Um contexto suspenso não move nenhum medidor, então a comparação de
      // energia sozinha nunca perceberia a falha.
      if (processing.context && processing.context.state !== 'running') {
        void processing.context.resume().catch(() => undefined);
        silentSamples += 1;
        if (silentSamples < 4) return;
        silentSamples = 0;
        neuralFallback.current = true;
        onError('O processamento do microfone não retomou; seu áudio voltou pelo caminho simples.');
        void ensureMicrophoneRef.current({ force: true }).catch(() => undefined);
        return;
      }
      const raw = analyserLevel(processing.inputMeter);
      const processed = analyserLevel(processing.outputMeter);
      silentSamples = raw > 0.02 && processed < 0.0015 ? silentSamples + 1 : 0;
      if (silentSamples < 5) return;
      silentSamples = 0;
      neuralFallback.current = true;
      onError('O filtro neural parou de processar; seu microfone voltou pelo caminho simples.');
      void ensureMicrophoneRef.current({ force: true }).catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [channelId, onError]);

  // Um microfone que abre sem captar nada é silencioso dos dois lados: quem
  // fala não percebe e quem ouve acha que a call caiu. Até a 0.7.8 o app só
  // avisava e pedia para a pessoa trocar o dispositivo à mão — que é
  // exatamente o que refazer a captura faz. Agora ele faz isso sozinho, com
  // teto de tentativas para não virar um laço de renegociação.
  useEffect(() => {
    if (!channelId) return;
    let recapturing = false;
    const timer = window.setInterval(() => {
      const processing = microphoneProcessing.current;
      const track = processing?.outputStream.getAudioTracks()[0];
      const rawTrack = processing?.rawStream.getAudioTracks()[0];
      const signal = microphoneSignal.current;
      const state = microphoneFault.current;
      if (recapturing) return;
      if (!processing || !track || track.readyState !== 'live' || !track.enabled || mutedRef.current) {
        signal.lastSignalAt = Date.now();
        if (state.kind === 'silent') noteMicrophoneFault('none');
        return;
      }
      const now = Date.now();
      // `muted` e a troca do dispositivo padrão são detectados por evento e já
      // chegam registrados; aqui resta medir a energia que entra.
      if (state.kind === 'none' || state.kind === 'silent' || state.kind === 'dead') {
        const meter = processing.neural ? processing.inputMeter : speakingMonitor.current?.analyser;
        const measurable = Boolean(meter) && speakingMonitor.current?.context.state === 'running' && !rawTrack?.muted;
        if (!measurable) {
          signal.lastSignalAt = now;
          noteMicrophoneFault('none');
          return;
        }
        const measured = faultFromLevel(analyserLevel(meter));
        if (measured === 'none') {
          signal.lastSignalAt = now;
          signal.warned = false;
          // Sinal de verdade é a prova de que o microfone voltou: o orçamento
          // de recapturas automáticas pode ser devolvido.
          microphoneFault.current = { kind: 'none', since: 0, recaptures: 0, lastRecaptureAt: state.lastRecaptureAt, warned: false };
          return;
        }
        if (measured !== state.kind) {
          microphoneFault.current = { ...state, kind: measured, since: measured === 'silent' ? (signal.lastSignalAt || now) : now };
        }
      }
      const current = microphoneFault.current;
      if (current.kind === 'none') return;
      const plan = planMicrophoneRecovery({
        now,
        fault: current.kind,
        faultSince: current.since,
        lastRecaptureAt: current.lastRecaptureAt,
        recaptures: current.recaptures,
        warned: current.warned,
      });
      if (plan.action === 'wait') return;
      if (plan.action === 'warn') {
        microphoneFault.current = { ...current, warned: true };
        signal.warned = true;
        onError(`${describeMicrophoneFault(current.kind)} Escolha outra entrada em Configurações › Microfone.`);
        return;
      }
      recapturing = true;
      microphoneFault.current = { ...current, recaptures: plan.recaptures, lastRecaptureAt: now, since: now };
      void ensureMicrophoneRef.current({ force: true })
        .catch(() => undefined)
        .finally(() => { recapturing = false; });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [channelId, noteMicrophoneFault, onError]);

  // Trocar o dispositivo padrão do sistema não termina nem silencia a faixa
  // aberta: ela simplesmente continua presa ao aparelho anterior. Foi o que
  // fez começar uma live quebrar o microfone, já que a fonte virtual da live
  // entra no grafo do PipeWire e pode assumir o padrão.
  useEffect(() => {
    if (!channelId || !navigator.mediaDevices?.enumerateDevices) return;
    const inspect = async () => {
      const processing = microphoneProcessing.current;
      if (!processing) return;
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const gone = capturedDeviceIsGone({
        preferenceId: processing.deviceId,
        captured: processing.identity,
        capturedDefaultSignature: processing.defaultSignature,
        devices,
      });
      if (gone) noteMicrophoneFault('device-changed');
    };
    void inspect();
    navigator.mediaDevices.addEventListener('devicechange', inspect);
    return () => navigator.mediaDevices.removeEventListener('devicechange', inspect);
  }, [channelId, noteMicrophoneFault]);

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
        const peerState = peers.current.get(peerId);
        if (peerState?.pc.connectionState === 'connected' && now - missingSince >= 10_000 && now - lastRecovery >= RECOVERY_GRACE_MS) {
          missingScreenSince.current.set(peerId, now);
          // Uma faixa que nunca chegou não volta com ICE restart: aqui a
          // reconstrução do enlace é mesmo o único caminho.
          recoverPeer(peerId, screenMedia ? 'live anunciada sem trilha de áudio' : 'live anunciada sem trilha de vídeo', true, 'hard');
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
        const peerState = peers.current.get(peerId);
        if (peerState?.pc.connectionState === 'connected' && now - missingSince >= 10_000 && now - lastRecovery >= RECOVERY_GRACE_MS) {
          missingVoiceSince.current.set(peerId, now);
          recoverPeer(peerId, 'participante sem trilha de voz', true, 'hard');
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
    // O roteador principal já observa mudanças do grafo a cada 2 s. Esta
    // verificação mais espaçada serve apenas para reconstruir módulos após um
    // reinício completo do PipeWire, evitando dois loops de pw-dump agressivos.
    const timer = window.setInterval(() => void keepScreenAudioHealthy(), 10_000);
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
    if (localStreams.current.has('camera')) return stopStream('camera');
    const captureGeneration = ++mediaCaptureGeneration.current.camera;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: preferences.cameraId ? { exact: preferences.cameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      await attachStream('camera', stream, qualityRef.current, captureGeneration);
      await onDevicesChanged();
    } catch { onError('Câmera indisponível ou permissão negada.'); }
  };

  useEffect(() => {
    if (!cameraOn || cameraSwitching.current || activeCameraDeviceId.current === preferences.cameraId) return;
    const currentStream = localStreams.current.get('camera');
    const oldTrack = currentStream?.getVideoTracks().find((track) => track.readyState === 'live');
    if (!currentStream || !oldTrack) return;
    cameraSwitching.current = true;
    const captureGeneration = mediaCaptureGeneration.current.camera;
    const desiredCameraId = preferences.cameraId;
    let completed = false;
    void navigator.mediaDevices.getUserMedia({
      video: { deviceId: desiredCameraId ? { exact: desiredCameraId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    }).then(async (replacement) => {
      const newTrack = replacement.getVideoTracks()[0];
      if (!newTrack || captureGeneration !== mediaCaptureGeneration.current.camera || localStreams.current.get('camera') !== currentStream) {
        replacement.getTracks().forEach((track) => track.stop());
        return;
      }
      const switchedSenders: Array<{ sender: RTCRtpSender; state: PeerConnectionState }> = [];
      try {
        for (const state of peers.current.values()) {
          const sender = state.pc.getSenders().find((candidate) => candidate.track === oldTrack);
          if (!sender) continue;
          await sender.replaceTrack(newTrack);
          switchedSenders.push({ sender, state });
          if (captureGeneration !== mediaCaptureGeneration.current.camera || localStreams.current.get('camera') !== currentStream) {
            throw new DOMException('Troca de câmera cancelada.', 'AbortError');
          }
        }
      } catch (error) {
        const cameraStillActive = localStreams.current.get('camera') === currentStream && oldTrack.readyState === 'live';
        await Promise.all(switchedSenders.map(async ({ sender, state }) => {
          if (cameraStillActive) await sender.replaceTrack(oldTrack).catch(() => undefined);
          else if ([...peers.current.values()].includes(state) && state.pc.signalingState !== 'closed') {
            try { state.pc.removeTrack(sender); } catch { /* o peer já foi encerrado */ }
          }
        }));
        replacement.getTracks().forEach((track) => track.stop());
        throw error;
      }
      currentStream.removeTrack(oldTrack);
      currentStream.addTrack(newTrack);
      newTrack.onended = () => void stopStream('camera');
      activeCameraDeviceId.current = desiredCameraId;
      for (const [peerId, state] of peers.current) {
        if (state.pc.getSenders().some((candidate) => candidate.track === newTrack)) continue;
        const staleSender = state.pc.getSenders().find((candidate) => candidate.track === oldTrack);
        try {
          if (staleSender) await staleSender.replaceTrack(newTrack);
          else {
            state.pc.addTrack(newTrack, currentStream);
            void negotiateRef.current(peerId);
          }
          sendStreamMeta(peerId, currentStream, 'camera');
        } catch {
          recoverPeerRef.current(peerId, 'troca de câmera durante reconstrução', true);
        }
      }
      oldTrack.onended = null;
      oldTrack.stop();
      await onDevicesChanged();
      completed = true;
    }).catch((error) => {
      if ((error as DOMException).name !== 'AbortError') onError('Não foi possível trocar a câmera; a câmera atual continua ativa.');
    }).finally(() => {
      cameraSwitching.current = false;
      if (completed && localStreams.current.has('camera') && activeCameraDeviceId.current !== preferencesRef.current.cameraId) retryCameraSwitch((current) => current + 1);
    });
  }, [cameraOn, onDevicesChanged, onError, preferences.cameraId, sendStreamMeta, stopStream]);

  const requestScreenShare = async () => {
    if (localStreams.current.has('screen')) return stopStream('screen');
    if (shareListing.current || shareCapture.current) return;
    setShowShareSetup(true);
  };

  const prepareScreenShare = async (includeAudio: boolean, selectedQuality: StreamQuality) => {
    if (shareListing.current || shareCapture.current) return;
    shareListing.current = true;
    setShareBusy(true);
    pendingShareOptions.current = { includeAudio, quality: selectedQuality };
    const captureGeneration = mediaCaptureGeneration.current.screen;
    qualityRef.current = selectedQuality;
    setQuality(selectedQuality);
    persistStreamQuality(selectedQuality);
    try {
      if (window.tumacordDesktop) {
        const sources = await window.tumacordDesktop.getSources();
        if (captureGeneration !== mediaCaptureGeneration.current.screen || !channelRef.current) return;
        if (!sources.length) throw new Error('Nenhuma tela ou janela foi encontrada.');
        setDesktopSources(sources);
        setShowShareSetup(false);
        // No Wayland/PipeWire, getSources já abre o seletor do sistema e
        // devolve somente a fonte escolhida. Começar direto evita pedir a
        // mesma tela novamente em um segundo seletor.
        if (sources.length === 1) await shareDesktopSource(sources[0].id, sources[0].kind, captureGeneration);
        else setShowSourcePicker(true);
        return;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: screenCaptureConstraints(),
        audio: includeAudio,
        selfBrowserSurface: 'exclude',
        systemAudio: includeAudio ? 'include' : 'exclude',
        windowAudio: 'window',
      } as DisplayMediaStreamOptions);
      setShowShareSetup(false);
      await attachStream('screen', stream, selectedQuality, captureGeneration);
    } catch (error) {
      if ((error as DOMException).name !== 'NotAllowedError') onError(error instanceof Error ? error.message : 'Não consegui compartilhar a tela.');
    } finally {
      shareListing.current = false;
      if (!shareCapture.current) setShareBusy(false);
    }
  };

  async function shareDesktopSource(sourceId: string, _sourceKind: DesktopSource['kind'], captureGeneration = mediaCaptureGeneration.current.screen): Promise<void> {
    if (shareCapture.current) return;
    if (captureGeneration !== mediaCaptureGeneration.current.screen || !channelRef.current) return;
    shareCapture.current = true;
    setShareBusy(true);
    setShowShareSetup(false);
    setShowSourcePicker(false);
    const { includeAudio, quality: selectedQuality } = pendingShareOptions.current;
    qualityRef.current = selectedQuality;
    setQuality(selectedQuality);
    persistStreamQuality(selectedQuality);
    let routedScreenAudio = false;
    let capturedAudio: MediaStream | null = null;
    let capturedDisplay: MediaStream | null = null;
    try {
      if (window.tumacordDesktop && includeAudio) {
        const prepared = await window.tumacordDesktop.prepareScreenAudio();
        if (captureGeneration !== mediaCaptureGeneration.current.screen || !channelRef.current) {
          await window.tumacordDesktop.stopScreenAudio().catch(() => undefined);
          return;
        }
        if (prepared.ok && prepared.deviceId) {
          routedScreenAudio = true;
          screenAudioRecovery.current = {
            enabled: true,
            deviceName: prepared.deviceName || 'Tumacord Stream Audio',
            attempts: 0,
          };
          capturedAudio = await captureIsolatedScreenAudio(prepared.deviceName || 'Tumacord Stream Audio');
          if (captureGeneration !== mediaCaptureGeneration.current.screen || !channelRef.current) throw new DOMException('Captura de tela cancelada.', 'AbortError');
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
            chromeMediaSourceId: sourceId,
            ...desktopScreenCaptureConstraints(),
          },
        } as unknown as MediaTrackConstraints,
      });
      const stream = new MediaStream([
        ...capturedDisplay.getVideoTracks(),
        ...(capturedAudio?.getAudioTracks() ?? []),
      ]);
      if (!includeAudio) screenAudioRecovery.current = { enabled: false, deviceName: '', attempts: 0 };
      const attached = await attachStream('screen', stream, selectedQuality, captureGeneration);
      if (!attached && routedScreenAudio) await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
    } catch (error) {
      capturedDisplay?.getTracks().forEach((track) => track.stop());
      capturedAudio?.getTracks().forEach((track) => track.stop());
      if (routedScreenAudio) await window.tumacordDesktop?.stopScreenAudio().catch(() => undefined);
      screenAudioRecovery.current = { enabled: false, deviceName: '', attempts: 0 };
      if (!isAbortError(error)) {
        onError(`Não consegui iniciar a transmissão${includeAudio ? ' com áudio isolado' : ''}: ${error instanceof Error ? error.message : 'captura indisponível'}`);
        if (channelRef.current) {
          if (desktopSources.length > 1) setShowSourcePicker(true);
          else setShowShareSetup(true);
        }
      }
    } finally {
      shareCapture.current = false;
      if (!shareListing.current) setShareBusy(false);
    }
  }

  const changeQuality = async (next: StreamQuality) => {
    const operation = ++qualityChangeGeneration.current;
    qualityRef.current = next;
    setQuality(next);
    persistStreamQuality(next);
    const stream = localStreams.current.get('screen');
    if (!stream) return true;
    const config = QUALITY[next];
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) videoTrack.contentHint = screenContentHint(config);
    const baseScale = screenScaleForQuality(videoTrack?.getSettings() ?? {}, config);
    let rejectedByBrowser = 0;
    for (const state of peers.current.values()) {
      if (operation !== qualityChangeGeneration.current || localStreams.current.get('screen') !== stream) return false;
      const sender = state.pc.getSenders().find((candidate) => candidate.track === videoTrack);
      if (!sender) continue;
      state.screenSenderSince = Date.now();
      state.screenWarmupHeld = true;
      state.screenTuningPending = true;
      const applied = await tuneScreenPeer(state, sender, config, config.bitrate, baseScale, true);
      if (operation !== qualityChangeGeneration.current || localStreams.current.get('screen') !== stream) return false;
      state.screenTuningPending = !applied;
      if (!applied) rejectedByBrowser += 1;
      state.screenBitrate = config.bitrate;
      state.healthyScreenSamples = 0;
      state.screenBaseScale = baseScale;
      state.screenScale = baseScale;
      state.healthyEncoderSamples = 0;
      state.encoderPressureSamples = 0;
      state.lastScaleChangeAt = 0;
      state.lastFramesEncoded = undefined;
      state.lastTotalEncodeTime = undefined;
      state.receiverFrozenUntil = 0;
      state.lastScreenBytes = undefined;
      state.lastScreenPackets = undefined;
      state.stalledScreenSamples = 0;
    }
    if (rejectedByBrowser) {
      onError(`A captura continua ativa, mas ${rejectedByBrowser === 1 ? 'um enlace recusou' : `${rejectedByBrowser} enlaces recusaram`} o novo perfil de qualidade.`);
      return false;
    }
    return true;
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
