/**
 * Supabase admin helpers — Auth JWT verification, Storage (videos) lifecycle,
 * and Postgres rows for analyses + subscriptions.
 *
 * Uses the SERVICE ROLE key only (server-side). Never ships to the client.
 */
import {createClient} from '@supabase/supabase-js';
import {config} from './config.js';

export const supabase = config.supabaseUrl && config.supabaseServiceKey
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: {persistSession: false, autoRefreshToken: false},
    })
  : null;

/** True when a Supabase project is configured (the API can still run without it). */
export const supabaseConfigured = supabase !== null;

/**
 * Verify a Supabase access token (JWT) and return the user id.
 * Returns null when the token is missing/expired/invalid.
 */
export async function verifyUserToken(token) {
  if (!supabase || !token) {
    return null;
  }
  const {data, error} = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    return null;
  }
  return data.user;
}

// ── Storage: videos bucket ──────────────────────────────────────────────

/** Download a video object from the videos bucket to a local file path. */
export async function downloadVideo(storagePath, destPath) {
  const {data, error} = await supabase.storage.from(config.videosBucket).download(storagePath);
  if (error || !data) {
    throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  }
  const {writeFile} = await import('node:fs/promises');
  const buf = Buffer.from(await data.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}

/** Delete one video object (Step 9 — immediate cleanup). */
export async function deleteVideo(storagePath) {
  if (!storagePath) {
    return;
  }
  const {error} = await supabase.storage.from(config.videosBucket).remove([storagePath]);
  if (error) {
    console.warn(`video delete skipped (${storagePath}): ${error.message}`);
  }
}

/** List object names older than `maxAgeMs` (1-hour TTL sweep). */
export async function listStaleVideos(maxAgeMs = config.videoTtlMs) {
  const cutoff = Date.now() - maxAgeMs;
  const {data, error} = await supabase.storage.from(config.videosBucket).list('', {
    limit: 1000,
    sortBy: {column: 'created_at', order: 'desc'},
  });
  if (error) {
    return [];
  }
  return (data ?? [])
    .filter(o => o && new Date(o.created_at).getTime() < cutoff)
    .map(o => o.name);
}

// ── Postgres: analyses ──────────────────────────────────────────────────

/** Map a DB row to the API's StoredAnalysis shape. */
export function rowToAnalysis(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    date: new Date(row.created_at).getTime(),
    fileName: row.file_name ?? 'video.mp4',
    frameCount: row.frame_count ?? 0,
    exerciseId: row.exercise_id,
    exerciseName: row.exercise_name,
    score: row.score,
    grade: row.grade,
    risk: row.risk,
    cue: row.cue,
    categories: row.categories,
    feedback: row.feedback,
    nextFocus: row.next_focus,
    engine: row.engine,
  };
}

/** Insert a finished analysis row (returns the id used). */
export async function saveAnalysis(analysis) {
  const {error} = await supabase.from('analyses').insert(analysis);
  if (error) {
    throw new Error(`analyses insert failed: ${error.message}`);
  }
}

/** Number of free analyses the user has run (lifetime, 3-free allowance). */
export async function analysisCount(userId) {
  const {count, error} = await supabase
    .from('analyses')
    .select('id', {count: 'exact', head: true})
    .eq('user_id', userId);
  if (error) {
    throw new Error(`usage count failed: ${error.message}`);
  }
  return count ?? 0;
}

/** Read the user's active Pro subscription (null = free plan). */
export async function getSubscription(userId) {
  const {data, error} = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  if (data.status === 'active') {
    return data;
  }
  const trialEnds = Number(data.trial_ends_at ?? 0);
  return data.status === 'trialing' && trialEnds > Date.now() ? data : null;
}

/** Record a Pro subscription (trial or paid). */
export async function setSubscription(subscription) {
  const {error} = await supabase.from('subscriptions').upsert(subscription, {
    onConflict: 'user_id',
  });
  if (error) {
    throw new Error(`subscriptions upsert failed: ${error.message}`);
  }
}
