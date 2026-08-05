/**
 * Rules engine + scoring — brief 5.3 Steps 4–6.
 *
 * Faithful port of the mobile app's on-device scoring engine
 * (Repcheck/src/services/poseAnalysis.ts) so backend scores match the app
 * byte-for-byte for the same landmarks.
 *
 * Per frame:
 *   - Step 4: joint angles (knee: hip→knee→ankle, hip: shoulder→hip→knee,
 *     spine: shoulder–hip vs vertical, elbow: shoulder→elbow→wrist,
 *     ankle dorsiflexion approximated by lean of the shin).
 *   - Step 5: rules engine — each exercise defines per-category metrics and
 *     ideal ranges; percentiles (p10/p90) make the scores robust to outliers.
 *   - Step 6: every category is scored 0–100 and reps are detected from the
 *     primary-angle cycle, with confidence-weighted per-rep scoring.
 */

// ── Landmark indices (MediaPipe 33-point) ──────────────────────────────
const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT: 29,
  RIGHT_FOOT: 30,
};

const MIN_VISIBILITY = 0.3;

/** Joints each exercise's scoring needs (must be visible for a usable frame). */
const REQUIRED_JOINTS = {
  squat: ['shoulder', 'hip', 'knee', 'ankle'],
  deadlift: ['shoulder', 'hip', 'knee', 'ankle'],
  bench: ['shoulder', 'elbow', 'wrist', 'hip'],
  ohp: ['shoulder', 'elbow', 'wrist', 'hip'],
  pushup: ['shoulder', 'elbow', 'wrist', 'hip'],
  pullup: ['shoulder', 'elbow', 'wrist', 'hip'],
  lunge: ['shoulder', 'hip', 'knee', 'ankle'],
  rdl: ['shoulder', 'hip', 'knee', 'ankle'],
};
const DEFAULT_REQUIRED = REQUIRED_JOINTS.squat;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Interior angle at point b, degrees (0–180). */
function angleDeg(a, b, c) {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const dot = abx * cbx + aby * cby;
  const ma = Math.hypot(abx, aby);
  const mb = Math.hypot(cbx, cby);
  if (ma === 0 || mb === 0) return 180;
  const cos = Math.max(-1, Math.min(1, dot / (ma * mb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Angle of segment a→b from vertical (0 = perfectly upright). */
function leanFromVertical(a, b) {
  return Math.abs((Math.atan2(a.x - b.x, -(a.y - b.y)) * 180) / Math.PI);
}

/** Linear-interpolated percentile of a numeric series. */
function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const p10 = xs => percentile(xs, 10);
const p90 = xs => percentile(xs, 90);

/** Mean absolute change between consecutive frames. */
function meanDelta(series) {
  const vals = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] != null && series[i] != null) {
      vals.push(Math.abs(series[i] - series[i - 1]));
    }
  }
  return mean(vals);
}

/** Build the best side-on view (left vs right) of the detected person. */
function sideOf(lms, required) {
  const mk = idx => {
    const lm = lms[idx];
    return lm && lm.visibility >= MIN_VISIBILITY ? {lm, vis: lm.visibility} : {lm: null, vis: 0};
  };
  const build = (sIdx, eIdx, wIdx, hIdx, kIdx, aIdx) => {
    const joints = {
      shoulder: mk(sIdx),
      elbow: mk(eIdx),
      wrist: mk(wIdx),
      hip: mk(hIdx),
      knee: mk(kIdx),
      ankle: mk(aIdx),
    };
    if (required.some(k => !joints[k].lm)) return null;
    const visibility = required.reduce((sum, k) => sum + joints[k].vis, 0);
    if (visibility < 1.2) return null;
    return {
      shoulder: joints.shoulder.lm,
      elbow: joints.elbow.lm,
      wrist: joints.wrist.lm,
      hip: joints.hip.lm,
      knee: joints.knee.lm,
      ankle: joints.ankle.lm,
      visibility,
    };
  };
  const L = build(LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST, LM.LEFT_HIP, LM.LEFT_KNEE, LM.LEFT_ANKLE);
  const R = build(LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST, LM.RIGHT_HIP, LM.RIGHT_KNEE, LM.RIGHT_ANKLE);
  if (!L && !R) return null;
  if (!L) return R;
  if (!R) return L;
  return L.visibility >= R.visibility ? L : R;
}

/**
 * Visibility-weighted temporal smoothing over ±1 frame. Kills per-frame pose
 * jitter before angles are computed; the center frame is weighted 2×.
 */
function smoothLandmarks(raw, i, window) {
  const samples = [];
  for (let j = Math.max(0, i - window); j <= Math.min(raw.length - 1, i + window); j++) {
    const lms = raw[j];
    if (!lms || lms.length < 33) continue;
    const vis = lms.reduce((a, l) => a + l.visibility, 0) / lms.length;
    const w = vis * (j === i ? 2 : 1);
    if (w > 0) samples.push({lms, w});
  }
  if (!samples.length) return null;
  const totalW = samples.reduce((a, s) => a + s.w, 0);
  const out = new Array(33);
  for (let k = 0; k < 33; k++) {
    let x = 0, y = 0, z = 0, v = 0;
    for (const s of samples) {
      x += s.lms[k].x * s.w;
      y += s.lms[k].y * s.w;
      z += s.lms[k].z * s.w;
      v += s.lms[k].visibility * s.w;
    }
    out[k] = {x: x / totalW, y: y / totalW, z: z / totalW, visibility: v / totalW};
  }
  return out;
}

/** Local minima below the mid-range of an angle series = rep bottoms. */
function findValleys(series, minSpacing) {
  const vals = series.filter(v => v != null);
  if (vals.length < 6) return [];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo;
  if (range < 15) return [];
  const mid = lo + range * 0.45;
  const valleys = [];
  for (let i = 1; i < series.length - 1; i++) {
    const v = series[i], p = series[i - 1], n = series[i + 1];
    if (v == null || p == null || n == null) continue;
    if (v <= mid && v <= p && v <= n) {
      if (valleys.length === 0 || i - valleys[valleys.length - 1] >= minSpacing) {
        valleys.push(i);
      }
    }
  }
  return valleys;
}

/** Split the series into per-rep segments bounded at valley midpoints. */
function repSegments(valleys, length) {
  if (!valleys.length) return [];
  const boundaries = [0];
  for (let i = 0; i < valleys.length - 1; i++) {
    boundaries.push(Math.floor((valleys[i] + valleys[i + 1]) / 2) + 1);
  }
  boundaries.push(length);
  const segments = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start >= 2) segments.push({start, end});
  }
  return segments;
}

