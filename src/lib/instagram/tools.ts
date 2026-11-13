import { directDownloadUrl } from "../youtube/client";
import { ToolError } from "../youtube/errors";
import type { Tool } from "../youtube/tools";
import { igStatus, igTokenMode } from "./auth";
import { containerStatus, igGet, igPost, publishContainer, waitForContainer } from "./client";

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url";

/** Reel metrics; the API rejects any a media type does not support. */
const REEL_METRICS =
  "views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
const POST_METRICS = "views,reach,likes,comments,shares,saved,total_interactions";

function day(value: string | undefined, fallbackDaysAgo: number): number {
  const date = value ? new Date(`${value}T00:00:00Z`) : new Date(Date.now() - fallbackDaysAgo * 86_400_000);
  if (Number.isNaN(date.getTime())) throw new ToolError(`Not a date: ${value}. Use YYYY-MM-DD.`);
  return Math.floor(date.getTime() / 1000);
}

/** Insights come back as [{name, period, values|total_value}]; flatten to name -> value. */
function flattenInsights(data: any[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of data ?? []) {
    if (row.total_value) {
      out[row.name] = row.total_value.breakdowns?.length ? row.total_value : row.total_value.value;
    } else if (Array.isArray(row.values)) {
      out[row.name] = row.values.length === 1 ? row.values[0].value : row.values;
    }
  }
  return out;
}

