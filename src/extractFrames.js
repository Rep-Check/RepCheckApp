/**
 * Frame extraction — brief 5.3 Step 2.
 *
 * Uses ffmpeg-static (a bundled ffmpeg binary, no system dependency) to pull
 * every 5th frame out of the uploaded video as JPEGs. The extracted frames
 * are the input to the MediaPipe pose model.
 *
 * The select filter keeps exactly every 5th frame (-vsync vfr is required so
 * the output timestamps match), and -frames:v caps the count so a long clip
 * can't blow up processing time.
 */
import {spawn} from 'node:child_process';
import {mkdir, readdir, rm} from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import {config} from './config.js';

export const FRAME_STEP = 5; // brief: every 5th frame extracted

/**
 * Extract every 5th frame of a video into a fresh temp folder.
 *
 * @param {string} videoPath absolute path to the uploaded video
 * @param {string} jobDir    job temp directory (will receive /frames)
 * @returns {Promise<{paths: string[], count: number}>}
 */
export async function extractFrames(videoPath, jobDir) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static binary not found');
  }
  const framesDir = path.join(jobDir, 'frames');
  await mkdir(framesDir, {recursive: true});

  const FFMPEG_TIMEOUT_MS = 90_000;

  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `select='not(mod(n\\,${FRAME_STEP}))'`,
      '-vsync', 'vfr',
      '-q:v', '2',
      '-frames:v', String(config.maxFrames),
      path.join(framesDir, 'frame_%05d.jpg'),
    ];
    const proc = spawn(ffmpegPath, args, {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    proc.stderr.on('data', d => (stderr += d));
    proc.on('error', reject);
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`));
    }, FFMPEG_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });
  });

  const names = (await readdir(framesDir)).filter(f => f.endsWith('.jpg')).sort();
  const paths = names.map(n => path.join(framesDir, n));
  return {paths, count: paths.length};
}
