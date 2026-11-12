import { ytKeys } from "./keys";

const MAX_ENTRIES = 200;

export interface ChangeEntry {
  id: string;
  at: string;
  tool: string;
  videoId?: string;
  /** Values as they were BEFORE the change: enough to put them back. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Set once rolled back, so the same entry can't be applied twice. */
  revertedAt?: string;
}

export async function readLog(env: Env, userId: string): Promise<ChangeEntry[]> {
  return (
    (await env.SOCIAL_KV.get<ChangeEntry[]>(ytKeys.changelog(userId), "json")) ?? []
  );
}

/**
 * Record a change. Every write tool calls this with the previous values, which
 * is what makes revert possible: YouTube keeps no history of its own.
 */
export async function appendLog(
  env: Env,
  userId: string,
  entry: Omit<ChangeEntry, "id" | "at">,
): Promise<ChangeEntry> {
  const log = await readLog(env, userId);
  const full: ChangeEntry = {
    ...entry,
    id: crypto.randomUUID().slice(0, 8),
    at: new Date().toISOString(),
  };
  log.unshift(full);
  await env.SOCIAL_KV.put(
    ytKeys.changelog(userId),
    JSON.stringify(log.slice(0, MAX_ENTRIES)),
  );
  return full;
}

export async function markReverted(
  env: Env,
  userId: string,
  id: string,
): Promise<void> {
  const log = await readLog(env, userId);
  const hit = log.find((entry) => entry.id === id);
  if (hit) hit.revertedAt = new Date().toISOString();
  await env.SOCIAL_KV.put(ytKeys.changelog(userId), JSON.stringify(log));
}