export const INSTAGRAM_TOOLS: Tool[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "instagram_get_account",
    title: "Get Instagram account",
    description:
      "Username, account type, followers, following and post count for the connected Instagram " +
      "professional account, plus when its token expires.",
    inputSchema: schema({}),
    handler: async (ctx) => {
      // account_type and user_id exist only on the Instagram-login host.
      const me = await igGet(ctx, "me", {
        fields: igTokenMode(ctx.env)
          ? "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website"
          : "user_id,username,name,account_type,biography,followers_count,follows_count,media_count,profile_picture_url,website",
      });
      return { ...me, token: await igStatus(ctx.env, ctx.userId) };
    },
  },
  {
    name: "instagram_list_media",
    title: "List Instagram posts and Reels",
    description:
      "The account's posts and Reels, newest first, with type, caption, link, likes and comment " +
      "count. media_product_type is REELS, FEED or STORY.",
    inputSchema: schema({
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 25." },
      after: { type: "string", description: "Cursor from a previous call." },
    }),
    handler: async (ctx, args) => {
      const page = await igGet(ctx, "me/media", {
        fields: MEDIA_FIELDS,
        limit: args.limit ?? 25,
        after: args.after,
      });
      return { media: page.data ?? [], after: page.paging?.cursors?.after ?? null };
    },
  },
  {
    name: "instagram_media_insights",
    title: "Instagram Reel or post insights",
    description:
      "Performance of one post or Reel: views, reach, likes, comments, shares, saves and total " +
      "interactions. For Reels also average watch time and total watch time (milliseconds). " +
      "Pass metrics to ask for a different comma-separated set.",
    inputSchema: schema(
      {
        mediaId: { type: "string" },
        metrics: { type: "string", description: "Override, e.g. 'views,reach,shares'." },
      },
      ["mediaId"],
    ),
    handler: async (ctx, args) => {
      let metrics = args.metrics as string | undefined;
      if (!metrics) {
        const media = await igGet(ctx, args.mediaId, { fields: "media_product_type,media_type" });
        metrics = media.media_product_type === "REELS" ? REEL_METRICS : POST_METRICS;
      }
      const response = await igGet(ctx, `${args.mediaId}/insights`, { metric: metrics });
      return { mediaId: args.mediaId, metrics: flattenInsights(response.data) };
    },
  },
  {
    name: "instagram_account_insights",
    title: "Instagram account insights",
    description:
      "Account totals for a date range (at most 30 days, default the last 28): views, reach, " +
      "accounts engaged, total interactions, likes, comments, shares, saves and follows. " +
      "Insights can lag by up to 48 hours.",
    inputSchema: schema({
      startDate: { type: "string", description: "YYYY-MM-DD" },
      endDate: { type: "string", description: "YYYY-MM-DD" },
      metrics: { type: "string", description: "Override, comma-separated." },
    }),
    handler: async (ctx, args) => {
      const since = day(args.startDate, 28);
      const until = day(args.endDate, 0);
      if (until - since > 30 * 86_400) throw new ToolError("Instagram allows at most 30 days per insights call.");
      const response = await igGet(ctx, "me/insights", {
        metric:
          args.metrics ??
          "views,reach,accounts_engaged,total_interactions,likes,comments,shares,saves,follows_and_unfollows",
        period: "day",
        metric_type: "total_value",
        since,
        until,
      });
      return { since: new Date(since * 1000).toISOString().slice(0, 10), until: new Date(until * 1000).toISOString().slice(0, 10), metrics: flattenInsights(response.data) };
    },
  },
  {
    name: "instagram_audience",
    title: "Instagram audience demographics",
    description:
      "Who follows or engages with the account, broken down by age, gender, country or city. " +
      "audience 'followers' is everyone following; 'engaged' is who liked, commented, shared " +
      "or saved in the timeframe. Instagram only returns this once the account has 100+ " +
      "followers or engaged accounts.",
    inputSchema: schema(
      {
        breakdown: { type: "string", enum: ["age", "gender", "country", "city"] },
        audience: { type: "string", enum: ["followers", "engaged"], description: "Default followers." },
        timeframe: {
          type: "string",
          enum: ["this_week", "this_month"],
          description: "For engaged audience. Default this_month.",
        },
      },
      ["breakdown"],
    ),
    handler: async (ctx, args) => {
      const metric = args.audience === "engaged" ? "engaged_audience_demographics" : "follower_demographics";
      const response = await igGet(ctx, "me/insights", {
        metric,
        period: "lifetime",
        timeframe: args.timeframe ?? "this_month",
        breakdown: args.breakdown,
        metric_type: "total_value",
      });
      const row = response.data?.[0];
      const results = row?.total_value?.breakdowns?.[0]?.results ?? [];
      const rows = results
        .map((r: any) => ({ [args.breakdown]: r.dimension_values?.[0], count: r.value }))
        .sort((a: any, b: any) => b.count - a.count);
      return { metric, breakdown: args.breakdown, rows };
    },
  },
  {
    name: "instagram_list_comments",
    title: "List Instagram comments",
    description: "Comments on one post or Reel, newest first, with their replies.",
    inputSchema: schema(
      {
        mediaId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 25." },
      },
      ["mediaId"],
    ),
    handler: async (ctx, args) => {
      const page = await igGet(ctx, `${args.mediaId}/comments`, {
        fields: "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}",
        limit: args.limit ?? 25,
      });
      return {
        comments: (page.data ?? []).map((c: any) => ({ ...c, replies: c.replies?.data ?? [] })),
      };
    },
  },
  {
    name: "instagram_publishing_limit",
    title: "Instagram publishing limit",
    description: "How many of the 50 API posts allowed per rolling 24 hours the account has used.",
    inputSchema: schema({}),
    handler: async (ctx) => {
      const response = await igGet(ctx, "me/content_publishing_limit", { fields: "config,quota_usage" });
      return response.data?.[0] ?? response;
    },
  },
  // ------------------------------------------------------------------ writes
  {
    name: "instagram_reply_to_comment",
    title: "Reply to an Instagram comment",
    description: "Post a public reply to a comment as the account.",
    write: true,
    inputSchema: schema(
      { commentId: { type: "string" }, text: { type: "string", maxLength: 2200 } },
      ["commentId", "text"],
    ),
    handler: async (ctx, args) => {
      const reply = await igPost(ctx, `${args.commentId}/replies`, { message: args.text });
      return { ok: true, replyId: reply.id };
    },
  },
  {
    name: "instagram_publish_reel",
    title: "Publish an Instagram Reel",
    description:
      "Publish a Reel from a public video URL. Instagram downloads the file itself, so the URL " +
      "must return the MP4 directly (Google Drive and Dropbox share links are converted; Drive " +
      "sharing must be 'Anyone with the link'). Waits up to about 75 seconds for Instagram to " +
      "process it, then publishes. If it is still processing, returns the containerId: call " +
      "instagram_publish_container with it a minute later. Publishing is immediate and public; " +
      "the API cannot schedule. Counts toward the 50-posts-a-day API limit.",
    write: true,
    inputSchema: schema(
      {
        videoUrl: { type: "string", description: "Public https URL of the MP4 or MOV." },
        caption: { type: "string", maxLength: 2200 },
        shareToFeed: { type: "boolean", description: "Also show it on the profile grid. Default true." },
        coverUrl: { type: "string", description: "Optional public JPEG for the cover." },
        thumbOffsetMs: {
          type: "integer",
          minimum: 0,
          description: "Use the frame at this many milliseconds as the cover, if no coverUrl. Default 0.",
        },
      },
      ["videoUrl"],
    ),
    handler: async (ctx, args) => {
      const container = await igPost(ctx, "me/media", {
        media_type: "REELS",
        video_url: directDownloadUrl(args.videoUrl),
        caption: args.caption,
        share_to_feed: args.shareToFeed ?? true,
        cover_url: args.coverUrl ? directDownloadUrl(args.coverUrl) : undefined,
        thumb_offset: args.coverUrl ? undefined : (args.thumbOffsetMs ?? 0),
      });
      const state = await waitForContainer(ctx, container.id);
      if (state.status_code !== "FINISHED") {
        return {
          ok: false,
          containerId: container.id,
          status: state.status_code,
          next: "Still processing. Call instagram_publish_container with this containerId in a minute.",
        };
      }
      const media = await publishContainer(ctx, container.id);
      return { ok: true, mediaId: media.id, permalink: media.permalink, timestamp: media.timestamp };
    },
  },
  {
    name: "instagram_publish_container",
    title: "Finish publishing an Instagram Reel",
    description:
      "Check a media container from instagram_publish_reel and publish it once Instagram has " +
      "finished processing. Containers expire 24 hours after creation.",
    write: true,
    inputSchema: schema({ containerId: { type: "string" } }, ["containerId"]),
    handler: async (ctx, args) => {
      const state = await containerStatus(ctx, args.containerId);
      if (state.status_code === "PUBLISHED") {
        return { ok: true, status: "PUBLISHED", note: "This container was already published." };
      }
      const ready = await waitForContainer(ctx, args.containerId, 45_000);
      if (ready.status_code !== "FINISHED") {
        return { ok: false, containerId: args.containerId, status: ready.status_code, next: "Try again shortly." };
      }
      const media = await publishContainer(ctx, args.containerId);
      return { ok: true, mediaId: media.id, permalink: media.permalink, timestamp: media.timestamp };
    },
  },
];
