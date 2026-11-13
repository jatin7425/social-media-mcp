import { ToolError } from "../youtube/errors";

/**
 * Instagram API with Instagram Login (graph.instagram.com). Works with a
 * Professional (Creator or Business) account on its own: no Facebook Page.
 */
export const IG_API_VERSION = "v26.0";
export const IG_GRAPH = `https://graph.instagram.com/${IG_API_VERSION}`;
const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const LONG_TOKEN_URL = "https://graph.instagram.com/access_token";
const REFRESH_URL = "https://graph.instagram.com/refresh_access_token";

/**
 *  - instagram_business_basic             profile and media
 *  - instagram_business_content_publish   publish Reels and posts
 *  - instagram_business_manage_comments   read and reply to comments
 *  - instagram_business_manage_insights   account and media insights
 */
export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_insights",
];

export const igKeys = {
  token: (userId: string) => `ig:${userId}:token`,
};

interface StoredToken {
  token: string;
  /** Epoch ms when the long-lived token expires (about 60 days after issue). */
  expiresAt: number;
  /** Epoch ms of the last issue or refresh. Meta refuses refreshes under 24h old. */
  issuedAt: number;
  igUserId: string;
}

const DAY = 24 * 60 * 60 * 1000;

export function buildIgConsentUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function metaError(body: any, fallback: string): string {
  return body?.error?.message ?? body?.error_message ?? body?.error_description ?? fallback;
}

/** Code -> short-lived token (1 hour) -> long-lived token (60 days). */
export async function exchangeIgCode(
  env: Env,
  userId: string,
  code: string,
  redirectUri: string,
): Promise<{ igUserId: string; expiresAt: number; scopes: string }> {
  const short = await fetch(SHORT_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      // Instagram sometimes appends "#_" to the code in the redirect.
      code: code.replace(/#_$/, ""),
    }),
  });
  const shortBody = await readJson(short);
  // The response is either flat or wrapped in data[0], depending on the app's API version.
  const first = Array.isArray(shortBody?.data) ? shortBody.data[0] : shortBody;
  if (!short.ok || !first?.access_token) {
    throw new ToolError(`Instagram code exchange failed: ${metaError(shortBody, String(short.status))}`);
  }

  const qs = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token: first.access_token,
  });
  const long = await fetch(`${LONG_TOKEN_URL}?${qs}`);
  const longBody = await readJson(long);
  if (!long.ok || !longBody?.access_token) {
    throw new ToolError(`Long-lived token exchange failed: ${metaError(longBody, String(long.status))}`);
  }

  const now = Date.now();
  const stored: StoredToken = {
    token: longBody.access_token,
    expiresAt: now + Number(longBody.expires_in ?? 60 * 24 * 3600) * 1000,
    issuedAt: now,
    igUserId: String(first.user_id ?? ""),
  };
  await env.SOCIAL_KV.put(igKeys.token(userId), JSON.stringify(stored));
  return {
    igUserId: stored.igUserId,
    expiresAt: stored.expiresAt,
    scopes: Array.isArray(first.permissions) ? first.permissions.join(",") : String(first.permissions ?? ""),
  };
}

export async function igStatus(env: Env, userId: string) {
  const stored = await env.SOCIAL_KV.get<StoredToken>(igKeys.token(userId), "json");
  return stored
    ? { connected: true, igUserId: stored.igUserId, expiresAt: new Date(stored.expiresAt).toISOString() }
    : { connected: false };
}

export async function igDisconnect(env: Env, userId: string): Promise<void> {
  await env.SOCIAL_KV.delete(igKeys.token(userId));
}

/**
 * A usable long-lived token. Refreshed in place once it is a day old and
 * within ten days of expiry, so a channel that is used at least every
 * seven weeks never has to reconnect.
 */
export async function getIgToken(env: Env, userId: string): Promise<string> {
  const stored = await env.SOCIAL_KV.get<StoredToken>(igKeys.token(userId), "json");
  if (!stored) {
    throw new ToolError(
      "No Instagram account is connected. Open /connect/instagram?s=<MCP_SECRET> in a browser " +
        "and log in with the Instagram professional account.",
    );
  }
  const now = Date.now();
  if (stored.expiresAt <= now) {
    throw new ToolError(
      "The Instagram token has expired (it lasts 60 days without use). Open " +
        "/connect/instagram?s=<MCP_SECRET> to connect again.",
    );
  }
  if (stored.expiresAt - now < 10 * DAY && now - stored.issuedAt > DAY) {
    const qs = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: stored.token });
    const response = await fetch(`${REFRESH_URL}?${qs}`);
    const body = await readJson(response);
    if (response.ok && body?.access_token) {
      const next: StoredToken = {
        ...stored,
        token: body.access_token,
        expiresAt: now + Number(body.expires_in ?? 60 * 24 * 3600) * 1000,
        issuedAt: now,
      };
      await env.SOCIAL_KV.put(igKeys.token(userId), JSON.stringify(next));
      return next.token;
    }
    // A failed refresh is not fatal while the old token still works.
  }
  return stored.token;
}
