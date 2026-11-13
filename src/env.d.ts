/// <reference path="../worker-configuration.d.ts" />

/**
 * Secrets, which `wrangler types` does not generate. Set them with:
 *   npx wrangler secret put GOOGLE_CLIENT_ID
 *   npx wrangler secret put GOOGLE_CLIENT_SECRET
 *   npx wrangler secret put MCP_SECRET
 *   npx wrangler secret put INSTAGRAM_APP_ID       (optional, for Instagram)
 *   npx wrangler secret put INSTAGRAM_APP_SECRET
 *
 * The per-account Google refresh token is NOT a secret here: it is minted by
 * the /connect/youtube flow and stored in KV against the user id, so the
 * server can hold more than one account later on.
 */
interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MCP_SECRET: string;
  INSTAGRAM_APP_ID: string;
  INSTAGRAM_APP_SECRET: string;
  QUOTA_DAILY_LIMIT?: string;
  READ_ONLY?: string;
}
