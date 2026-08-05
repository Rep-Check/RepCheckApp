/**
 * Annotated video — TESTING ONLY (will change later).
 *
 * Draws the detected 33-landmark skeleton over every extracted frame and
 * re-encodes them into an MP4 so you can eyeball exactly what the pose
 * engine saw (joints tracked, rep cycle, body in frame). The annotated
 * video is written to <root>/outputs/ and served at:
 *
 *   GET /outputs/annotated-<jobId>.mp4
 *
 * The response JSON includes `annotatedVideoUrl` pointing at it.
 *
 * Frames without a usable pose are still included (no skeleton drawn), so
 * the annotated clip stays in sync with the original video timeline.
 */
import {spawn} from 'node:child_process';
import {mkdir, rm, writeFile, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import ffmpegPath from 'ffmpeg-static';
import {ROOT_DIR} from './config.js';

export const OUTPUT_DIR = path.join(ROOT_DIR, 'outputs');

/** MediaPipe pose skeleton connections (indices into the 33-landmark layout). */
const POSE_PAIRS = [
  [11, 12], // shoulders
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  [11, 23], [12, 24], // torso
  [23, 24], // hips
  [23, 25], [25, 27], [27, 29], [29, 31], // left leg
  [24, 26], [26, 28], [28, 30], [30, 32], // right leg
];

const MIN_VIS = 0.3;

/**
 * Read the source video's fps from ffmpeg's probe output (fast, no full
 * decode). Falls back to 30 when it can't be determined.
 */
function probeFps(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', videoPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    proc.stderr.on('data', d => (err += d));
    proc.on('error', reject); // a spawn failure must reject, not hang
    proc.on('close', () => {
      const m = err.match(/(\d+(?:\.\d+)?)\s*fps/);
      resolve(m ? Number(m[1]) : 30);
    });
  });
}

/** Draw the skeleton for one frame's landmarks onto a canvas. */
function drawSkeleton(ctx, width, height, landmarks) {
  if (!landmarks?.length) {
    return;
  }

  // Detect coordinate system: MoveNet returns pixel coords (e.g. x=756),
  // MediaPipe returns normalized coords (0..1).  If the first landmark with
  // a non-zero x has x > 1, treat all values as pixels.
  const first = landmarks.find(l => l && l.x != null && l.x !== 0);
  const isPixel = first ? first.x > 1 || first.y > 1 : false;

  const px = (lm, axis) => (axis === 'x' ? (isPixel ? lm.x : lm.x * width) : (isPixel ? lm.y : lm.y * height));
  const stroke = Math.max(3, Math.round(Math.min(width, height) / 250));

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = stroke;
  for (const [a, b] of POSE_PAIRS) {
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    if (!p1 || !p2 || p1.visibility < MIN_VIS || p2.visibility < MIN_VIS) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(px(p1, 'x'), px(p1, 'y'));
    ctx.lineTo(px(p2, 'x'), px(p2, 'y'));
    ctx.stroke();
  }

  const r = Math.max(3, Math.round(stroke * 1.1));
  for (const lm of landmarks) {
    if (!lm || lm.visibility < MIN_VIS) {
      continue;
    }
    ctx.fillStyle = '#ff3b5c';
    ctx.beginPath();
    ctx.arc(px(lm, 'x'), px(lm, 'y'), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * Render an annotated MP4 for a scored video.
 *
 * @param {object} opts
 * @param {string} opts.videoPath   uploaded source video (for fps probe)
 * @param {string[]} opts.frames    all extracted frame paths, in order
 * @param {{path: string, landmarks: object[]}[]} opts.poseFrames
 *        scored frames (usable ones, with landmarks)
 * @returns {Promise<string>} public URL path like /outputs/annotated-123.mp4
 */
export async function renderAnnotatedVideo({videoPath, frames, poseFrames}) {
  await mkdir(OUTPUT_DIR, {recursive: true});

  const lmsByPath = new Map((poseFrames ?? []).map(f => [f.path, f.landmarks]));
  const jobId = Date.now();
  const workDir = path.join(os.tmpdir(), `rc-annotate-${jobId}`);
  const outName = `annotated-${jobId}.mp4`;
  const outPath = path.join(OUTPUT_DIR, outName);

  try {
    await mkdir(workDir, {recursive: true});

    // Draw each frame → JPEG.
    let i = 0;
    for (const framePath of frames) {
      const image = await loadImage(framePath);
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, image.width, image.height);
      drawSkeleton(ctx, image.width, image.height, lmsByPath.get(framePath));
      const buf = canvas.toBuffer('image/jpeg', 82);
      i += 1;
      await writeFile(path.join(workDir, `frame_${String(i).padStart(5, '0')}.jpg`), buf);
    }

    // Re-encode the annotated frames (every 5th frame extracted → fps/5).
    const fps = await probeFps(videoPath);
    const frameRate = Math.max(1, Math.round(fps / 5));

    await new Promise((resolve, reject) => {
      const proc = spawn(
        ffmpegPath,
        [
          '-y',
          '-framerate', String(frameRate),
          '-i', path.join(workDir, 'frame_%05d.jpg'),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          outPath,
        ],
        {stdio: ['ignore', 'ignore', 'pipe']},
      );
      let err = '';
      proc.stderr.on('data', d => (err += d));
      proc.on('error', reject);
      proc.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg annotate exited ${code}: ${err.slice(-300)}`)),
      );
    });

    return `/outputs/${outName}`;
  } finally {
    // Never leak the temp dir, even when a step above throws.
    await rm(workDir, {recursive: true, force: true}).catch(() => {});
  }
}

/** Remove stale annotated videos (keep only the newest N). */
export async function pruneAnnotatedVideos(keep = 50) {
  const names = (await readdir(OUTPUT_DIR).catch(() => []))
    .filter(n => n.startsWith('annotated-'))
    .sort();
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    await rm(path.join(OUTPUT_DIR, n), {force: true}).catch(() => {});
  }
}
