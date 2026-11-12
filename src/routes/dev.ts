import { Hono, type MiddlewareHandler } from "hono";
import {
  clearDevelopmentKeys,
  developmentTestKey,
  listDevelopmentKeys,
} from "../lib/kv";
import { getCurrentUserId } from "../lib/session";

export const devRoutes = new Hono<{ Bindings: Env }>();

const developmentOnly: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  if (c.env.ENVIRONMENT !== "development") {
    return c.notFound();
  }

  await next();
};

devRoutes.use("/dev", developmentOnly);
devRoutes.use("/dev/*", developmentOnly);

devRoutes.get("/dev", async (c) => {
  const userId = getCurrentUserId();
  const key = developmentTestKey(userId);
  const value = "hello from social media mcp";
  let kvStatus = "Error";

  try {
    await c.env.SOCIAL_KV.put(key, value);
    const storedValue = await c.env.SOCIAL_KV.get(key);
    if (storedValue === value) {
      kvStatus = "Connected";
    }
  } catch (error) {
    console.error("Development KV health check failed", error);
  }

  return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Development Console - Social Media MCP</title>
  </head>
  <body>
    <main>
      <h1>Social Media MCP</h1>
      <h2>Development Console</h2>
      <dl>
        <dt>Environment</dt><dd>Local Development</dd>
        <dt>KV</dt><dd>${kvStatus}</dd>
        <dt>Session</dt><dd>${userId}</dd>
        <dt>YouTube</dt><dd>Not Connected</dd>
        <dt>Instagram</dt><dd>Not Connected</dd>
      </dl>
      <nav>
        <a href="/dev/kv">View development KV keys</a>
        <a href="/dev/kv/test">Test KV</a>
        <form method="post" action="/dev/kv/clear">
          <button type="submit">Clear development KV keys</button>
        </form>
      </nav>
    </main>
  </body>
</html>`);
});

devRoutes.get("/dev/kv", async (c) => {
  const keys = await listDevelopmentKeys(
    c.env.SOCIAL_KV,
    getCurrentUserId(),
  );
  return c.json({ keys });
});

devRoutes.get("/dev/kv/test", async (c) => {
  const value = "hello from social media mcp";
  const key = developmentTestKey(getCurrentUserId());

  await c.env.SOCIAL_KV.put(key, value);
  const storedValue = await c.env.SOCIAL_KV.get(key);

  if (storedValue !== value) {
    return c.json({ success: false, value: storedValue }, 500);
  }

  return c.json({ success: true, value: storedValue });
});

devRoutes.post("/dev/kv/clear", async (c) => {
  const deleted = await clearDevelopmentKeys(
    c.env.SOCIAL_KV,
    getCurrentUserId(),
  );
  return c.json({ success: true, deleted });
});
