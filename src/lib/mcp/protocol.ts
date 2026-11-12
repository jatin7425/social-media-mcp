import { safeEqual } from "../youtube/errors";

/**
 * 2026-07-28 is the stateless revision of MCP: no initialize handshake, no
 * Mcp-Session-Id, and Mcp-Method / Mcp-Name headers mirrored from the body so
 * intermediaries can route without parsing it. Older versions are still
 * accepted, and for those the server also answers `initialize`.
 */
export const LATEST_PROTOCOL = "2026-07-28";
export const SUPPORTED_PROTOCOLS = [
  LATEST_PROTOCOL,
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];

export const SERVER_INFO = { name: "social-media-mcp", version: "1.0.0" };

export interface JsonRpcBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, any>;
}

export type ProtocolCheck =
  | { ok: true; version: string }
  | { ok: false; code: number; message: string; data?: Record<string, unknown> };

/**
 * Validates the transport contract: a supported version, and headers that
 * agree with the body. The spec requires rejecting mismatches rather than
 * silently trusting one side.
 */
export function checkProtocol(
  headers: Headers,
  body: JsonRpcBody,
): ProtocolCheck {
  const headerVersion = headers.get("mcp-protocol-version");
  const metaVersion = body.params?._meta?.["io.modelcontextprotocol/protocolVersion"];

  // Clients older than 2025-06-18 never sent the header. The spec allows
  // reading a missing header as 2025-03-26 instead of rejecting them.
  const version = headerVersion ?? metaVersion ?? "2025-03-26";

  if (!SUPPORTED_PROTOCOLS.includes(version)) {
    return {
      ok: false,
      code: -32600,
      message: `Unsupported protocol version: ${version}`,
      data: { type: "UnsupportedProtocolVersionError", supported: SUPPORTED_PROTOCOLS },
    };
  }
  if (headerVersion && metaVersion && headerVersion !== metaVersion) {
    return {
      ok: false,
      code: -32600,
      message: "MCP-Protocol-Version header does not match _meta",
    };
  }

  const headerMethod = headers.get("mcp-method");
  if (headerMethod && body.method && headerMethod !== body.method) {
    return {
      ok: false,
      code: -32600,
      message: "Mcp-Method header does not match the body method",
    };
  }

  const headerName = headers.get("mcp-name");
  if (headerName && body.params?.name && headerName !== body.params.name) {
    return {
      ok: false,
      code: -32600,
      message: "Mcp-Name header does not match params.name",
    };
  }

  return { ok: true, version };
}

/**
 * The MCP endpoint takes a bearer token, or the same secret as a trailing path
 * segment for clients that only accept a URL.
 */
export function isAuthorised(
  headers: Headers,
  pathSecret: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const authorization = headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (bearer && safeEqual(bearer, secret)) return true;
  return Boolean(pathSecret) && safeEqual(pathSecret!, secret);
}
