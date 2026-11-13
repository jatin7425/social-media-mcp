import { getAccessToken } from "./auth";
import { ToolError } from "./errors";
import { COST, spendQuota } from "./quota";

const DATA_API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

/** Everything a tool needs to talk to one connected account. */
export interface YouTubeContext {
  env: Env;
  userId: string;
}

async function unwrap(response: Response, what: string): Promise<any> {
  if (response.ok) return response.status === 204 ? {} : await response.json();

  let detail = await response.text();
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    detail = parsed.error?.message ?? detail;
  } catch {
    // keep the raw body
  }
  if (response.status === 403 && /quota/i.test(detail)) {
    throw new ToolError(
      `${what}: YouTube refused the call for quota reasons - ${detail}. ` +
        `The daily quota resets at midnight Pacific.`,
    );
  }
  throw new ToolError(`${what} failed (HTTP ${response.status}): ${detail}`);
}

function queryString(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, value);
  }
  return qs.toString();
}

/** GET against the Data API. */
export async function dataGet(
  ctx: YouTubeContext,
  path: string,
  params: Record<string, string | undefined>,
  cost: number,
): Promise<any> {
  await spendQuota(ctx.env, ctx.userId, cost);
  const token = await getAccessToken(ctx.env, ctx.userId);
  const response = await fetch(`${DATA_API}/${path}?${queryString(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return unwrap(response, `GET ${path}`);
}

/** PUT or POST against the Data API, with a JSON body. */
export async function dataWrite(
  ctx: YouTubeContext,
  method: "PUT" | "POST",
  path: string,
  params: Record<string, string | undefined>,
  body: unknown,
  cost: number,
): Promise<any> {
  await spendQuota(ctx.env, ctx.userId, cost);
  const token = await getAccessToken(ctx.env, ctx.userId);
  const response = await fetch(`${DATA_API}/${path}?${queryString(params)}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return unwrap(response, `${method} ${path}`);
}

/**
 * Upload a thumbnail from a URL rather than inline base64: a 2MB image in a
 * tool call is an enormous number of tokens.
 */
export async function setThumbnail(
  ctx: YouTubeContext,
  videoId: string,
  imageUrl: string,
): Promise<any> {
  const image = await fetch(imageUrl);
  if (!image.ok) {
    throw new ToolError(
      `Could not download the thumbnail from ${imageUrl} (HTTP ${image.status}).`,
    );
  }
  const contentType = image.headers.get("content-type") ?? "image/jpeg";
  if (!/^image\/(jpeg|png|bmp)$/i.test(contentType)) {
    throw new ToolError(
      `A thumbnail must be JPEG, PNG or BMP; that URL returned ${contentType}.`,
    );
  }
  const bytes = await image.arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) {
    throw new ToolError(
      `That thumbnail is ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB; YouTube's limit is 2MB.`,
    );
  }

  await spendQuota(ctx.env, ctx.userId, 50);
  const token = await getAccessToken(ctx.env, ctx.userId);
  const response = await fetch(
    `${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body: bytes,
    },
  );
  return unwrap(response, "thumbnails.set");
}

/**
 * Rewrite share links from common hosts into direct-download URLs, so a link
 * copied from the share menu works without the user knowing the trick.
 */
export function directDownloadUrl(url: string): string {
  const drive = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]{20,})/);
  if (drive) {
    return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t`;
  }
  if (/^https:\/\/(www\.)?dropbox\.com\//.test(url)) {
    const u = new URL(url);
    u.searchParams.delete("dl");
    u.searchParams.set("dl", "1");
    return u.toString();
  }
  return url;
}

/** Largest file the Worker will relay. Shorts are a few tens of MB. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** Without a Content-Length the file has to be buffered, which Workers memory caps. */
const MAX_BUFFERED_BYTES = 90 * 1024 * 1024;

export interface UploadMetadata {
  snippet: Record<string, unknown>;
  status: Record<string, unknown>;
}

/**
 * Upload a video from a public URL with YouTube's resumable protocol. The file
 * is streamed from the source straight into YouTube, so it never has to pass
 * through a tool call or sit in Worker memory (when the source sends a length).
 */
