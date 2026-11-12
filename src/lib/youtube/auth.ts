import { ToolError } from "./errors";
import { ytKeys } from "./keys";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Scopes this server needs.
 *  - youtube               read and edit videos, playlists, channel settings
 *  - youtube.force-ssl     comments: read, post, moderate
 *  - yt-analytics.readonly the Analytics API reports
 * Add yt-analytics-monetary.readonly only once a channel is monetised.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

interface CachedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

export async function getRefreshToken(
  env: Env,
  userId: string,
): Promise<string | null> {
  return env.SOCIAL_KV.get(ytKeys.refreshToken(userId));
}

export async function storeRefreshToken(
  env: Env,
  userId: string,
  token: string,
): Promise<void> {
  await env.SOCIAL_KV.put(ytKeys.refreshToken(userId), token);
}

export async function disconnect(env: Env, userId: string): Promise<void> {
  await Promise.all([
    env.SOCIAL_KV.delete(ytKeys.refreshToken(userId)),
    env.SOCIAL_KV.delete(ytKeys.accessToken(userId)),
  ]);
}

/**
 * A valid access token, refreshed only when the cached one is within a minute
 * of expiry. Cached in KV so a cold Worker does not re-refresh every request.
 */
export async function getAccessToken(env: Env, userId: string): Promise<string> {
  const cached = await env.SOCIAL_KV.get<CachedToken>(
    ytKeys.accessToken(userId),
    "json",
  );
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const refreshToken = await getRefreshToken(env, userId);
  if (!refreshToken) {
    throw new ToolError(
      "No YouTube account is connected. Open /connect/youtube?s=<MCP_SECRET> in a browser " +
        "and sign in with the Google account that owns the channel.",
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    // invalid_grant usually means the token was revoked, the Google password
    // changed, or the OAuth consent screen is still in Testing (7-day tokens).
    throw new ToolError(
      `Google token refresh failed (${response.status} ${body.error ?? "unknown"}): ` +
        `${body.error_description ?? "no detail"}. If this says invalid_grant, reconnect at ` +
        `/connect/youtube and publish the OAuth consent screen so tokens stop expiring.`,
    );
  }

  const expiresIn = body.expires_in ?? 3600;
  const cachedToken: CachedToken = {
    token: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  await env.SOCIAL_KV.put(
    ytKeys.accessToken(userId),
    JSON.stringify(cachedToken),
    { expirationTtl: Math.max(60, expiresIn - 120) },
  );
  return cachedToken.token;
}

/** Step 1 of connecting an account: Google's consent screen. */
export function buildConsentUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    // offline + consent is what actually returns a refresh_token.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Step 2: swap the one-time code for a refresh token. */
export async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; scope: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const body = (await response.json()) as {
    refresh_token?: string;
    scope?: string;
    error_description?: string;
  };

  if (!response.ok || !body.refresh_token) {
    throw new ToolError(
      `Code exchange failed: ${body.error_description ?? response.status}. ` +
        `If the response carries no refresh_token, revoke this app at ` +
        `https://myaccount.google.com/permissions and connect again.`,
    );
  }
  return { refreshToken: body.refresh_token, scope: body.scope ?? "" };
}
