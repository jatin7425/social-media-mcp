import { appendLog, markReverted, readLog } from "./changelog";
import {
  analytics,
  dataGet,
  dataWrite,
  defaultRange,
  setThumbnail,
  type YouTubeContext,
} from "./client";
import { ToolError } from "./errors";
import { COST, getQuotaUsed, quotaLimit } from "./quota";

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Write tools are refused when READ_ONLY is on. */
  write?: boolean;
  handler: (ctx: YouTubeContext, args: Record<string, any>) => Promise<unknown>;
}

const DATE = { type: "string", description: "YYYY-MM-DD" };
const RANGE_PROPS = { startDate: DATE, endDate: DATE };

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function range(args: Record<string, any>, days = 28) {
  const fallback = defaultRange(days);
  return {
    startDate: (args.startDate as string) ?? fallback.startDate,
    endDate: (args.endDate as string) ?? fallback.endDate,
  };
}

async function myChannel(ctx: YouTubeContext, part = "snippet,statistics,contentDetails") {
  const response = await dataGet(ctx, "channels", { part, mine: "true" }, COST.list);
  const channel = response.items?.[0];
  if (!channel) {
    throw new ToolError(
      "No channel came back for this account. The connected Google account must own the " +
        "channel: a manager account cannot read Analytics.",
    );
  }
  return channel;
}

