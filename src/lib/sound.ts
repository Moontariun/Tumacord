const SOUND_KEY = 'tumacord.sound-feedback';
const SOUND_VOLUME_KEY = 'tumacord.sound-volume';

export type FeedbackSound = 'connect' | 'join' | 'leave' | 'message' | 'notification' | 'error' | 'mute' | 'unmute' | 'streamStart' | 'streamStop' | 'host';

type AudioContextConstructor = typeof AudioContext;
type WindowWithAudio = Window & { webkitAudioContext?: AudioContextConstructor };
type Tone = { frequency: number; duration: number; offset: number; gain: number; wave?: OscillatorType; detune?: number };

let context: AudioContext | null = null;

const patterns: Record<FeedbackSound, Tone[]> = {
  connect: [
    { frequency: 392, duration: 0.16, offset: 0, gain: 0.1, wave: 'triangle' },
    { frequency: 523.25, duration: 0.19, offset: 0.08, gain: 0.11, wave: 'triangle' },
    { frequency: 659.25, duration: 0.24, offset: 0.17, gain: 0.09, wave: 'sine' },
  ],
  join: [
    { frequency: 440, duration: 0.12, offset: 0, gain: 0.1, wave: 'triangle' },
    { frequency: 587.33, duration: 0.19, offset: 0.07, gain: 0.1, wave: 'sine' },
  ],
  leave: [
    { frequency: 523.25, duration: 0.13, offset: 0, gain: 0.09, wave: 'triangle' },
    { frequency: 349.23, duration: 0.2, offset: 0.08, gain: 0.09, wave: 'sine' },
  ],
  message: [
    { frequency: 784, duration: 0.11, offset: 0, gain: 0.08, wave: 'sine' },
    { frequency: 987.77, duration: 0.15, offset: 0.07, gain: 0.075, wave: 'sine' },
  ],
  notification: [
    { frequency: 659.25, duration: 0.13, offset: 0, gain: 0.075, wave: 'triangle' },
    { frequency: 783.99, duration: 0.2, offset: 0.08, gain: 0.075, wave: 'sine' },
  ],
  error: [
    { frequency: 246.94, duration: 0.18, offset: 0, gain: 0.1, wave: 'sawtooth' },
    { frequency: 185, duration: 0.23, offset: 0.1, gain: 0.09, wave: 'triangle' },
  ],
  mute: [
    { frequency: 420, duration: 0.09, offset: 0, gain: 0.08, wave: 'triangle' },
    { frequency: 280, duration: 0.15, offset: 0.055, gain: 0.09, wave: 'sine' },
  ],
  unmute: [
    { frequency: 330, duration: 0.09, offset: 0, gain: 0.08, wave: 'triangle' },
    { frequency: 494, duration: 0.16, offset: 0.055, gain: 0.09, wave: 'sine' },
  ],
  streamStart: [
    { frequency: 293.66, duration: 0.14, offset: 0, gain: 0.08, wave: 'triangle' },
    { frequency: 440, duration: 0.17, offset: 0.07, gain: 0.1, wave: 'triangle' },
    { frequency: 659.25, duration: 0.25, offset: 0.15, gain: 0.1, wave: 'sine' },
  ],
  streamStop: [
    { frequency: 587.33, duration: 0.13, offset: 0, gain: 0.08, wave: 'triangle' },
    { frequency: 392, duration: 0.21, offset: 0.08, gain: 0.085, wave: 'sine' },
  ],
  host: [
    { frequency: 523.25, duration: 0.12, offset: 0, gain: 0.08, wave: 'triangle' },
    { frequency: 659.25, duration: 0.16, offset: 0.08, gain: 0.09, wave: 'triangle' },
    { frequency: 783.99, duration: 0.28, offset: 0.17, gain: 0.1, wave: 'sine' },
  ],
};

export function readSoundEnabled(): boolean {
  return typeof localStorage === 'undefined' || localStorage.getItem(SOUND_KEY) !== 'false';
}

export function readSoundVolume(): number {
  if (typeof localStorage === 'undefined') return 0.8;
  const value = Number(localStorage.getItem(SOUND_VOLUME_KEY) ?? 0.8);
  return Number.isFinite(value) ? Math.max(0.2, Math.min(1, value)) : 0.8;
}

export function setSoundPreference(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_KEY, String(enabled));
}

export function setSoundVolume(volume: number): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_VOLUME_KEY, String(Math.max(0.2, Math.min(1, volume))));
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const Constructor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
  if (!Constructor) return null;
  context = new Constructor({ latencyHint: 'interactive' });
  return context;
}

export function unlockAudio(): void {
  const audio = getContext();
  if (audio?.state === 'suspended') void audio.resume();
}

export function playSound(sound: FeedbackSound): void {
  if (!readSoundEnabled()) return;
  const audio = getContext();
  if (!audio) return;
  if (audio.state === 'suspended') void audio.resume();
  const now = audio.currentTime + 0.008;
  const masterVolume = readSoundVolume();
  const master = audio.createGain();
  const filter = audio.createBiquadFilter();
  master.gain.setValueAtTime(masterVolume, now);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(sound === 'error' ? 1_800 : 4_800, now);
  filter.Q.setValueAtTime(0.55, now);
  master.connect(filter).connect(audio.destination);
  const pattern = patterns[sound];
  for (const tone of pattern) {
    const start = now + tone.offset;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = tone.wave ?? 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, start);
    oscillator.detune.setValueAtTime(tone.detune ?? 0, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.018);
    gain.gain.setValueAtTime(tone.gain, start + Math.max(0.02, tone.duration * 0.45));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(start);
    oscillator.stop(start + tone.duration + 0.025);
  }
  const end = Math.max(...pattern.map((tone) => tone.offset + tone.duration)) + 0.08;
  window.setTimeout(() => { master.disconnect(); filter.disconnect(); }, end * 1_000);
}
