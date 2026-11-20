import { Hono } from "hono";

const CONTACT_EMAIL = "jatinvishwakarma75@outlook.com";
const LAST_UPDATED = "20 November 2026";

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Social Media MCP</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 680px; margin: 48px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 1.6rem; margin-bottom: 0.2rem; }
  h2 { font-size: 1.1rem; margin-top: 1.8rem; }
  .muted { color: #666; font-size: 0.9rem; }
  a { color: #0b57d0; }
</style>
</head>
<body>
${body}
</body>
</html>`;

const privacyBody = `
<h1>Privacy Policy</h1>
<p class="muted">Social Media MCP · Last updated ${LAST_UPDATED}</p>

<p>Social Media MCP is a personal tool. It is used only by its owner to manage and analyse his own YouTube channel and Instagram account. It is not offered to the public.</p>

<h2>What data it accesses</h2>
<p>When the owner connects an account, the app receives OAuth access to that account through Google (YouTube Data API and YouTube Analytics API) or Meta (Instagram Graph API). It reads channel, video, analytics and comment data, and can make changes such as updating video details or replying to comments, only when the owner asks it to.</p>

<h2>How data is stored</h2>
<p>The app stores only the OAuth tokens it needs to call these APIs, plus a small log of changes it has made so they can be undone. They are kept in the app's private Cloudflare storage. Analytics and content data are fetched on demand and are not kept.</p>

<h2>Sharing</h2>
<p>No data is sold, shared with third parties, or used for advertising. Data from Google APIs is used only to provide the features described above, in line with the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>

<h2>Removing access</h2>
<p>Access can be revoked at any time from <a href="https://myaccount.google.com/permissions">Google Account permissions</a> or Instagram's app settings. Revoking access makes the stored tokens useless.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;

const homeBody = `
<h1>Social Media MCP</h1>
<p>A personal MCP server its owner uses to manage and analyse his own YouTube channel and Instagram account from AI assistants.</p>
<p><a href="/privacy">Privacy Policy</a></p>
<p class="muted">Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;

export const legalRoutes = new Hono<{ Bindings: Env }>();

legalRoutes.get("/", (c) => c.html(page("Home", homeBody)));
legalRoutes.get("/privacy", (c) => c.html(page("Privacy Policy", privacyBody)));
