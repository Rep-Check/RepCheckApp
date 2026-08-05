/**
 * Smoke test — boots the API, hits /health, then POSTs a tiny generated
 * video to /api/analyze and prints the response.
 *
 * The generated clip (ffmpeg testsrc) has no person in it, so the expected
 * outcome is a clean 422 "no_pose_detected" — which proves the whole
 * pipeline works end-to-end (upload → extract → detect → JSON → cleanup)
 * minus the actual landmark scoring, which needs a real lift video.
 *
 * Usage: npm run smoke   (after `npm install`)
 */
import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {config} from '../src/config.js';

const BASE = `http://localhost:${config.port}`;

async function genVideo(dir) {
  const out = path.join(dir, 'test.mp4');
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=640x480:rate=15',
      '-pix_fmt', 'yuv420p', out,
    ], {stdio: ['ignore', 'ignore', 'pipe']});
    let err = '';
    proc.stderr.on('data', d => (err += d));
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))));
  });
  return out;
}

const step = msg => console.log(`\n── ${msg} ──`);

try {
  step('Health');
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log(JSON.stringify(health, null, 2));

  step('Generating test video (no person — expected 422 no_pose_detected)');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rc-smoke-'));
  const videoPath = await genVideo(tmp);
  const buf = await readFile(videoPath);
  console.log(`test.mp4 ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

  const form = new FormData();
  form.append('exercise', 'squat');
  form.append('video', new Blob([buf], {type: 'video/mp4'}), 'squat-test.mp4');

  step('POST /api/analyze');
  const res = await fetch(`${BASE}/api/analyze`, {method: 'POST', body: form});
  const body = await res.json();
  console.log(`status ${res.status}`);
  console.log(JSON.stringify(body, null, 2));

  step('Cleanup check (uploaded video must be deleted)');
  const leftovers = await readdir(config.tempDir).catch(() => []);
  const jobs = leftovers.filter(n => n.startsWith('job-'));
  console.log(jobs.length === 0 ? '✅ no job dirs left behind' : `⚠️ leftover job dirs: ${jobs.join(', ')}`);

  await rm(tmp, {recursive: true, force: true});
  process.exit(0);
} catch (err) {
  console.error('❌ smoke test failed:', err);
  process.exit(1);
}
