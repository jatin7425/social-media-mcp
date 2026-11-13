# social-media-mcp

An MCP server which will give your claude/chatgpt/gemini powers to handle your social media.

Runs as a single Cloudflare Worker. YouTube and Instagram are implemented.

## What it can do

22 YouTube tools over the Data API v3 and the Analytics API.

**Read** — `youtube_get_channel`, `youtube_list_videos` (includes private and unlisted),
`youtube_get_video`, `youtube_list_comments`, `youtube_list_categories`

**Research** — `youtube_search_suggestions` (search autocomplete, no quota cost)

**Analytics** — `youtube_analytics_overview`, `_top_videos`, `_retention` (the per-video
drop-off curve), `_traffic_sources`, `_demographics`, `_geography`, `_daily`,
`_content_type` (Shorts vs long-form vs live), and `_query` as an escape hatch for any
report with no named tool

**Write** — `youtube_upload_video` (from a public URL; Google Drive and Dropbox share links
work; private, public or scheduled), `youtube_update_video` (title, description, tags,
category, privacy, scheduled `publishAt`),
`youtube_set_thumbnail`, `youtube_reply_to_comment`

**Operations** — `youtube_quota_status`, `youtube_change_log`, `youtube_revert_change`

### Instagram

10 tools over the Instagram API, using either a Unified-login system-user token
(`graph.facebook.com`) or Instagram Login (`graph.instagram.com`). Needs an Instagram
**professional** account (Creator or Business).

**Read** — `instagram_get_account`, `instagram_list_media`, `instagram_list_comments`,
`instagram_publishing_limit`

**Insights** — `instagram_media_insights` (views, reach, likes, shares, saves, Reel watch
time), `instagram_account_insights` (up to 30 days), `instagram_audience` (age, gender,
country or city of followers or engaged accounts; needs 100+ of them)

**Write** — `instagram_publish_reel` (from a public video URL; Drive and Dropbox share
links work), `instagram_publish_container` (finishes a Reel that was still processing),
`instagram_reply_to_comment`

The API cannot schedule posts: a published Reel goes live immediately. Accounts can publish
50 posts per rolling 24 hours through the API.

### Changes are reversible

YouTube keeps no history of video metadata, so every write records the previous values in
KV before it calls the API. `youtube_change_log` shows what was touched and
`youtube_revert_change` puts a metadata edit back. Thumbnails and posted comments are
logged but cannot be rolled back automatically.

Set `READ_ONLY: "true"` in `wrangler.jsonc` to make every write tool refuse, which is worth
doing on the first run.

### Quota

The Data API gives 10,000 units a day. A read costs 1 unit, a metadata edit 51, a thumbnail
51, an upload 1,600 (about six a day). Analytics reports cost nothing against that budget. The server reserves units before
each call and fails with a clear message rather than letting YouTube start answering
`quotaExceeded`, since that burns the rest of the day on retries.

## Setup

### 1. Google Cloud

1. Create a project at <https://console.cloud.google.com>.
2. Enable **YouTube Data API v3** and **YouTube Analytics API**.
3. OAuth consent screen: External. Add yourself as a test user, then **publish** it —
   while it is in Testing, refresh tokens expire after 7 days.
4. Credentials → OAuth 2.0 Client ID → **Web application**. Add the redirect URI:
   `https://<your-worker>.workers.dev/connect/youtube/callback`
   (and `http://127.0.0.1:8787/connect/youtube/callback` for local work).

Sign in with the account that **owns** the channel. A manager account cannot read Analytics.

### 2. Secrets and KV

```bash
npx wrangler kv namespace create SOCIAL_KV   # put the id in wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MCP_SECRET           # any long random string you choose
```

`MCP_SECRET` is what clients authenticate with. Generate one with
`openssl rand -hex 32`.

### 3. Deploy and connect

```bash
npm install
npm run deploy
```

Then open `https://<your-worker>.workers.dev/connect/youtube?s=<MCP_SECRET>` in a browser
and sign in. The refresh token is stored in KV against the current user id, so no further
secret needs setting.

