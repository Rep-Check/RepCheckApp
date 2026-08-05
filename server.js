/**
 * RepCheck MediaPipe API — brief 5.3 AI Video Analysis Pipeline.
 *
 * POST /api/v1/analyze   authenticated (Supabase JWT). Body:
 *   {exercise, storagePath, fileName}  — video already uploaded to Supabase
 *   Storage (videos bucket) by the client.
 *   Step 1  Upload (client → Supabase Storage, private bucket)
 *   Step 2  Frame extraction — every 5th frame (ffmpeg-static)
 *   Step 3  Pose estimation — MediaPipe, 33 landmarks per frame
 *   Step 4  Joint angles (knee / hip / spine / elbow / dorsiflexion)
 *   Step 5  Rules engine — angles vs ideal ranges per exercise
 *   Step 6  Scoring — each category 0–100
 *   Step 7  Coaching cues — rules engine + optional Claude
 *   Step 8  Response — JSON with scores, cues, risk flag, next focus
 *   Step 9  Cleanup — video deleted from storage immediately after analysis
 *           (+ 1-hour TTL sweep for abandoned uploads)
 *
 * POST /api/analyze    legacy multipart upload (local/testing only)
 * GET  /health         model availability + uptime
 */
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {mkdir, mkdtemp, readdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from './src/config.js';
import {extractFrames} from './src/extractFrames.js';
import {detectPose, poseEngineName} from './src/poseEngine.js';
import {scoreFrames, EXERCISE_IDS} from './src/scoring.js';
import {buildFeedback} from './src/feedback.js';
import {renderAnnotatedVideo, OUTPUT_DIR, pruneAnnotatedVideos} from './src/annotateVideo.js';
import {
  supabaseConfigured,
  verifyUserToken,
  downloadVideo,
  deleteVideo,
  listStaleVideos,
  saveAnalysis,
  analysisCount,
  getSubscription,
} from './src/supabase.js';
import {capture} from './src/posthog.js';

const app = express();
app.use(cors());
app.use(express.json({limit: '1mb'}));

// Serve the web upload form (testing only).
app.use(express.static('public'));

// Annotated videos (testing only) are served from /outputs.
await mkdir(OUTPUT_DIR, {recursive: true});
app.use('/outputs', express.static(OUTPUT_DIR));

// mkdtemp requires its parent dir to exist — ensure it once at boot, and
// sweep any stale job dirs left by crashed requests or rejected uploads.
await mkdir(config.tempDir, {recursive: true});
for (const name of await readdir(config.tempDir).catch(() => [])) {
  if (name.startsWith('job-')) {
    await rm(path.join(config.tempDir, name), {recursive: true, force: true});
  }
}

// ── Upload (Step 1, legacy multipart) ───────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        const dir = await mkdtemp(path.join(config.tempDir, 'job-'));
        cb(null, dir);
      } catch (err) {
        cb(err, '');
      }
    },
    filename: (_req, file, cb) => cb(null, `video${path.extname(file.originalname || '.mp4')}`),
  }),
  limits: {fileSize: config.maxVideoBytes, files: 1},
  // Testing-only: accept any file type. Non-video files will fail at the
  // ffmpeg extraction step with a clear error message.
  fileFilter: (_req, _file, cb) => cb(null, true),
});

const EXERCISES = EXERCISE_IDS;

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    engine: poseEngineName,
    model: poseEngineName === 'mediapipe' ? 'pose_landmarker_full.task' : 'MoveNet (17 kpts → 33-slot map)',
    anthropic: config.anthropicApiKey ? 'configured' : 'not-configured',
    claudeModel: config.claudeModel,
    supabase: supabaseConfigured ? 'configured' : 'not-configured',
    storageBucket: config.videosBucket,
    uptimeSec: Math.round(process.uptime()),
  });
});

/** Step 9 — best-effort wipe of the job dir. Awaited so callers can be sure. */
async function cleanup(jobDir) {
  if (!jobDir) {
    return;
  }
  try {
    await rm(jobDir, {recursive: true, force: true});
  } catch {
    // Best-effort; a stray tmp dir is harmless.
  }
}

/**
 * Shared pipeline — run the full Steps 2–8 against a local video file.
 * Returns the API payload (or throws with a typed error).
 */
