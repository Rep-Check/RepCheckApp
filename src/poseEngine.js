/**
 * Pose estimation engine — brief 5.3 Step 3.
 *
 * Two backends, selected by POSE_ENGINE env var:
 *
 *  - `movenet` (default): TensorFlow.js MoveNet SINGLEPOSE_LIGHTNING on the
 *    CPU backend. Pure JS — runs in any Node, no WebGL, no native deps.
 *    Returns 17 keypoints which are re-mapped into the MediaPipe 33-slot
 *    layout (the indices the rules engine uses), so scoring is identical
 *    regardless of backend.
 *
 *  - `mediapipe`: the same pose_landmarker_full.task model the mobile app
 *    uses, via @mediapipe/tasks-vision WASM. Requires a working headless
 *    WebGL context in Node (e.g. a build with the `gl` package). On stock
 *    Node (no WebGL) this path cannot run — the WASM glue uploads input
 *    images through WebGL regardless of the CPU delegate. Kept behind the
 *    flag so it can be enabled on infra that provides GL.
 *
 * Both return {x, y, z, visibility} arrays in the MediaPipe 33-index layout.
 */
import {createCanvas} from '@napi-rs/canvas';

// ── Backend selection ────────────────────────────────────────────────────
const ENGINE = (process.env.POSE_ENGINE ?? 'movenet').toLowerCase();
export const poseEngineName = ENGINE;

// ── MediaPipe WASM backend (opt-in) ─────────────────────────────────────
let mediapipeDetect = null;
async function getMediapipeDetect() {
  // Lazy require so the default (movenet) path never loads the WASM bundle.
  const {withMockGL} = await import('./nodeShim.js');
  const {FilesetResolver, PoseLandmarker} = await import('@mediapipe/tasks-vision');
  const {readFile} = await import('node:fs/promises');
  const {fileURLToPath} = await import('node:url');
  const {config} = await import('./config.js');

  const vision = await FilesetResolver.forVisionTasks(
    fileURLToPath(new URL('../node_modules/@mediapipe/tasks-vision/wasm', import.meta.url)),
  );
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {modelAssetBuffer: await readFile(config.modelPath), delegate: 'CPU'},
    runningMode: 'IMAGE',
    numPoses: 1,
    canvas: withMockGL(createCanvas(1, 1)),
  });
  return canvas => {
    // `detect` (IMAGE mode) — this tasks-vision build exposes `detect`, not
    // `detectForImage`.
    const result = landmarker.detect(canvas);
    const pose = result.landmarks?.[0];
    if (!pose?.length) {
      return [];
    }
    return pose.map(l => ({
      x: l.x,
      y: l.y,
      z: l.z ?? 0,
      visibility: typeof l.visibility === 'number' ? l.visibility : 1,
    }));
  };
}

// ── MoveNet backend (default) ───────────────────────────────────────────
let movenetDetectorPromise = null;
function getMovenetDetector() {
  if (!movenetDetectorPromise) {
    movenetDetectorPromise = (async () => {
      const poseDetection = await import('@tensorflow-models/pose-detection');
      const tf = await import('@tensorflow/tfjs');
      await tf.ready();
      return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
        modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
      });
    })().catch(err => {
      movenetDetectorPromise = null;
      throw err;
    });
  }
  return movenetDetectorPromise;
}

/**
 * MoveNet keypoint index → MediaPipe 33-slot index. Both are 0..n normalized
 * coords; only the indices the rules engine reads matter (the rest stay 0
 * with 0 visibility and never gate a frame).
 */
const MOVENET_TO_MEDIAPIPE = [
  0, // 0 nose         → 0 nose
  -1, // 1 left eye
  -1, // 2 right eye
  -1, // 3 left ear
  -1, // 4 right ear
  11, // 5 left shoulder
  12, // 6 right shoulder
  13, // 7 left elbow
  14, // 8 right elbow
  15, // 9 left wrist
  16, // 10 right wrist
  23, // 11 left hip
  24, // 12 right hip
  25, // 13 left knee
  26, // 14 right knee
  27, // 15 left ankle
  28, // 16 right ankle
];

/** Build the 33-slot MediaPipe layout from MoveNet keypoints. */
function mapMovenet(keypoints) {
  const out = new Array(33);
  for (let i = 0; i < 33; i++) {
    out[i] = {x: 0, y: 0, z: 0, visibility: 0};
  }
  for (let i = 0; i < keypoints.length; i++) {
    const slot = MOVENET_TO_MEDIAPIPE[i];
    if (slot == null || slot < 0) {
      continue;
    }
    const kp = keypoints[i];
    out[slot] = {
      x: kp.x,
      y: kp.y,
      z: 0,
      visibility: typeof kp.score === 'number' ? kp.score : 1,
    };
  }
  return out;
}

/** Decode a JPEG into a 2d canvas (shared input builder). */
async function frameToCanvas(jpegPath) {
  const {loadImage} = await import('@napi-rs/canvas');
  const image = await loadImage(jpegPath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, image.width, image.height);
  return canvas;
}

/**
 * Run pose detection on one frame.
 * @param {string} jpegPath absolute path to a JPEG frame
 * @returns {Promise<{x:number;y:number;z:number;visibility:number}[]>}
 *          empty array when no person is found
 */
export async function detectPose(jpegPath) {
  if (ENGINE === 'mediapipe') {
    if (!mediapipeDetect) {
      mediapipeDetect = await getMediapipeDetect();
    }
    return mediapipeDetect(await frameToCanvas(jpegPath));
  }

  // Default: MoveNet on CPU.
  const detector = await getMovenetDetector();
  const canvas = await frameToCanvas(jpegPath);
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const poses = await detector.estimatePoses({data, width: img.width, height: img.height});
  if (!poses?.length || !poses[0]?.keypoints?.length) {
    return [];
  }
  return mapMovenet(poses[0].keypoints);
}
