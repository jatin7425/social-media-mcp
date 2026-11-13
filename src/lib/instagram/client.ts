import type { YouTubeContext } from "../youtube/client";
import { ToolError } from "../youtube/errors";
import { getIgToken, igBase, igPath } from "./auth";

/** Same shape as the YouTube context: one env, one connected user. */
export type IgContext = YouTubeContext;

async function unwrap(response: Response, what: string): Promise<any> {
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (response.ok && !body?.error) return body;

  const err = body?.error ?? {};
  const detail = err.error_user_msg ?? err.message ?? body?.raw ?? `HTTP ${response.status}`;
  if (err.code === 4 || err.code === 17 || err.code === 32 || response.status === 429) {
    throw new ToolError(`${what}: Instagram rate limit hit - ${detail}. Wait an hour and retry.`);
  }
  if (err.code === 190) {
    throw new ToolError(
      `${what}: the Instagram token is no longer valid - ${detail}. Reconnect at /connect/instagram?s=<MCP_SECRET>.`,
    );
  }
  throw new ToolError(`${what} failed (HTTP ${response.status}): ${detail}`);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") out.set(key, String(value));
  }
  return out.toString();
}

export async function igGet(
  ctx: IgContext,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<any> {
  const token = await getIgToken(ctx.env, ctx.userId);
  const response = await fetch(`${igBase(ctx.env)}/${igPath(ctx.env, path)}?${qs(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return unwrap(response, `GET ${path}`);
}

export async function igPost(
  ctx: IgContext,
  path: string,
  body: Record<string, string | number | boolean | undefined>,
): Promise<any> {
  const token = await getIgToken(ctx.env, ctx.userId);
  const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== ""));
  const response = await fetch(`${igBase(ctx.env)}/${igPath(ctx.env, path)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(clean),
  });
  return unwrap(response, `POST ${path}`);
}

/** Container states Meta reports while it fetches and transcodes a video. */
export type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export async function containerStatus(
  ctx: IgContext,
  containerId: string,
): Promise<{ status_code: ContainerStatus; status?: string }> {
  return igGet(ctx, containerId, { fields: "status_code,status" });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll a container until Meta finishes processing it. Waiting costs no Worker
 * CPU, but keep it bounded: a client will not hold a tool call open forever.
 */
export async function waitForContainer(
  ctx: IgContext,
  containerId: string,
  maxWaitMs = 75_000,
): Promise<{ status_code: ContainerStatus; status?: string }> {
  const deadline = Date.now() + maxWaitMs;
  let state = await containerStatus(ctx, containerId);
  while (state.status_code === "IN_PROGRESS" && Date.now() < deadline) {
    await sleep(5_000);
    state = await containerStatus(ctx, containerId);
  }
  if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
    throw new ToolError(
      `Instagram could not process the video (${state.status_code}): ${state.status ?? "no detail"}. ` +
        `Reels need an MP4 or MOV (H.264, AAC), 3s-15min, 9:16 recommended, served from a public ` +
        `URL that returns the file directly.`,
    );
  }
  return state;
}

export async function publishContainer(ctx: IgContext, containerId: string): Promise<any> {
  const published = await igPost(ctx, "me/media_publish", { creation_id: containerId });
  const media = await igGet(ctx, published.id, {
    fields: "id,permalink,timestamp,media_product_type,caption",
  });
  return media;
}
