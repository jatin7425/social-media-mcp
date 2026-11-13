import { Hono } from "hono";
import {
  checkProtocol,
  isAuthorised,
  LATEST_PROTOCOL,
  SERVER_INFO,
  type JsonRpcBody,
} from "../lib/mcp/protocol";
import { getCurrentUserId } from "../lib/session";
import type { YouTubeContext } from "../lib/youtube/client";
import { ToolError } from "../lib/youtube/errors";
import { INSTAGRAM_TOOLS } from "../lib/instagram/tools";
import { YOUTUBE_TOOLS, type Tool } from "../lib/youtube/tools";

// Deterministic order across both platforms, so clients can cache the catalogue.
const ALL_TOOLS: Tool[] = [...YOUTUBE_TOOLS, ...INSTAGRAM_TOOLS].sort((a, b) =>
  a.name.localeCompare(b.name),
);
const TOOL_BY_NAME = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));

export const mcpRoutes = new Hono<{ Bindings: Env }>();

type Json = Record<string, any>;

const rpcResult = (id: unknown, result: Json) =>
  Response.json({ jsonrpc: "2.0", id, result });

const rpcError = (
  id: unknown,
  code: number,
  message: string,
  data?: Json,
  status = 200,
) =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );

// The 2026-07-28 transport removed the GET stream, so the endpoint is POST only.
mcpRoutes.on(["GET", "PUT", "DELETE", "PATCH"], ["/mcp", "/mcp/:secret"], (c) =>
  c.text("This MCP endpoint accepts POST only.", 405, { allow: "POST" }),
);

mcpRoutes.on("POST", ["/mcp", "/mcp/:secret"], async (c) => {
  // DNS-rebinding guard: non-browser MCP clients send no Origin at all, and
  // anything that does send one must match this Worker.
  const origin = c.req.header("origin");
  const url = new URL(c.req.url);
  if (origin && origin !== url.origin) {
    return c.json({ error: "Origin not allowed" }, 403);
  }

  if (!isAuthorised(c.req.raw.headers, c.req.param("secret"), c.env.MCP_SECRET)) {
    return c.json({ error: "Unauthorized" }, 401, {
      "www-authenticate": 'Bearer realm="mcp"',
    });
  }

  let body: JsonRpcBody;
  try {
    body = (await c.req.json()) as JsonRpcBody;
  } catch {
    return rpcError(null, -32700, "Parse error: body is not valid JSON", undefined, 400);
  }

  const id = body.id ?? null;
  const check = checkProtocol(c.req.raw.headers, body);
  if (!check.ok) return rpcError(id, check.code, check.message, check.data, 400);

  // A notification carries no id: acknowledge, return nothing.
  if (body.id === undefined) return c.body(null, 202);

  switch (body.method) {
    case "initialize":
      // Only pre-2026-07-28 clients send this; answering keeps them working.
      return rpcResult(id, {
        protocolVersion: check.version === LATEST_PROTOCOL ? LATEST_PROTOCOL : check.version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: ALL_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: !tool.write,
            destructiveHint: Boolean(tool.write),
          },
        })),
      });

    case "tools/call":
      return callTool(c.env, id, body.params ?? {});

    default:
      return rpcError(id, -32601, `Method not found: ${body.method ?? "(none)"}`);
  }
});

async function callTool(env: Env, id: unknown, params: Json): Promise<Response> {
  const tool = TOOL_BY_NAME.get(params.name);
  if (!tool) return rpcError(id, -32602, `No such tool: ${params.name}`);

  if (tool.write && String(env.READ_ONLY ?? "").toLowerCase() === "true") {
    return rpcResult(id, {
      isError: true,
      content: [
        {
          type: "text",
          text:
            `${tool.name} makes changes and this server is running with READ_ONLY=true. ` +
            `Unset that var in wrangler.jsonc to allow writes.`,
        },
      ],
    });
  }

  const ctx: YouTubeContext = { env, userId: getCurrentUserId() };

  try {
    const result = await tool.handler(ctx, params.arguments ?? {});
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result as Json,
    });
  } catch (error) {
    // Tool failures come back as a result with isError rather than a JSON-RPC
    // error, so the model can read the message and decide what to do next.
    const message =
      error instanceof ToolError
        ? error.message
        : `${tool.name} failed before it could reach ${tool.name.startsWith("instagram_") ? "Instagram" : "YouTube"}: ${String(error)}. ` +
          `If that looks like a network error, check the Worker can reach ${tool.name.startsWith("instagram_") ? "graph.instagram.com" : "googleapis.com"}.`;
    return rpcResult(id, { isError: true, content: [{ type: "text", text: message }] });
  }
}
