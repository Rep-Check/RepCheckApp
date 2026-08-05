# RepCheck MediaPipe API

Server-side implementation of the brief's **5.3 AI Video Analysis Pipeline** — upload a lift video, get back per-category form scores, PT coaching cues, injury risk and next-session focus.

```
POST /api/analyze   multipart form:  video=<file>   exercise=squat|deadlift|bench|ohp|pushup|pullup|lunge|rdl
GET  /health        engine status + uptime
```

## Pipeline (brief 5.3)

| Step | What happens |
| --- | --- |
| 1 | **Upload** — video only, 150MB cap (MP4, MOV, AVI, MKV, M4V) |
| 2 | **Frame extraction** — ffmpeg-static pulls every 5th frame as JPEG (capped at 120) |
| 3 | **Pose estimation** — 33 body landmarks per frame |
| 4 | **Joint angles** — knee, hip, spine, elbow, ankle (dorsiflexion approximated by shin lean) |
| 5 | **Rules engine** — angles vs ideal ranges per exercise |
| 6 | **Scoring** — every category scored 0–100, reps detected & scored individually |
| 7 | **Coaching cues** — rules-based PT cues, optionally enriched by Claude |
| 8 | **Response** — JSON with scores, cues, risk flag, next focus |
| 9 | **Cleanup** — video + frames deleted before the response is sent |

## Quick start

```bash
npm install
npm run smoke          # boots the server and tests the whole pipeline
npm start              # or: npm run dev (auto-restart)
```

The smoke test uploads a generated clip with no person in it, so it proves the
pipeline end-to-end (upload → extract → detect → JSON → cleanup) and returns
the expected `422 no_pose_detected`. A **real lift video** (person in frame,
filmed from the side) is needed to exercise the scoring.

## Two pose engines

The default engine runs entirely in pure JS — no WebGL, no native deps:

- **`movenet` (default)** — TensorFlow.js **MoveNet SINGLEPOSE_LIGHTNING** on
  the CPU backend. Returns 17 keypoints which are re-mapped into the
  MediaPipe 33-slot layout the rules engine reads, so **scores are identical
  whichever engine is active**. Model weights download from TF Hub on first
  use, so the first request needs internet (subsequent runs are faster; the
  weights are cached by tfjs).
- **`mediapipe` (opt-in)** — the same `pose_landmarker_full.task` model the
  mobile app ships, via `@mediapipe/tasks-vision` WASM:

  ```bash
  POSE_ENGINE=mediapipe npm start
  ```

  This path needs a working **WebGL context in Node**. Stock Node has none
  (the WASM glue uploads input images through WebGL regardless of the CPU
  delegate), so it requires a build with headless GL (e.g. the `gl` package on
  a Node version with prebuilds). `src/nodeShim.js` provides the browser-globals
  shim + mock WebGL context that makes it boot on machines with GL support.

Select via the `POSE_ENGINE` env var; `/health` reports which one is live.

## Scoring parity

`src/scoring.js` is a faithful port of the mobile app's on-device engine
(`Repcheck/src/services/poseAnalysis.ts`) — same landmark indices, same
angle formulas, same per-category rules for all **8 exercises** (Squat,
Deadlift, Bench Press, Overhead Press, Push Up, Pull Up, Lunge, Romanian
Deadlift), same percentile-based robustness, same rep detection. A video
scored here produces the same numbers the app would produce on-device.

## Response shape

```json
{
  "exerciseId": "squat",
  "exerciseName": "Squat",
  "score": 78,
  "grade": "Good Form",
  "risk": "medium",
  "cue": "Pause for one second in the hole…",
  "categories": [{"name": "Depth", "score": 84}, {"name": "Back Position", "score": 71}],
  "feedback": [{"emoji": "🏋️", "text": "Back Position: keep the chest proud…"}],
  "nextFocus": "Slow the descent by 20%…",
  "framesExtracted": 72,
  "framesAnalyzed": 68,
  "avgVisibility": 0.82,
  "repCount": 5,
  "repScores": [74, 79, 81, 76, 80],
  "annotatedVideoUrl": "/outputs/annotated-1730000000000.mp4",
  "processingMs": 8421,
  "engine": "movenet"
}
```

> **`annotatedVideoUrl` (testing only)** — a video with the detected pose
> skeleton drawn over every frame, served from `GET /outputs/<name>.mp4`
> (relative to the API host). Used to eyeball what the pose engine saw;
> the shipped client renders its own skeleton and won't use this field.

## Claude enrichment (optional)

Set `ANTHROPIC_API_KEY` (and optionally `CLAUDE_MODEL`) in `.env` and Step 7
will ask Claude to rewrite the rules-based cues into warm, natural PT
language. If the call fails or the key is absent, the rules text is used —
the API never fails because of the LLM.

```bash
echo "ANTHROPIC_API_KEY=sk-ant-…" > .env
npm start
```

## Env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `POSE_ENGINE` | `movenet` | `movenet` or `mediapipe` |
| `MAX_VIDEO_BYTES` | `150000000` | Upload cap (150MB) |
| `MAX_FRAMES` | `120` | Frame cap (every 5th frame) |
| `TEMP_DIR` | `tmp` | Job scratch space (auto-cleaned) |
| `ANTHROPIC_API_KEY` | — | Enables Claude coaching cues |
| `CLAUDE_MODEL` | `claude-3-5-haiku-latest` | Claude model |

## Notes

- **Latency**: a 1-minute clip at 30fps → ~72 frames → roughly 15–30s on CPU
  (MoveNet is sequential per frame). `MAX_FRAMES` caps the worst case.
- **Privacy**: uploads and extracted frames live only in a per-job temp dir
  and are deleted before the client receives the response (Step 9).
- No auth is built in — this is a local/demo API. Add a token layer before
  exposing it publicly.
