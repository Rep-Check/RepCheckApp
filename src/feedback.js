/**
 * Coaching cues — brief 5.3 Step 7.
 *
 * Two paths:
 *  1. Built-in rules engine (default): deterministic PT feedback derived from
 *     the category scores — the weakest categories with their cues, plus a
 *     nod to the strongest. Zero external calls, works offline.
 *  2. Claude enrichment (optional): when ANTHROPIC_API_KEY is set, the rules
 *     output is passed to the Anthropic Messages API which rewrites it into
 *     natural, friendly PT language. The rules text is always the fallback if
 *     the call fails or the key is absent.
 */
import {config} from './config.js';

/** Build the base rules-based feedback (identical to the app's output shape). */
export function rulesFeedback(result) {
  return result.feedback;
}

/**
 * Ask Claude to turn the rules-based feedback into natural PT coaching.
 * Returns null when no API key is configured or the call fails (caller falls
 * back to the rules text).
 */
async function claudeFeedback(result) {
  if (!config.anthropicApiKey) {
    return null;
  }
  try {
    const body = {
      model: config.claudeModel,
      max_tokens: 500,
      system:
        'You are a strength-coaching PT. Rewrite the given form feedback into ' +
        '2–3 warm, specific, actionable coaching cues. Keep each cue to one ' +
        'sentence, use plain gym language, and return JSON with a single ' +
        '"feedback" array of {emoji, text} objects.',
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            exercise: result.exerciseName,
            score: result.score,
            categories: result.categories,
            baseFeedback: result.feedback,
          }),
        },
      ],
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return null;
    }
    const json = await res.json();
    const text = json.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.feedback)) {
      return parsed.feedback.slice(0, 4);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Produce the final coaching output: Claude-enriched when available,
 * rules-based otherwise.
 */
export async function buildFeedback(result) {
  const enriched = await claudeFeedback(result);
  return enriched ?? rulesFeedback(result);
}
