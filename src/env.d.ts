/// <reference path="../worker-configuration.d.ts" />

/**
 * Secrets, which `wrangler types` does not generate. Set them with:
 *   npx wrangler secret put GOOGLE_CLIENT_ID
 *   npx wrangler secret put GOOGLE_CLIENT_SECRET
 *   npx wrangler secret put MCP_SECRET
 *   npx wrangler secret put INSTAGRAM_ACCESS_TOKEN (Instagram, Unified login)
 *   npx wrangler secret put INSTAGRAM_USER_ID
 *   (or INSTAGRAM_APP_ID + INSTAGRAM_APP_SECRET for the older Instagram-login OAuth)
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
  /** System-user token from API setup with Unified login. Takes precedence over OAuth. */
  INSTAGRAM_ACCESS_TOKEN?: string;
  /** The Instagram professional account id that token manages. */
  INSTAGRAM_USER_ID?: string;
  QUOTA_DAILY_LIMIT?: string;
  READ_ONLY?: string;
}