async function runAnalysisPipeline({videoPath, exerciseId, jobDir, fileName}) {
  const started = Date.now();

  // Step 2 — every 5th frame.
  const {paths, count} = await extractFrames(videoPath, jobDir);
  if (count === 0) {
    const err = new Error('No frames could be extracted from the video.');
    err.status = 422;
    err.code = 'no_frames';
    err.framesExtracted = 0;
    throw err;
  }

  // Steps 3–6 — detect + score.
  const frames = paths.map(p => ({path: p, timeMs: 0}));
  const outcome = await scoreFrames(exerciseId, frames, detectPose);
  if (!outcome) {
    const err = new Error('No usable pose found in the video. Film from the side, full body in frame, good lighting.');
    err.status = 422;
    err.code = 'no_pose_detected';
    err.framesExtracted = count;
    throw err;
  }

  // Step 7 — coaching cues.
  const feedback = await buildFeedback(outcome.result);

  return {
    payload: {
      exerciseId: outcome.result.exerciseId,
      exerciseName: outcome.result.exerciseName,
      score: outcome.result.score,
      grade: outcome.result.grade,
      risk: outcome.result.risk,
      cue: outcome.result.cue,
      categories: outcome.result.categories,
      feedback,
      nextFocus: outcome.result.nextFocus,
      framesExtracted: count,
      framesAnalyzed: outcome.frameStats.usable,
      avgVisibility: Number(outcome.frameStats.avgVisibility.toFixed(2)),
      repCount: outcome.repCount,
      repScores: outcome.repScores,
      processingMs: Date.now() - started,
      engine: poseEngineName,
    },
    outcome,
    count,
  };
}

/**
 * POST /api/v1/analyze — the production path.
 * Auth: Supabase JWT in `Authorization: Bearer <token>`.
 * Body: {exercise, storagePath, fileName}.
 * The client uploads the video to Supabase Storage first, then calls us; we
 * download it, analyse, persist the record, and delete the video (Step 9).
 */
app.post('/api/v1/analyze', async (req, res) => {
  if (!supabaseConfigured) {
    return res.status(503).json({
      error: 'supabase_not_configured',
      message: 'This server has no Supabase credentials configured.',
    });
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const user = await verifyUserToken(token);
  if (!user) {
    return res.status(401).json({error: 'unauthorized', message: 'A valid Supabase session token is required.'});
  }
  const userId = user.id;

  const exerciseId = String(req.body?.exercise ?? '').trim();
  const storagePath = String(req.body?.storagePath ?? '').trim();
  const fileName = String(req.body?.fileName ?? 'video.mp4').trim();

  if (!EXERCISES.includes(exerciseId)) {
    return res.status(400).json({error: 'invalid_exercise', message: `exercise must be one of: ${EXERCISES.join(', ')}`});
  }
  if (!storagePath) {
    return res.status(400).json({error: 'invalid_storage_path', message: 'storagePath of the uploaded video is required.'});
  }

  let jobDir = null;
  const startedAt = Date.now();
  capture(userId, 'analysis_started', {exercise: exerciseId});

  try {
    // Quota: 3 free analyses total; Pro is unlimited.
    const [used, sub] = await Promise.all([analysisCount(userId), getSubscription(userId)]);
    if (used >= 3 && !sub) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: 'You have used your 3 free analyses. Upgrade to RepCheck Pro for unlimited analyses.',
        used,
        limit: 3,
      });
    }

    // Download from Supabase Storage into a fresh job dir.
    jobDir = await mkdtemp(path.join(config.tempDir, 'job-'));
    const videoPath = path.join(jobDir, `video${path.extname(fileName) || '.mp4'}`);
    await downloadVideo(storagePath, videoPath);

    const {payload} = await runAnalysisPipeline({videoPath, exerciseId, jobDir, fileName});

    // Persist the analysis row. The id is computed once so the response
    // echoes exactly what was stored — a second Date.now() could differ by a
    // millisecond and duplicate the row on the client.
    const analysisId = `${Date.now()}`;
    await saveAnalysis({
      id: analysisId,
      user_id: userId,
      exercise_id: payload.exerciseId,
      exercise_name: payload.exerciseName,
      score: payload.score,
      grade: payload.grade,
      risk: payload.risk,
      cue: payload.cue,
      categories: payload.categories,
      feedback: payload.feedback,
      next_focus: payload.nextFocus,
      file_name: fileName,
      frame_count: payload.framesExtracted,
      engine: payload.engine,
    });

    // Step 9 — delete the video from storage BEFORE responding.
    await deleteVideo(storagePath);

    capture(userId, 'analysis_completed', {
      exercise: payload.exerciseId,
      score: payload.score,
      risk: payload.risk,
      processingMs: payload.processingMs,
    });

    await cleanup(jobDir);
    jobDir = null;
    res.json({...payload, id: analysisId, date: Date.now()});
  } catch (err) {
    capture(userId, 'analysis_failed', {exercise: exerciseId, error: err.message});
    const status = err.status ?? 500;
    const code = err.code ?? 'analysis_failed';
    const message = err instanceof Error ? err.message : 'Analysis failed.';
    // If we downloaded the video and analysis failed, still clean it up.
    if (storagePath) {
      await deleteVideo(storagePath);
    }
    if (status >= 500) {
      console.error(`analysis error: ${message}`);
    }
    res.status(status).json({error: code, message, ...(err.framesExtracted != null ? {framesExtracted: err.framesExtracted} : {})});
  } finally {
    if (jobDir) {
      await cleanup(jobDir);
    }
    const totalMs = Date.now() - startedAt;
    capture(userId, 'api_analyze_latency', {ms: totalMs});
  }
});

