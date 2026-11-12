import { Hono } from "hono";
import { isAuthorised } from "../lib/mcp/protocol";
import { getCurrentUserId } from "../lib/session";
import {
  buildConsentUrl,
  disconnect,
  exchangeCode,
  getRefreshToken,
  storeRefreshToken,
} from "../lib/youtube/auth";
import { safeEqual, ToolError } from "../lib/youtube/errors";

export const connectRoutes = new Hono<{ Bindings: Env }>();

function page(inner: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect YouTube - Social Media MCP</title>
  </head>
  <body style="font:16px/1.6 system-ui;max-width:46rem;margin:3rem auto;padding:0 1rem">
    ${inner}
  </body>
</html>`;
}

const PRE = "background:#f4f4f5;padding:1rem;border-radius:8px;white-space:pre-wrap;word-break:break-all";

/** Step 1: hand the browser to Google's consent screen. */
connectRoutes.get("/connect/youtube", (c) => {
  const secret = c.req.query("s") ?? "";
  if (!c.env.MCP_SECRET || !safeEqual(secret, c.env.MCP_SECRET)) {
    return c.html(
      page("<h1>Not authorised</h1><p>Open <code>/connect/youtube?s=YOUR_MCP_SECRET</code>.</p>"),
      401,
    );
  }
  const redirectUri = new URL("/connect/youtube/callback", c.req.url).toString();
  return c.redirect(buildConsentUrl(c.env, redirectUri, secret), 302);
});

/** Step 2: Google sends the browser back with ?code=... */
connectRoutes.get("/connect/youtube/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    return c.html(page(`<h1>Google returned an error</h1><p><code>${error}</code></p>`), 400);
  }

  // state carries the same secret, so the callback can't be driven by a stranger.
  const state = c.req.query("state") ?? "";
  if (!c.env.MCP_SECRET || !safeEqual(state, c.env.MCP_SECRET)) {
    return c.html(page("<h1>Not authorised</h1><p>State did not match.</p>"), 401);
  }

  const code = c.req.query("code");
  if (!code) return c.html(page("<h1>Missing code</h1>"), 400);

  const redirectUri = new URL("/connect/youtube/callback", c.req.url).toString();
  try {
    const { refreshToken, scope } = await exchangeCode(c.env, code, redirectUri);
    await storeRefreshToken(c.env, getCurrentUserId(), refreshToken);
    return c.html(
      page(
        `<h1>YouTube connected</h1>
         <p>The refresh token is stored in KV against <code>${getCurrentUserId()}</code>.
            You can close this tab.</p>
         <p style="color:#555">Scopes granted:</p>
         <pre style="${PRE}">${scope.split(" ").join("\n")}</pre>
         <p><a href="/connect/youtube/status?s=${state}">Check status</a></p>`,
      ),
    );
  } catch (err) {
    const message = err instanceof ToolError ? err.message : String(err);
    return c.html(page(`<h1>Exchange failed</h1><p>${message}</p>`), 400);
  }
});

connectRoutes.get("/connect/youtube/status", async (c) => {
  const secret = c.req.query("s") ?? "";
  if (!c.env.MCP_SECRET || !safeEqual(secret, c.env.MCP_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const userId = getCurrentUserId();
  return c.json({ userId, connected: Boolean(await getRefreshToken(c.env, userId)) });
});

connectRoutes.post("/connect/youtube/disconnect", async (c) => {
  if (!isAuthorised(c.req.raw.headers, c.req.query("s"), c.env.MCP_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await disconnect(c.env, getCurrentUserId());
  return c.json({ success: true });
});
