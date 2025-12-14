// Audio (implemented from scratch)
// - BGM uses bundled mp3 (assets/arcade-music.mp3)
// - SFX are synthesized via WebAudio to avoid extra assets/license issues
//
// Mobile autoplay note:
// - Audio will start only after the first user gesture (touch/click/keydown).

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function makeAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  try { return new AudioCtx(); } catch { return null; }
}

export function createAudio({ musicUrl } = {}) {
  let ctx = null;
  let master = null;
  let bgm = null;

  let started = false;
  let muted = false;

  const cfg = {
    musicVol: 0.35,
    sfxVol: 0.90,
  };

  function ensureGraph() {
    if (ctx && master) return true;
    ctx = makeAudioContext();
    if (!ctx) return false;
    master = ctx.createGain();
    master.gain.value = cfg.sfxVol;
    master.connect(ctx.destination);
    return true;
  }

  function resumeCtx() {
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  function ensureBgm() {
    if (bgm || !musicUrl) return;
    bgm = new Audio(musicUrl);
    bgm.loop = true;
    bgm.preload = "auto";
    bgm.volume = muted ? 0 : cfg.musicVol;
    // Same-origin on GH Pages, but keep safe:
    try { bgm.crossOrigin = "anonymous"; } catch {}
  }

  function gestureStart() {
    // Always try to (re)start audio on any user gesture.
    // Some mobile browsers may reject the first play() even on a gesture; retrying fixes "music only after restart".
    ensureGraph();
    resumeCtx();
    ensureBgm();
    if (bgm && !muted) {
      try {
        // If it was blocked earlier, bgm may still be paused.
        if (bgm.paused) {
          const p = bgm.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      } catch {}
    }
    started = true;
  }

  function setMuted(next) {
    muted = !!next;
    if (bgm) bgm.volume = muted ? 0 : cfg.musicVol;
    if (master) master.gain.value = muted ? 0 : cfg.sfxVol;
  }

  function toggleMuted() {
    setMuted(!muted);
    if (!muted) gestureStart();
    return muted;
  }

  function beep({ f1 = 440, f2 = null, dur = 0.06, type = "sine", gain = 0.12, delay = 0 } = {}) {
    if (muted) return;
    if (!ensureGraph()) return;
    resumeCtx();

    const t0 = ctx.currentTime + Math.max(0, delay);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;

    const amp = clamp(gain, 0.0, 1.0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    o.frequency.setValueAtTime(Math.max(20, f1), t0);
    if (f2 !== null) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t0 + dur);
    }

    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  function sfx(name) {
    // Ignore SFX until the first user gesture has started audio
    if (!started) return;
    if (muted) return;

    switch (name) {
      case "move":
        beep({ f1: 760, f2: 680, dur: 0.035, type: "square", gain: 0.06 });
        break;
      case "rotate":
        beep({ f1: 980, f2: 1120, dur: 0.05, type: "triangle", gain: 0.08 });
        break;
      case "soft":
        beep({ f1: 320, f2: 280, dur: 0.03, type: "sine", gain: 0.05 });
        break;
      case "hard":
        beep({ f1: 140, f2: 60, dur: 0.12, type: "sawtooth", gain: 0.12 });
        break;
      case "clear":
        beep({ f1: 620, f2: 780, dur: 0.08, type: "triangle", gain: 0.08, delay: 0.00 });
        beep({ f1: 780, f2: 920, dur: 0.08, type: "triangle", gain: 0.08, delay: 0.06 });
        beep({ f1: 920, f2: 1180, dur: 0.10, type: "triangle", gain: 0.08, delay: 0.12 });
        break;
      case "attackSend":
        beep({ f1: 520, f2: 220, dur: 0.14, type: "sawtooth", gain: 0.07 });
        break;
      case "attackHit":
        beep({ f1: 220, f2: 120, dur: 0.20, type: "square", gain: 0.14 });
        break;
      case "win":
        beep({ f1: 440, f2: 660, dur: 0.18, type: "triangle", gain: 0.09, delay: 0.00 });
        beep({ f1: 550, f2: 880, dur: 0.18, type: "triangle", gain: 0.09, delay: 0.07 });
        beep({ f1: 660, f2: 990, dur: 0.22, type: "triangle", gain: 0.09, delay: 0.14 });
        break;
      case "lose":
        beep({ f1: 220, f2: 110, dur: 0.35, type: "triangle", gain: 0.12 });
        break;
      default:
        break;
    }
  }

  return {
    gestureStart,
    sfx,
    setMuted,
    toggleMuted,
    get muted() { return muted; },
  };
}