export async function uploadVideoFromUrl(
  ctx: YouTubeContext,
  sourceUrl: string,
  metadata: UploadMetadata,
): Promise<any> {
  const url = directDownloadUrl(sourceUrl);
  const source = await fetch(url, { redirect: "follow" });
  if (!source.ok || !source.body) {
    throw new ToolError(`Could not download the video from ${sourceUrl} (HTTP ${source.status}).`);
  }
  const contentType = (source.headers.get("content-type") ?? "").split(";")[0].trim();
  if (/^text\/html/i.test(contentType)) {
    throw new ToolError(
      `${sourceUrl} returned a web page, not a video file. For Google Drive, set sharing to ` +
        `"Anyone with the link"; for other hosts, use the direct download link.`,
    );
  }
  const videoType = /^video\//i.test(contentType) ? contentType : "video/*";

  let length = Number(source.headers.get("content-length") ?? "");
  let body: ReadableStream | ArrayBuffer;
  if (Number.isFinite(length) && length > 0) {
    if (length > MAX_UPLOAD_BYTES) {
      throw new ToolError(`That file is ${(length / 1024 ** 3).toFixed(2)}GB; this tool relays at most 2GB.`);
    }
    // A fixed-length stream lets the Worker send Content-Length without buffering.
    const { readable, writable } = new FixedLengthStream(length);
    source.body.pipeTo(writable).catch(() => {});
    body = readable;
  } else {
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength > MAX_BUFFERED_BYTES) {
      throw new ToolError(
        `The host sent no file size and the file is over 90MB, too large to buffer. Use a host ` +
          `that sends Content-Length (Google Drive, Dropbox and GitHub releases do).`,
      );
    }
    length = bytes.byteLength;
    body = bytes;
  }
  if (length === 0) throw new ToolError(`The file at ${sourceUrl} is empty.`);

  await spendQuota(ctx.env, ctx.userId, COST.videosInsert);
  const token = await getAccessToken(ctx.env, ctx.userId);

  // 1. Open a resumable session carrying the metadata.
  const session = await fetch(
    `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(length),
        "x-upload-content-type": videoType,
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!session.ok) await unwrap(session, "videos.insert (start upload)");
  const location = session.headers.get("location");
  if (!location) throw new ToolError("YouTube did not return an upload session URL.");

  // 2. Send the bytes in one request.
  const response = await fetch(location, {
    method: "PUT",
    headers: { "content-type": videoType, "content-length": String(length) },
    body,
  });
  return unwrap(response, "videos.insert (upload bytes)");
}

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  metrics: string;
  dimensions?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
}

/**
 * YouTube Analytics API. ids=channel==MINE scopes every report to the
 * authorised channel. These calls spend no Data API units.
 */
export async function analytics(
  ctx: YouTubeContext,
  query: AnalyticsQuery,
): Promise<{ columns: string[]; rowCount: number; rows: Record<string, unknown>[] }> {
  const token = await getAccessToken(ctx.env, ctx.userId);
  const qs = queryString({
    ids: "channel==MINE",
    startDate: query.startDate,
    endDate: query.endDate,
    metrics: query.metrics,
    dimensions: query.dimensions,
    filters: query.filters,
    sort: query.sort,
    maxResults: query.maxResults ? String(query.maxResults) : undefined,
  });

  const response = await fetch(`${ANALYTICS_API}?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = await unwrap(response, "Analytics query");

  // Raw shape is {columnHeaders:[...], rows:[[...]]}. Turning it into objects
  // saves the model from indexing into positional arrays.
  const columns: string[] = (json.columnHeaders ?? []).map((h: any) => h.name);
  const rows: unknown[][] = json.rows ?? [];
  return {
    columns,
    rowCount: rows.length,
    rows: rows.map((row) =>
      Object.fromEntries(columns.map((name, i) => [name, row[i]])),
    ),
  };
}

/** Default window: the last `days` complete days, ending yesterday. */
export function defaultRange(days = 28): { startDate: string; endDate: string } {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const format = (date: Date) => date.toISOString().slice(0, 10);
  return { startDate: format(start), endDate: format(end) };
}

const SUGGEST_API = "https://suggestqueries.google.com/complete/search";

/**
 * YouTube's search autocomplete. This is NOT part of the Data API — Google
 * publishes no official endpoint for it — so this calls the same unofficial
 * endpoint every keyword tool scrapes. It costs no quota and needs no auth,
 * but it carries no guarantee: if Google changes it, this breaks.
 */
export async function suggestQueries(
  term: string,
  language: string,
  region: string,
): Promise<string[]> {
  const qs = new URLSearchParams({
    client: "firefox", // returns plain JSON rather than JSONP
    ds: "yt", // the YouTube suggestion corpus
    q: term,
    hl: language,
    gl: region,
  });

  const response = await fetch(`${SUGGEST_API}?${qs}`);
  if (!response.ok) {
    throw new ToolError(
      `Autocomplete lookup failed (HTTP ${response.status}). This endpoint is unofficial, ` +
        `so Google may have changed or rate-limited it.`,
    );
  }

  // Shape is ["<term>", ["suggestion", ...], ...]
  const parsed = (await response.json()) as unknown;
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) {
    throw new ToolError("Autocomplete returned an unexpected shape; the endpoint may have changed.");
  }
  return (parsed[1] as unknown[]).filter((s): s is string => typeof s === "string");
}

/** Run promises in small batches, so an expanded lookup isn't 27 at once. */
export async function inBatches<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return results;
}
