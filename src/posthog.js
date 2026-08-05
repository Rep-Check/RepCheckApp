/**
 * PostHog analytics — free tier. No-op when POSTHOG_API_KEY is unset, so the
 * API works locally without analytics.
 */
import {PostHog} from 'posthog-node';
import {config} from './config.js';

const client = config.posthogApiKey
  ? new PostHog(config.posthogApiKey, {host: config.posthogHost})
  : null;

/** Fire-and-forget event capture; never throws. */
export function capture(distinctId, event, properties = {}) {
  if (!client) {
    return;
  }
  try {
    client.capture({distinctId: distinctId || 'anonymous', event, properties});
  } catch {
    // Analytics must never break the API.
  }
}

/** Flush pending events (call before process exit). */
export async function flushAnalytics() {
  if (client) {
    try {
      await client.shutdown();
    } catch {
      // ignore
    }
  }
}
