const SOUND_KEY = 'tumacord.sound-feedback';

export type FeedbackSound = 'connect' | 'join' | 'leave' | 'message' | 'notification' | 'error' | 'mute' | 'unmute' | 'stream';

type AudioContextConstructor = typeof AudioContext;
type WindowWithAudio = Window & { webkitAudioContext?: AudioContextConstructor };

let context: AudioContext | null = null;

const patterns: Record<FeedbackSound, Array<{ frequency: number; duration: number; offset: number; volume: number }>> = {
  connect: [{ frequency: 523.25, duration: 0.09, offset: 0, volume: 0.045 }, { frequency: 659.25, duration: 0.12, offset: 0.07, volume: 0.04 }],
  join: [{ frequency: 392, duration: 0.08, offset: 0, volume: 0.05 }, { frequency: 523.25, duration: 0.13, offset: 0.07, volume: 0.045 }],
  leave: [{ frequency: 523.25, duration: 0.08, offset: 0, volume: 0.04 }, { frequency: 392, duration: 0.13, offset: 0.07, volume: 0.035 }],
  message: [{ frequency: 740, duration: 0.08, offset: 0, volume: 0.035 }, { frequency: 880, duration: 0.08, offset: 0.07, volume: 0.03 }],
  notification: [{ frequency: 659.25, duration: 0.08, offset: 0, volume: 0.035 }, { frequency: 783.99, duration: 0.12, offset: 0.07, volume: 0.03 }],
  error: [{ frequency: 220, duration: 0.12, offset: 0, volume: 0.045 }, { frequency: 164.81, duration: 0.16, offset: 0.1, volume: 0.04 }],
  mute: [{ frequency: 330, duration: 0.1, offset: 0, volume: 0.035 }],
  unmute: [{ frequency: 494, duration: 0.1, offset: 0, volume: 0.035 }],
  stream: [{ frequency: 440, duration: 0.07, offset: 0, volume: 0.03 }, { frequency: 587.33, duration: 0.1, offset: 0.06, volume: 0.03 }],
};

export function readSoundEnabled(): boolean {
  return typeof localStorage === 'undefined' || localStorage.getItem(SOUND_KEY) !== 'false';
}

export function setSoundPreference(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_KEY, String(enabled));
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;
  const Constructor = window.AudioContext ?? (window as WindowWithAudio).webkitAudioContext;
  if (!Constructor) return null;
  context = new Constructor();
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
  const now = audio.currentTime;
  for (const tone of patterns[sound]) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(tone.frequency, now + tone.offset);
    gain.gain.setValueAtTime(0.0001, now + tone.offset);
    gain.gain.exponentialRampToValueAtTime(tone.volume, now + tone.offset + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.offset + tone.duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now + tone.offset);
    oscillator.stop(now + tone.offset + tone.duration + 0.02);
  }
}
