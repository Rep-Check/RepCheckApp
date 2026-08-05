/**
 * Central config — env vars with sensible defaults.
 */
import 'dotenv/config';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  modelPath: path.join(ROOT_DIR, 'models', 'pose_landmarker_full.task'),
  maxVideoBytes: Number(process.env.MAX_VIDEO_BYTES ?? 150_000_000),
  maxFrames: Number(process.env.MAX_FRAMES ?? 120),
  tempDir: path.resolve(ROOT_DIR, process.env.TEMP_DIR ?? 'tmp'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514',

  // Supabase (brief 5.2: Auth + PostgreSQL + Storage)
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  videosBucket: process.env.VIDEOS_BUCKET ?? 'videos',
  /** Videos auto-deleted after this long (brief: "auto-deleted within 1 hour"). */
  videoTtlMs: Number(process.env.VIDEO_TTL_MS ?? 3_600_000),
  /** How often the TTL sweep runs. */
  videoSweepMs: Number(process.env.VIDEO_SWEEP_MS ?? 15 * 60_000),

  // PostHog analytics (free tier)
  posthogApiKey: process.env.POSTHOG_API_KEY ?? '',
  posthogHost: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
};