// ── Legacy multipart endpoint (local / testing, no auth) ────────────────
app.post('/api/analyze', upload.single('video'), async (req, res) => {
  const started = Date.now();
  let jobDir = null;

  try {
    const exerciseId = String(req.body?.exercise ?? '').trim();
    if (!EXERCISES.includes(exerciseId)) {
      return res.status(400).json({
        error: 'invalid_exercise',
        message: `exercise must be one of: ${EXERCISES.join(', ')}`,
      });
    }
    if (!req.file) {
      return res.status(400).json({
        error: 'invalid_video',
        message: 'No video file uploaded. Send a video file as the "video" field.',
      });
    }

    jobDir = req.file.destination;

    const {payload, outcome} = await runAnalysisPipeline({
      videoPath: req.file.path,
      exerciseId,
      jobDir,
      fileName: req.file.originalname,
    });

    // Testing-only: annotated video with the pose skeleton drawn on it.
    // Rendered best-effort — if it fails, the analysis still succeeds.
    let annotatedVideoUrl = null;
    try {
      annotatedVideoUrl = await renderAnnotatedVideo({
        videoPath: req.file.path,
        frames: outcome.frames ?? [],
        poseFrames: outcome.poseFrames,
      });
      await pruneAnnotatedVideos();
    } catch (err) {
      console.warn(`annotated video skipped: ${err instanceof Error ? err.message : err}`);
    }

    await cleanup(jobDir);
    jobDir = null;
    res.json({...payload, annotatedVideoUrl, processingMs: Date.now() - started});
  } catch (err) {
    const status = err.status ?? 500;
    const code = err.code ?? 'analysis_failed';
    const message = err instanceof Error ? err.message : 'Analysis failed.';
    res.status(status).json({error: code, message});
  } finally {
    // Safety net for paths that returned early before their own cleanup.
    if (jobDir) {
      await cleanup(jobDir);
    }
  }
});

// Fallback error handler (multer file-size / other route errors).
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({error: 'file_too_large', message: 'Video exceeds the 150MB limit.'});
  }
  const message = err?.message ?? 'Unexpected error.';
  if (/video files are supported/i.test(message)) {
    return res.status(400).json({error: 'invalid_video', message});
  }
  res.status(500).json({error: 'server_error', message});
});

/**
 * 1-hour video TTL sweep — brief: "videos auto-deleted within 1 hour".
 * Runs every VIDEO_SWEEP_MS and deletes any object older than VIDEO_TTL_MS
 * (uploaded but never analysed — e.g. the app quit mid-upload).
 */
async function sweepStaleVideos() {
  if (!supabaseConfigured) {
    return;
  }
  try {
    const stale = await listStaleVideos();
    if (stale.length > 0) {
      console.log(`🧹 deleting ${stale.length} stale video(s) older than 1h`);
      for (const name of stale) {
        await deleteVideo(name);
      }
    }
  } catch (err) {
    console.warn(`video TTL sweep failed: ${err.message}`);
  }
}
setInterval(sweepStaleVideos, config.videoSweepMs).unref();
// Sweep once shortly after boot so abandoned uploads from a previous run go.
setTimeout(sweepStaleVideos, 30_000).unref();

app.listen(config.port, () => {
  console.log(`✅ RepCheck MediaPipe API listening on http://localhost:${config.port}`);
  console.log(`   model: ${config.modelPath}`);
  console.log(`   Claude: ${config.anthropicApiKey ? `enabled (${config.claudeModel})` : 'rules engine only (set ANTHROPIC_API_KEY to enable)'}`);
  console.log(`   Supabase: ${supabaseConfigured ? `connected (bucket: ${config.videosBucket})` : 'NOT configured'}`);
});