// ── Exercise scorers (rules engine, ported from the app) ───────────────
const SCORERS = [
  {
    id: 'squat',
    name: 'Squat',
    emoji: '🏋️',
    topCue: 'Pause for one second in the hole — it will expose any depth or stability issues.',
    nextFocus: 'Slow the descent by 20% and feel your knees track over your toes.',
    metrics: s => ({
      hipAngle: s.shoulder && s.hip && s.knee ? angleDeg(s.shoulder, s.hip, s.knee) : undefined,
      kneeAngle: s.hip && s.knee && s.ankle ? angleDeg(s.hip, s.knee, s.ankle) : undefined,
      backLean: s.shoulder && s.hip ? leanFromVertical(s.shoulder, s.hip) : undefined,
      kneeOffset: s.knee && s.ankle ? s.knee.x - s.ankle.x : undefined,
      hipX: s.hip?.x,
    }),
    repAngle: m => m.kneeAngle,
    categories: [
      {
        name: 'Depth',
        cue: 'Get hip crease below the knee on every rep.',
        score: m => clamp(Math.round(((140 - p10(m.map(x => x.hipAngle ?? 180))) * 100) / 75), 15, 100),
      },
      {
        name: 'Back Position',
        cue: 'Keep the chest proud — no rounding at the bottom.',
        score: m => {
          const bottom = m.filter(x => x.hipAngle != null && x.hipAngle < 120);
          const lean = mean(bottom.map(x => x.backLean ?? 0));
          return clamp(Math.round(100 - Math.abs(lean - 28) * 2.4), 15, 100);
        },
      },
      {
        name: 'Knee Tracking',
        cue: 'Push the knees out and track them over the toes.',
        score: m => {
          const off = mean(m.map(x => Math.abs(x.kneeOffset ?? 0)));
          return clamp(Math.round(100 - off * 700), 15, 100);
        },
      },
      {
        name: 'Tempo',
        cue: 'Control the descent and don’t bounce out of the hole.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.kneeAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Core Stability',
        cue: 'Brace hard before every rep and hold the brace.',
        score: m => {
          const xs = m.map(x => x.hipX ?? 0);
          const range = xs.length ? p90(xs) - p10(xs) : 0;
          return clamp(Math.round(100 - (range - 0.04) * 600), 15, 100);
        },
      },
    ],
  },
  {
    id: 'deadlift',
    name: 'Deadlift',
    emoji: '⚡',
    topCue: 'Set your back before every rep — pull the slack out of the bar first.',
    nextFocus: 'Cue hips back and shins to the bar during the setup.',
    metrics: s => ({
      hipAngle: s.shoulder && s.hip && s.knee ? angleDeg(s.shoulder, s.hip, s.knee) : undefined,
      kneeAngle: s.hip && s.knee && s.ankle ? angleDeg(s.hip, s.knee, s.ankle) : undefined,
      torsoLean: s.shoulder && s.hip ? 90 - leanFromVertical(s.shoulder, s.hip) : undefined,
      kneeOffset: s.knee && s.ankle ? s.knee.x - s.ankle.x : undefined,
    }),
    repAngle: m => m.hipAngle,
    categories: [
      {
        name: 'Setup',
        cue: 'Hips back, shins close to the bar, chest up.',
        score: m => {
          const start = m.slice(0, Math.max(2, Math.ceil(m.length * 0.3)));
          return clamp(Math.round(100 - Math.abs(mean(start.map(x => x.hipAngle ?? 180)) - 115) * 1.8), 15, 100);
        },
      },
      {
        name: 'Back Position',
        cue: 'Flat back throughout — no rounding under load.',
        score: m => {
          const first = m.slice(0, Math.ceil(m.length / 2));
          return clamp(Math.round(100 - Math.abs(mean(first.map(x => x.torsoLean ?? 0)) - 40) * 2), 15, 100);
        },
      },
      {
        name: 'Knee Position',
        cue: 'Keep the bar dragging against your legs.',
        score: m => {
          const start = m.slice(0, Math.max(2, Math.ceil(m.length * 0.3)));
          const off = mean(start.map(x => Math.abs(x.kneeOffset ?? 0)));
          return clamp(Math.round(100 - off * 800), 15, 100);
        },
      },
      {
        name: 'Hip Hinge',
        cue: 'Finish the lockout by squeezing the glutes.',
        score: m => clamp(Math.round((p90(m.map(x => x.kneeAngle ?? 0)) - 130) * 2.2), 15, 100),
      },
      {
        name: 'Tempo',
        cue: 'Pull the slack out before you break the floor.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.kneeAngle)) - 18) * 2.5), 15, 100),
      },
    ],
  },
  {
    id: 'bench',
    name: 'Bench Press',
    emoji: '💪',
    topCue: 'Set your shoulder blades before every set — bench on a stable platform.',
    nextFocus: 'Press the bar in a slight arc back toward the rack.',
    metrics: s => ({
      elbowAngle: s.shoulder && s.elbow && s.wrist ? angleDeg(s.shoulder, s.elbow, s.wrist) : undefined,
      flareAngle: s.elbow && s.shoulder && s.hip ? angleDeg(s.elbow, s.shoulder, s.hip) : undefined,
      torsoLean: s.shoulder && s.hip ? 90 - leanFromVertical(s.shoulder, s.hip) : undefined,
      wristX: s.wrist?.x,
    }),
    repAngle: m => m.elbowAngle,
    categories: [
      {
        name: 'Setup',
        cue: 'Shoulder blades pinned and slight arch.',
        score: m => {
          const lean = mean(m.map(x => x.torsoLean ?? 0));
          return clamp(Math.round(100 - Math.abs(lean - 80) * 2.5), 15, 100);
        },
      },
      {
        name: 'Grip',
        cue: 'Grip the bar hard — knuckles stacked over wrists.',
        score: m => {
          const bottom = p10(m.map(x => x.elbowAngle ?? 180));
          return clamp(Math.round(100 - Math.abs(bottom - 95) * 1.3), 15, 100);
        },
      },
      {
        name: 'Bar Path',
        cue: 'Touch lower chest, press back toward the rack.',
        score: m => {
          const xs = m.map(x => x.wristX ?? 0);
          const range = xs.length ? p90(xs) - p10(xs) : 0;
          return clamp(Math.round(100 - (range - 0.03) * 700), 15, 100);
        },
      },
      {
        name: 'Tempo',
        cue: 'Control the descent — no bouncing off the chest.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.elbowAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Shoulder Position',
        cue: 'Keep elbows ~45° from your torso, not flared.',
        score: m => {
          const flare = mean(m.map(x => x.flareAngle ?? 0));
          return clamp(Math.round(100 - Math.abs(flare - 45) * 2), 15, 100);
        },
      },
    ],
  },
  {
    id: 'ohp',
    name: 'Overhead Press',
    emoji: '🔥',
    topCue: 'Squeeze your glutes and brace — no leaning back to press.',
    nextFocus: 'Pull the bar to the front of your shoulders and press in a straight line.',
    metrics: s => ({
      elbowAngle: s.shoulder && s.elbow && s.wrist ? angleDeg(s.shoulder, s.elbow, s.wrist) : undefined,
      forearmLean: s.elbow && s.wrist ? leanFromVertical(s.elbow, s.wrist) : undefined,
      torsoLean: s.shoulder && s.hip ? 90 - leanFromVertical(s.shoulder, s.hip) : undefined,
      wristAboveShoulder: s.wrist && s.shoulder ? s.wrist.y < s.shoulder.y : undefined,
    }),
    repAngle: m => m.elbowAngle,
    categories: [
      {
        name: 'Setup',
        cue: 'Bar on the front of the shoulders, forearms vertical.',
        score: m => {
          const lean = mean(m.map(x => x.forearmLean ?? 0));
          return clamp(Math.round(100 - lean * 2.5), 15, 100);
        },
      },
      {
        name: 'Core Stability',
        cue: 'Glutes and abs braced to protect the lower back.',
        score: m => clamp(Math.round(100 - p90(m.map(x => x.torsoLean ?? 0)) * 3), 15, 100),
      },
      {
        name: 'Bar Path',
        cue: 'Press the bar straight up — head through at lockout.',
        score: m => {
          const frac = m.length ? m.filter(x => x.wristAboveShoulder).length / m.length : 0;
          return clamp(Math.round(frac * 120), 20, 100);
        },
      },
      {
        name: 'Tempo',
        cue: 'No leg drive — this is a strict press.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.elbowAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Lockout',
        cue: 'Full lockout overhead with biceps by the ears.',
        score: m => clamp(Math.round((p90(m.map(x => x.elbowAngle ?? 0)) - 130) * 2.2), 15, 100),
      },
    ],
  },
  {
    id: 'pushup',
    name: 'Push Up',
    emoji: '🙌',
    topCue: 'Keep a straight line from head to heels — brace the core like a plank.',
    nextFocus: 'Slow the descent and touch the chest to the floor before pressing back.',
    metrics: s => ({
      elbowAngle: s.shoulder && s.elbow && s.wrist ? angleDeg(s.shoulder, s.elbow, s.wrist) : undefined,
      torsoLean: s.shoulder && s.hip ? 90 - leanFromVertical(s.shoulder, s.hip) : undefined,
      hipDrop: s.shoulder && s.hip ? s.hip.y - s.shoulder.y : undefined,
      flareAngle: s.elbow && s.shoulder && s.hip ? angleDeg(s.elbow, s.shoulder, s.hip) : undefined,
    }),
    repAngle: m => m.elbowAngle,
    categories: [
      {
        name: 'Depth',
        cue: 'Lower the chest until the elbows reach ~90°.',
        score: m => clamp(Math.round(100 - Math.abs((p10(m.map(x => x.elbowAngle ?? 180)) - 95) * 1.2)), 15, 100),
      },
      {
        name: 'Body Line',
        cue: 'Straight plank line — no sagging hips or piking.',
        score: m =>
          clamp(
            Math.round(
              100 - Math.abs(mean(m.map(x => x.torsoLean ?? 0))) * 3 - Math.abs(mean(m.map(x => x.hipDrop ?? 0))) * 300,
            ),
            15,
            100,
          ),
      },
      {
        name: 'Elbow Position',
        cue: 'Elbows ~45° from the torso — don’t flare them wide.',
        score: m => clamp(Math.round(100 - Math.abs(mean(m.map(x => x.flareAngle ?? 0)) - 40) * 2), 15, 100),
      },
      {
        name: 'Tempo',
        cue: 'Control the descent — no bouncing off the floor.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.elbowAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Core Stability',
        cue: 'Brace hard — the body should move as one unit.',
        score: m => {
          const drops = m.map(x => Math.abs(x.hipDrop ?? 0));
          const range = drops.length ? p90(drops) - p10(drops) : 0;
          return clamp(Math.round(100 - (range - 0.02) * 900), 15, 100);
        },
      },
    ],
  },
  {
    id: 'pullup',
    name: 'Pull Up',
    emoji: '🧗',
    topCue: 'Pull the chest to the bar — no kipping or leg swing.',
    nextFocus: 'Start from a dead hang and pull with the lats, not momentum.',
    metrics: s => ({
      elbowAngle: s.shoulder && s.elbow && s.wrist ? angleDeg(s.shoulder, s.elbow, s.wrist) : undefined,
      wristAboveShoulder: s.wrist && s.shoulder ? s.wrist.y < s.shoulder.y : undefined,
      torsoLean: s.shoulder && s.hip ? leanFromVertical(s.shoulder, s.hip) : undefined,
      shoulderX: s.shoulder?.x,
    }),
    repAngle: m => m.elbowAngle,
    categories: [
      {
        name: 'Range',
        cue: 'Chin over the bar at the top of every rep.',
        score: m => {
          const frac = m.length ? m.filter(x => x.wristAboveShoulder).length / m.length : 0;
          return clamp(Math.round(frac * 120), 20, 100);
        },
      },
      {
        name: 'Lockout',
        cue: 'Full extension at the bottom — no half reps.',
        score: m => clamp(Math.round(100 - Math.abs((p90(m.map(x => x.elbowAngle ?? 0)) - 168) * 2.5)), 15, 100),
      },
      {
        name: 'Body Position',
        cue: 'Minimal kip — keep the torso from swinging.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.torsoLean ?? 0)) - 6) * 8), 15, 100),
      },
      {
        name: 'Tempo',
        cue: 'Lower under control — no dropping from the bar.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.elbowAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Stability',
        cue: 'Quiet legs — no crossing, kicking, or swinging.',
        score: m => {
          const xs = m.map(x => x.shoulderX ?? 0);
          const range = xs.length ? p90(xs) - p10(xs) : 0;
          return clamp(Math.round(100 - (range - 0.03) * 800), 15, 100);
        },
      },
    ],
  },
  {
    id: 'lunge',
    name: 'Lunge',
    emoji: '🦵',
    topCue: 'Step out and drop the back knee straight down — torso tall.',
    nextFocus: 'Push through the front heel to return to standing.',
    metrics: s => ({
      kneeAngle: s.hip && s.knee && s.ankle ? angleDeg(s.hip, s.knee, s.ankle) : undefined,
      hipAngle: s.shoulder && s.hip && s.knee ? angleDeg(s.shoulder, s.hip, s.knee) : undefined,
      backLean: s.shoulder && s.hip ? leanFromVertical(s.shoulder, s.hip) : undefined,
      kneeOffset: s.knee && s.ankle ? s.knee.x - s.ankle.x : undefined,
      hipX: s.hip?.x,
    }),
    repAngle: m => m.kneeAngle,
    categories: [
      {
        name: 'Depth',
        cue: 'Front thigh parallel — back knee just off the floor.',
        score: m => clamp(Math.round(100 - Math.abs((p10(m.map(x => x.kneeAngle ?? 180)) - 95) * 1.2)), 15, 100),
      },
      {
        name: 'Back Position',
        cue: 'Stay tall — no folding forward at the waist.',
        score: m => clamp(Math.round(100 - Math.abs(mean(m.map(x => x.backLean ?? 0)) - 8) * 2.2), 15, 100),
      },
      {
        name: 'Knee Tracking',
        cue: 'Front knee tracks over the toes — no caving inward.',
        score: m => {
          const off = mean(m.map(x => Math.abs(x.kneeOffset ?? 0)));
          return clamp(Math.round(100 - off * 600), 15, 100);
        },
      },
      {
        name: 'Tempo',
        cue: 'Controlled descent — no bouncing out of the bottom.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.kneeAngle)) - 18) * 2.5), 15, 100),
      },
      {
        name: 'Balance',
        cue: 'Stable pelvis — minimal hip sway side to side.',
        score: m => {
          const xs = m.map(x => x.hipX ?? 0);
          const range = xs.length ? p90(xs) - p10(xs) : 0;
          return clamp(Math.round(100 - (range - 0.04) * 700), 15, 100);
        },
      },
    ],
  },
  {
    id: 'rdl',
    name: 'Romanian Deadlift',
    emoji: '🍑',
    topCue: 'Push the hips back and let the bar slide down the thighs — soft knees.',
    nextFocus: 'Feel the hamstring stretch, then drive the hips forward to lockout.',
    metrics: s => ({
      hipAngle: s.shoulder && s.hip && s.knee ? angleDeg(s.shoulder, s.hip, s.knee) : undefined,
      torsoLean: s.shoulder && s.hip ? 90 - leanFromVertical(s.shoulder, s.hip) : undefined,
      kneeAngle: s.hip && s.knee && s.ankle ? angleDeg(s.hip, s.knee, s.ankle) : undefined,
      kneeOffset: s.knee && s.ankle ? s.knee.x - s.ankle.x : undefined,
    }),
    repAngle: m => m.hipAngle,
    categories: [
      {
        name: 'Hip Hinge',
        cue: 'Push the hips back — don’t squat the bar down.',
        score: m => clamp(Math.round(100 - Math.abs((p10(m.map(x => x.hipAngle ?? 180)) - 80) * 1.4)), 15, 100),
      },
      {
        name: 'Back Position',
        cue: 'Flat back throughout — no rounding under load.',
        score: m => {
          const bottom = m.filter(x => x.hipAngle != null && x.hipAngle < 120);
          const lean = mean(bottom.map(x => x.torsoLean ?? 0));
          return clamp(Math.round(100 - Math.abs(lean - 15) * 2), 15, 100);
        },
      },
      {
        name: 'Bar Path',
        cue: 'Bar stays close to the legs — drag along the thighs.',
        score: m => {
          const off = mean(m.map(x => Math.abs(x.kneeOffset ?? 0)));
          return clamp(Math.round(100 - off * 700), 15, 100);
        },
      },
      {
        name: 'Knee Bend',
        cue: 'Soft knees (~15° flex) — lock them out with the hips.',
        score: m => clamp(Math.round(100 - Math.abs(mean(m.map(x => x.kneeAngle ?? 180)) - 165) * 1.5), 15, 100),
      },
      {
        name: 'Tempo',
        cue: 'Control the eccentric — feel the hamstrings stretch.',
        score: m => clamp(Math.round(100 - (meanDelta(m.map(x => x.hipAngle)) - 18) * 2.5), 15, 100),
      },
    ],
  },
];