### 4. Instagram (optional)

Meta now gives new apps **API setup with Unified login** only. That flow issues a
never-expiring system-user token, which is all this server needs:

1. At <https://developers.facebook.com/apps> create an app with the **Manage messaging &
   content on Instagram** use case, and connect a business portfolio when asked (free; no
   verification needed for your own account).
2. Use cases → Customize → **API setup with Unified login** → **Create new configuration**.
   Keep *System-user access token*, select your Instagram professional account as the
   business asset, and include `instagram_manage_insights` if it is offered so the
   insights tools work.
3. Under **Generate access tokens**, add the Instagram account and generate a token. Note
   the account's id.
4. Set both as secrets (never commit them):

   ```bash
   npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
   npx wrangler secret put INSTAGRAM_USER_ID
   ```

Apps created before Unified login can instead set `INSTAGRAM_APP_ID` and
`INSTAGRAM_APP_SECRET`, register `https://<your-worker>.workers.dev/connect/instagram/callback`
as the business-login redirect, and open `/connect/instagram?s=<MCP_SECRET>`. When both are
configured, the system-user token wins.

### 5. Point a client at it

The MCP endpoint is `POST /mcp` with `Authorization: Bearer <MCP_SECRET>`. For clients that
only accept a URL, the secret also works as a path segment:
`https://<your-worker>.workers.dev/mcp/<MCP_SECRET>`.

That puts the secret in a URL, where it can end up in logs and browser history. Prefer the
bearer header where the client supports it.

## Protocol

Implements MCP **2026-07-28**, the stateless revision: no `initialize` handshake, no
`Mcp-Session-Id`, and the `Mcp-Method` / `Mcp-Name` headers mirrored from the body. Because
there is no protocol session, the Worker needs no Durable Object and fits the free plan.

`2025-11-25`, `2025-06-18` and `2025-03-26` are still accepted, and `initialize` is answered
for clients on those versions.

## Routes

| Route | Purpose |
| --- | --- |
| `POST /mcp` | The MCP endpoint |
| `GET /connect/youtube?s=…` | Start the Google OAuth flow |
| `GET /connect/youtube/status?s=…` | Whether an account is connected |
| `POST /connect/youtube/disconnect?s=…` | Forget the stored tokens |
| `GET /dashboard` | Dashboard UI |
| `GET /dev` | Development console (local only) |

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in the three secrets
npm run dev
```

```bash
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Authorization: Bearer <MCP_SECRET>' \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Layout

```
src/
  index.ts              Hono app, mounts the routers
  routes/
    mcp.ts              the MCP endpoint
    connect.ts          Google OAuth flow
    dashboard.ts        dashboard UI
    dev.ts              development console
  lib/
    mcp/protocol.ts     version negotiation, header contract, auth
    youtube/
      auth.ts           OAuth, token refresh, KV-backed refresh token
      client.ts         Data API + Analytics API
      tools.ts          the 21 tool definitions
      quota.ts          daily unit budget
      changelog.ts      before-state log and revert
      keys.ts           KV key layout
      errors.ts         ToolError, timing-safe compare
```

### On keyword research

`youtube_search_suggestions` reads YouTube's search autocomplete. Google publishes no
official endpoint for it, so this calls the same unofficial one every keyword tool scrapes:
free and unauthenticated, but it can change without notice.

It returns phrasing, not demand. YouTube has never published search volume, so every
"volume" figure in a paid tool is modelled from proxy signals. That estimate cannot be
rebuilt on the official API, and this server does not pretend to.

## Known gaps

- Uploads are not implemented. Resumable upload through a Worker needs more care than a
  single request allows.
- `getCurrentUserId()` is still a stub returning `dev-user`, so the server holds one
  account. The KV layout is namespaced per user and ready for more.
- Some YouTube Studio features have no public API at all: the built-in title and thumbnail
  A/B tests, end screens and cards. No MCP server can reach those.