export const YOUTUBE_TOOLS: Tool[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "youtube_get_channel",
    title: "Get channel",
    description:
      "Subscriber count, total views, video count and basic metadata for the connected channel.",
    inputSchema: schema({}),
    handler: async (ctx) => {
      const channel = await myChannel(ctx);
      return {
        id: channel.id,
        title: channel.snippet?.title,
        description: channel.snippet?.description,
        publishedAt: channel.snippet?.publishedAt,
        statistics: channel.statistics,
        uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      };
    },
  },
  {
    name: "youtube_list_videos",
    title: "List videos",
    description:
      "The channel's uploads, newest first, with views, likes, comments, duration, tags and " +
      "privacy. Includes private and unlisted videos. Costs 3 quota units per page.",
    inputSchema: schema({
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 25." },
      pageToken: { type: "string", description: "Cursor from a previous call." },
    }),
    handler: async (ctx, args) => {
      const channel = await myChannel(ctx, "contentDetails");
      const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) throw new ToolError("This channel has no uploads playlist.");

      const page = await dataGet(
        ctx,
        "playlistItems",
        {
          part: "contentDetails",
          playlistId: uploads,
          maxResults: String(args.limit ?? 25),
          pageToken: args.pageToken,
        },
        COST.list,
      );
      const ids: string[] = (page.items ?? [])
        .map((item: any) => item.contentDetails?.videoId)
        .filter(Boolean);
      if (ids.length === 0) {
        return { videos: [], nextPageToken: page.nextPageToken ?? null };
      }

      const details = await dataGet(
        ctx,
        "videos",
        { part: "snippet,statistics,contentDetails,status", id: ids.join(",") },
        COST.list,
      );
      return {
        videos: (details.items ?? []).map((video: any) => ({
          videoId: video.id,
          title: video.snippet?.title,
          publishedAt: video.snippet?.publishedAt,
          duration: video.contentDetails?.duration,
          privacyStatus: video.status?.privacyStatus,
          views: Number(video.statistics?.viewCount ?? 0),
          likes: Number(video.statistics?.likeCount ?? 0),
          comments: Number(video.statistics?.commentCount ?? 0),
          tags: video.snippet?.tags ?? [],
        })),
        nextPageToken: page.nextPageToken ?? null,
      };
    },
  },
  {
    name: "youtube_get_video",
    title: "Get video",
    description: "Full snippet, status and statistics for one video, including its current tags.",
    inputSchema: schema({ videoId: { type: "string" } }, ["videoId"]),
    handler: async (ctx, args) => {
      const response = await dataGet(
        ctx,
        "videos",
        { part: "snippet,statistics,contentDetails,status", id: args.videoId },
        COST.list,
      );
      const video = response.items?.[0];
      if (!video) throw new ToolError(`No video found with id ${args.videoId}.`);
      return video;
    },
  },

  // -------------------------------------------------------------- analytics
  {
    name: "youtube_analytics_overview",
    title: "Analytics overview",
    description:
      "Channel totals for a date range: views, watch time, average view duration and percentage, " +
      "subscribers gained and lost, likes, comments, shares. Defaults to the last 28 complete days.",
    inputSchema: schema(RANGE_PROPS),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        metrics:
          "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage," +
          "subscribersGained,subscribersLost,likes,comments,shares",
      }),
  },
  {
    name: "youtube_analytics_top_videos",
    title: "Top videos",
    description:
      "The channel's own videos ranked by views for a date range, with watch time, average view " +
      "percentage and subscribers gained. The report to use for spotting outliers.",
    inputSchema: schema({
      ...RANGE_PROPS,
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 25." },
    }),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "video",
        metrics:
          "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained",
        sort: "-views",
        maxResults: args.limit ?? 25,
      }),
  },
  {
    name: "youtube_analytics_retention",
    title: "Audience retention",
    description:
      "The drop-off curve for one video: audienceWatchRatio and relativeRetentionPerformance at " +
      "each 1% of elapsed video time. The most useful report for diagnosing a weak hook.",
    inputSchema: schema({ videoId: { type: "string" }, ...RANGE_PROPS }, ["videoId"]),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args, 90),
        dimensions: "elapsedVideoTimeRatio",
        metrics: "audienceWatchRatio,relativeRetentionPerformance",
        filters: `video==${args.videoId}`,
        maxResults: 100,
      }),
  },
  {
    name: "youtube_analytics_traffic_sources",
    title: "Traffic sources",
    description:
      "Where views came from (Shorts feed, browse, suggested, search, external) with watch time " +
      "and average view duration. Pass videoId to scope it to one video.",
    inputSchema: schema({ ...RANGE_PROPS, videoId: { type: "string" } }),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "insightTrafficSourceType",
        metrics: "views,estimatedMinutesWatched,averageViewDuration",
        filters: args.videoId ? `video==${args.videoId}` : undefined,
        sort: "-views",
      }),
  },
  {
    name: "youtube_analytics_demographics",
    title: "Demographics",
    description: "Viewer share by age group and gender for a date range.",
    inputSchema: schema(RANGE_PROPS),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "ageGroup,gender",
        metrics: "viewerPercentage",
        sort: "-viewerPercentage",
      }),
  },
  {
    name: "youtube_analytics_geography",
    title: "Geography",
    description: "Views, watch time and subscribers gained by country.",
    inputSchema: schema({
      ...RANGE_PROPS,
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 25." },
    }),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "country",
        metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained",
        sort: "-views",
        maxResults: args.limit ?? 25,
      }),
  },
  {
    name: "youtube_analytics_daily",
    title: "Daily series",
    description:
      "Views, watch time and subscribers per day, for seeing when something moved.",
    inputSchema: schema(RANGE_PROPS),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "day",
        metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
        sort: "day",
      }),
  },
  {
    name: "youtube_analytics_content_type",
    title: "Shorts vs long-form",
    description:
      "Splits views and watch time between Shorts, ordinary uploads and live streams, so the two " +
      "formats can be compared instead of averaged together.",
    inputSchema: schema(RANGE_PROPS),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        dimensions: "creatorContentType",
        metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained",
        sort: "-views",
      }),
  },
  {
    name: "youtube_analytics_query",
    title: "Raw analytics query",
    description:
      "Escape hatch for any Analytics report with no named tool here. Takes metrics, dimensions, " +
      "filters and sort exactly as the API expects them. Not every metric works with every " +
      "dimension; the API rejects invalid combinations.",
    inputSchema: schema(
      {
        metrics: { type: "string", description: "Comma-separated, e.g. 'views,likes'." },
        dimensions: { type: "string" },
        filters: { type: "string", description: "e.g. 'video==abc123;country==IN'" },
        sort: { type: "string" },
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
        ...RANGE_PROPS,
      },
      ["metrics"],
    ),
    handler: (ctx, args) =>
      analytics(ctx, {
        ...range(args),
        metrics: args.metrics,
        dimensions: args.dimensions,
        filters: args.filters,
        sort: args.sort,
        maxResults: args.maxResults,
      }),
  },

  // ---------------------------------------------------------------- comments
  {
    name: "youtube_list_comments",
    title: "List comments",
    description: "Top-level comment threads on a video, newest first.",
    inputSchema: schema(
      {
        videoId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
        pageToken: { type: "string" },
      },
      ["videoId"],
    ),
    handler: async (ctx, args) => {
      const response = await dataGet(
        ctx,
        "commentThreads",
        {
          part: "snippet",
          videoId: args.videoId,
          maxResults: String(args.limit ?? 20),
          order: "time",
          pageToken: args.pageToken,
        },
        COST.list,
      );
      return {
        comments: (response.items ?? []).map((thread: any) => {
          const comment = thread.snippet?.topLevelComment;
          return {
            commentId: comment?.id,
            author: comment?.snippet?.authorDisplayName,
            text: comment?.snippet?.textOriginal,
            likeCount: comment?.snippet?.likeCount,
            publishedAt: comment?.snippet?.publishedAt,
            replyCount: thread.snippet?.totalReplyCount,
          };
        }),
        nextPageToken: response.nextPageToken ?? null,
      };
    },
  },

  // ------------------------------------------------------------------ writes
  {
    name: "youtube_update_video",
    title: "Update video metadata",
    description:
      "Change a video's title, description, tags, category or privacy. Only the fields passed are " +
      "changed; the rest are preserved. Previous values go to the change log first, so " +
      "youtube_revert_change can put them back. Costs 51 quota units.",
    write: true,
    inputSchema: schema(
      {
        videoId: { type: "string" },
        title: { type: "string", maxLength: 100 },
        description: { type: "string", maxLength: 5000 },
        tags: { type: "array", items: { type: "string" } },
        categoryId: { type: "string" },
        privacyStatus: { type: "string", enum: ["private", "unlisted", "public"] },
        reason: {
          type: "string",
          description: "Why the edit is being made. Stored in the change log.",
        },
      },
      ["videoId"],
    ),
    handler: async (ctx, args) => {
      const current = await dataGet(
        ctx,
        "videos",
        { part: "snippet,status", id: args.videoId },
        COST.list,
      );
      const video = current.items?.[0];
      if (!video) throw new ToolError(`No video found with id ${args.videoId}.`);

      const before = {
        title: video.snippet?.title,
        description: video.snippet?.description,
        tags: video.snippet?.tags ?? [],
        categoryId: video.snippet?.categoryId,
        privacyStatus: video.status?.privacyStatus,
      };

      // videos.update replaces the whole snippet, so merge onto what is there.
      const snippet = {
        ...video.snippet,
        title: args.title ?? before.title,
        description: args.description ?? before.description,
        tags: args.tags ?? before.tags,
        categoryId: args.categoryId ?? before.categoryId,
      };
      const parts = ["snippet"];
      const body: Record<string, unknown> = { id: args.videoId, snippet };
      if (args.privacyStatus) {
        parts.push("status");
        body.status = { ...video.status, privacyStatus: args.privacyStatus };
      }

      const after = {
        title: snippet.title,
        description: snippet.description,
        tags: snippet.tags,
        categoryId: snippet.categoryId,
        privacyStatus: args.privacyStatus ?? before.privacyStatus,
      };

      // Log before the call, so a half-applied change is still recoverable.
      const entry = await appendLog(ctx.env, ctx.userId, {
        tool: "youtube_update_video",
        videoId: args.videoId,
        before,
        after: { ...after, reason: args.reason },
      });

      await dataWrite(ctx, "PUT", "videos", { part: parts.join(",") }, body, COST.videosUpdate);
      return { ok: true, changeId: entry.id, before, after };
    },
  },
  {
    name: "youtube_set_thumbnail",
    title: "Set thumbnail",
    description:
      "Upload a custom thumbnail from a public image URL. JPEG, PNG or BMP under 2MB. The old " +
      "thumbnail URL is recorded in the change log. Costs 51 quota units.",
    write: true,
    inputSchema: schema(
      {
        videoId: { type: "string" },
        imageUrl: { type: "string", description: "Public https URL of the image." },
        reason: { type: "string" },
      },
      ["videoId", "imageUrl"],
    ),
    handler: async (ctx, args) => {
      const current = await dataGet(ctx, "videos", { part: "snippet", id: args.videoId }, COST.list);
      const video = current.items?.[0];
      if (!video) throw new ToolError(`No video found with id ${args.videoId}.`);
      const thumbnails = video.snippet?.thumbnails ?? {};
      const previous =
        thumbnails.maxres?.url ?? thumbnails.high?.url ?? thumbnails.default?.url;

      const entry = await appendLog(ctx.env, ctx.userId, {
        tool: "youtube_set_thumbnail",
        videoId: args.videoId,
        before: {
          thumbnailUrl: previous,
          note: "YouTube may stop serving the old image; keep a local copy to roll back.",
        },
        after: { thumbnailUrl: args.imageUrl, reason: args.reason },
      });

      const result = await setThumbnail(ctx, args.videoId, args.imageUrl);
      return { ok: true, changeId: entry.id, previousThumbnail: previous, result };
    },
  },
  {
    name: "youtube_reply_to_comment",
    title: "Reply to a comment",
    description: "Post a public reply to a comment thread as the channel. Costs 50 quota units.",
    write: true,
    inputSchema: schema(
      { parentCommentId: { type: "string" }, text: { type: "string", maxLength: 10000 } },
      ["parentCommentId", "text"],
    ),
    handler: async (ctx, args) => {
      const entry = await appendLog(ctx.env, ctx.userId, {
        tool: "youtube_reply_to_comment",
        before: {},
        after: { parentId: args.parentCommentId, text: args.text },
      });
      const result = await dataWrite(
        ctx,
        "POST",
        "comments",
        { part: "snippet" },
        { snippet: { parentId: args.parentCommentId, textOriginal: args.text } },
        COST.commentInsert,
      );
      return { ok: true, changeId: entry.id, commentId: result.id };
    },
  },

  // --------------------------------------------------------------------- ops
  {
    name: "youtube_quota_status",
    title: "Quota status",
    description:
      "How much of today's YouTube Data API unit budget this server has spent. Analytics reports " +
      "do not count against it.",
    inputSchema: schema({}),
    handler: async (ctx) => {
      const used = await getQuotaUsed(ctx.env, ctx.userId);
      const limit = quotaLimit(ctx.env);
      return {
        used,
        limit,
        remaining: limit - used,
        metadataEditsRemaining: Math.floor((limit - used) / 51),
        resets: "midnight Pacific",
      };
    },
  },
  {
    name: "youtube_change_log",
    title: "Change log",
    description:
      "Every change this server has made, newest first, with the values as they were beforehand. " +
      "Read it before reverting, and to see what an unattended run touched.",
    inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
    handler: async (ctx, args) => {
      const log = await readLog(ctx.env, ctx.userId);
      return { entries: log.slice(0, args.limit ?? 25), total: log.length };
    },
  },
  {
    name: "youtube_revert_change",
    title: "Revert a change",
    description:
      "Put a logged metadata change back as it was. Works for youtube_update_video. Thumbnails " +
      "and posted comments cannot be reverted automatically; the log records what they were.",
    write: true,
    inputSchema: schema({ changeId: { type: "string" } }, ["changeId"]),
    handler: async (ctx, args) => {
      const log = await readLog(ctx.env, ctx.userId);
      const entry = log.find((candidate) => candidate.id === args.changeId);
      if (!entry) throw new ToolError(`No change with id ${args.changeId} in the log.`);
      if (entry.revertedAt) {
        throw new ToolError(
          `Change ${args.changeId} was already reverted at ${entry.revertedAt}.`,
        );
      }
      if (entry.tool !== "youtube_update_video") {
        throw new ToolError(
          `Only youtube_update_video changes revert automatically. This one is ${entry.tool}; ` +
            `its previous state is in the log: ${JSON.stringify(entry.before)}`,
        );
      }

      const current = await dataGet(
        ctx,
        "videos",
        { part: "snippet,status", id: entry.videoId },
        COST.list,
      );
      const video = current.items?.[0];
      if (!video) throw new ToolError(`Video ${entry.videoId} no longer exists.`);

      const before = entry.before as Record<string, any>;
      const body: Record<string, unknown> = {
        id: entry.videoId,
        snippet: {
          ...video.snippet,
          title: before.title,
          description: before.description,
          tags: before.tags,
          categoryId: before.categoryId,
        },
        status: { ...video.status, privacyStatus: before.privacyStatus },
      };
      await dataWrite(ctx, "PUT", "videos", { part: "snippet,status" }, body, COST.videosUpdate);
      await markReverted(ctx.env, ctx.userId, entry.id);
      return { ok: true, reverted: entry.id, restored: before };
    },
  },
];

// Deterministic order: the 2026-07-28 spec asks for it so clients can cache the
// catalogue and keep upstream prompt caches stable across reconnects.
YOUTUBE_TOOLS.sort((a, b) => a.name.localeCompare(b.name));

export const TOOL_BY_NAME = new Map(YOUTUBE_TOOLS.map((tool) => [tool.name, tool]));
