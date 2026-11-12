import { ToolError } from "./errors";
import { ytKeys } from "./keys";

/**
 * YouTube Data API v3 unit costs, from Google's quota calculator.
 * Analytics and Reporting calls spend no Data API units, so they are 0 here
 * and never touch KV.
 */
export const COST = {
  list: 1,
  search: 100,
  videosUpdate: 50,
  thumbnailsSet: 50,
  commentInsert: 50,
  playlistWrite: 50,
  analytics: 0,
} as const;

function today(): string {
  // Google resets the Data API quota at midnight Pacific. Tracking UTC days is
  // close enough for a guard rail, as long as the limit leaves some headroom.
  return new Date().toISOString().slice(0, 10);
}

export async function getQuotaUsed(env: Env, userId: string): Promise<number> {
  const raw = await env.SOCIAL_KV.get(ytKeys.quota(userId, today()));
  return raw ? Number(raw) : 0;
}

export function quotaLimit(env: Env): number {
  const limit = Number(env.QUOTA_DAILY_LIMIT ?? "10000");
  return Number.isFinite(limit) && limit > 0 ? limit : 10000;
}

/**
 * Reserve units before a call, rather than letting YouTube answer
 * quotaExceeded — once that starts, retries burn the rest of the day.
 */
export async function spendQuota(
  env: Env,
  userId: string,
  cost: number,
): Promise<void> {
  if (cost <= 0) return;
  const limit = quotaLimit(env);
  const used = await getQuotaUsed(env, userId);
  if (used + cost > limit) {
    throw new ToolError(
      `Daily YouTube Data API quota would be exceeded: ${used}/${limit} units used and this ` +
        `call costs ${cost}. It resets at midnight Pacific. Reads cost 1 unit, metadata edits 50.`,
    );
  }
  await env.SOCIAL_KV.put(ytKeys.quota(userId, today()), String(used + cost), {
    expirationTtl: 60 * 60 * 48,
  });
}
