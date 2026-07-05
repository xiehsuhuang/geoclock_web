type SoundResult = {
  ok: boolean;
  error?: string;
};

type AlertLoopOptions = {
  playMs?: number;
  intervalMs?: number;
  onError?: (error: string) => void;
};

let audioContext: AudioContext | null = null;
let activeOscillator: OscillatorNode | null = null;
let activeGain: GainNode | null = null;
let stopTimer: number | null = null;
let loopTimer: number | null = null;

export async function unlockAlertSound(): Promise<SoundResult> {
  const context = getAudioContext();
  if (!context) {
    return { ok: false, error: "此瀏覽器不支援 Web Audio API，無法播放提示音。" };
  }

  try {
    if (context.state === "suspended") {
      await context.resume();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "提示音解鎖失敗。" };
  }
}

export async function playAlertSoundFor(ms: number): Promise<SoundResult> {
  const unlocked = await unlockAlertSound();
  if (!unlocked.ok) {
    return unlocked;
  }

  if (!audioContext) {
    return { ok: false, error: "提示音尚未初始化。" };
  }

  try {
    stopAlertSound();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.08;
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();

    activeOscillator = oscillator;
    activeGain = gain;
    stopTimer = window.setTimeout(stopAlertSound, ms);
    return { ok: true };
  } catch (error) {
    stopAlertSound();
    return { ok: false, error: error instanceof Error ? error.message : "提示音播放失敗。" };
  }
}

export function stopAlertSound() {
  if (stopTimer !== null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  try {
    activeOscillator?.stop();
  } catch {
    // oscillator may already be stopped
  }
  try {
    activeOscillator?.disconnect();
    activeGain?.disconnect();
  } catch {
    // nodes may already be disconnected
  }
  activeOscillator = null;
  activeGain = null;
}

export function startAlertSoundLoop({ playMs = 5000, intervalMs = 10000, onError }: AlertLoopOptions = {}) {
  if (loopTimer !== null) {
    return;
  }

  void playAlertSoundFor(playMs).then((result) => {
    if (!result.ok && result.error) {
      onError?.(result.error);
    }
  });
  loopTimer = window.setInterval(() => {
    void playAlertSoundFor(playMs).then((result) => {
      if (!result.ok && result.error) {
        onError?.(result.error);
      }
    });
  }, intervalMs);
}

export function stopAlertSoundLoop() {
  if (loopTimer !== null) {
    window.clearInterval(loopTimer);
    loopTimer = null;
  }
  stopAlertSound();
}

function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextClass = audioWindow.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }
  if (!audioContext) {
    audioContext = new AudioContextClass();
  }
  return audioContext;
}
