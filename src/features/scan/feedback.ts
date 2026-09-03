/**
 * §6.1 confirmed-scan feedback: a short beep and a 60 ms vibration. Neither is
 * ever relied upon — the screen change is the primary feedback — so every step
 * fails soft: no AudioContext, a context iOS will not resume, no vibrate
 * support, or a throw must all leave the app working.
 */

/** Around 1 kHz cuts through wind and traffic without being shrill (§6.1). */
const TONE_HZ = 1050;
const TONE_S = 0.1;
const PEAK_GAIN = 0.2;
/** Long enough to kill the click of a gated square wave, short enough to stay crisp. */
const FADE_S = 0.008;
const VIBRATE_MS = 60;

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (ctx !== null && ctx.state !== "closed") return ctx;
  if (typeof window === "undefined") return null;
  const Ctor: AudioContextCtor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (Ctor === undefined) return null;
  // One context for the app's lifetime; a context per scan leaks an audio handle.
  ctx = new Ctor();
  return ctx;
}

function beep(): void {
  try {
    const context = audioContext();
    if (context === null) return;
    // iOS suspends a context created outside a user gesture. If the resume does not land,
    // the tone is silently not heard.
    if (context.state === "suspended") void context.resume().catch(() => undefined);

    const start = context.currentTime;
    const end = start + TONE_S;
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = "square";
    osc.frequency.value = TONE_HZ;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + FADE_S);
    gain.gain.setValueAtTime(PEAK_GAIN, end - FADE_S);
    gain.gain.linearRampToValueAtTime(0, end);
    osc.connect(gain);
    gain.connect(context.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(start);
    osc.stop(end);
  } catch {
    // §6.1: the beep is never relied upon.
  }
}

function vibrate(): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(VIBRATE_MS);
  } catch {
    // §6.1: haptics are never relied upon.
  }
}

export function scanFeedback(settings: { sound: boolean; haptics: boolean }): void {
  if (settings.sound) beep();
  if (settings.haptics) vibrate();
}