/** Canonical exercise id list — the source of truth for the API. */
export const EXERCISE_IDS = SCORERS.map(s => s.id);

// ── Public entry point (brief Steps 4–6) ───────────────────────────────
/**
 * Score a set of landmarked frames.
 *
 * @param {string} exerciseId one of the 8 exercise ids
 * @param {{path: string, timeMs: number, landmarks: any[]}[]} frames
 * @param {(jpegPath: string) => Promise<any[]>} detectFn  pose engine detect
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<object|null>} null when no usable pose was found
 */
export async function scoreFrames(exerciseId, frames, detectFn, onProgress) {
  const scorer = SCORERS.find(s => s.id === exerciseId) ?? SCORERS[0];
  const required = REQUIRED_JOINTS[scorer.id] ?? DEFAULT_REQUIRED;
  const total = Math.max(1, frames.length);

  // Pass 1 — detect every frame (smoothing needs neighbours).
  const raw = [];
  for (let i = 0; i < frames.length; i++) {
    raw[i] = await detectFn(frames[i].path);
    onProgress?.(i + 1, total);
  }

  // Pass 2 — smooth landmarks, build the side view + metrics.
  const poseFrames = [];
  const metricsPerFrame = [];
  for (let i = 0; i < frames.length; i++) {
    const smoothed = smoothLandmarks(raw, i, 1);
    if (!smoothed) continue;
    const side = sideOf(smoothed, required);
    if (!side) continue;
    const avgVisibility = side.visibility / required.length;
    poseFrames.push({path: frames[i].path, timeMs: frames[i].timeMs, landmarks: smoothed, avgVisibility});
    metricsPerFrame.push({...scorer.metrics(side), vis: avgVisibility});
  }

  if (metricsPerFrame.length === 0) return null;

  // Rep detection — score each rep independently when a clear cycle exists.
  const series = metricsPerFrame.map(m => scorer.repAngle(m));
  const minSpacing = Math.max(3, Math.round(metricsPerFrame.length * 0.12));
  const segments = repSegments(findValleys(series, minSpacing), metricsPerFrame.length);

  let categories;
  let repCount = 0;
  let repScores = null;

  if (segments.length >= 2) {
    const perRep = segments.map(seg => {
      const segMetrics = metricsPerFrame.slice(seg.start, seg.end);
      const weight = mean(segMetrics.map(x => x.vis ?? 0)) + 1e-6;
      return {scores: scorer.categories.map(c => c.score(segMetrics)), weight};
    });
    repCount = perRep.length;
    repScores = perRep.map(r => clamp(Math.round(mean(r.scores)), 0, 100));
    categories = scorer.categories.map((c, ci) => {
      const num = perRep.reduce((acc, r) => acc + r.scores[ci] * r.weight, 0);
      const den = perRep.reduce((acc, r) => acc + r.weight, 0);
      return {name: c.name, score: clamp(Math.round(num / Math.max(den, 1e-6)), 0, 100)};
    });
  } else {
    categories = scorer.categories.map(c => ({name: c.name, score: c.score(metricsPerFrame)}));
    if (segments.length === 1) {
      repCount = 1;
      repScores = [clamp(Math.round(mean(categories.map(c => c.score))), 0, 100)];
    }
  }

  const score = clamp(Math.round(categories.reduce((sum, c) => sum + c.score, 0) / categories.length), 0, 100);

  const sorted = [...categories].sort((a, b) => a.score - b.score);
  const weakest = sorted.slice(0, 2);
  const strongest = sorted[sorted.length - 1];
  const cueOf = name => scorer.categories.find(c => c.name === name)?.cue ?? '';

  return {
    result: {
      exerciseId: scorer.id,
      exerciseName: scorer.name,
      score,
      grade: score >= 85 ? 'Excellent Form' : score >= 65 ? 'Good Form' : score >= 50 ? 'Fair Form' : 'Needs Work',
      risk: score >= 75 ? 'low' : score >= 60 ? 'medium' : 'high',
      cue: scorer.topCue,
      categories,
      feedback: [
        ...weakest.map(w => ({emoji: scorer.emoji, text: `${w.name}: ${cueOf(w.name)}`})),
        {
          emoji: '💪',
          text: `Strong ${strongest.name.toLowerCase()} work — keep it up and re-test next session.`,
        },
        // 4th item (brief: "4 PT feedback items") — rep consistency, or a
        // model-tracking line when there are no per-rep scores.
        {
          emoji: '📈',
          text:
            repScores && repScores.length > 1
              ? `Rep consistency: your ${repScores.length} reps scored ${Math.min(...repScores)}–${Math.max(...repScores)} (avg ${Math.round(mean(repScores))}).`
              : `Model tracked ${poseFrames.length}/${frames.length} frames at ${Math.round(mean(metricsPerFrame.map(x => x.vis ?? 0)) * 100)}% visibility.`,
        },
      ],
      nextFocus: scorer.nextFocus,
      engine: 'ai',
    },
    // Per-frame smoothed landmarks (usable frames only) — the annotated-video
    // renderer draws these onto the frames (testing-only feature).
    poseFrames,
    repCount,
    repScores,
    frameStats: {
      usable: poseFrames.length,
      total: frames.length,
      avgVisibility: mean(metricsPerFrame.map(x => x.vis ?? 0)),
    },
  };
}
