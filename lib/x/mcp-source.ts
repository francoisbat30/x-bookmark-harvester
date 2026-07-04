/**
 * Official X MCP server as an extraction source (opt-in).
 *
 * STATUS: scaffold. The official X MCP (https://api.x.com/mcp) is a first-party
 * wrapper over the same X API v2 this tool already calls directly. Its only net
 * gain is full-archive conversation search (comments/threads for posts outside
 * the ~7-day recent window) — which would reduce Grok fallbacks — and that is
 * gated on the X API plan tier. The exact MCP tool names / output shapes must
 * be confirmed against a live server before mapping, so this source is disabled
 * by default and throws if invoked. Use `npm run skill:mcp-probe` to inspect the
 * server, then implement extract() below.
 *
 * Wiring is already in place: extractPost() puts this source ahead of "xapi"
 * whenever ctx.mcp.enabled is true (see lib/x/extract.ts).
 */
import type { PostExtraction } from "../types";
import type { ExtractContext, PostSource } from "./extract";

export interface McpSourceConfig {
  /** When true, extractPost tries the MCP source before the direct X API. */
  enabled: boolean;
  /** MCP endpoint, e.g. https://api.x.com/mcp */
  url?: string;
  /** Bearer used against the MCP endpoint (app-only or OAuth user token). */
  bearerToken?: string;
}

/** Build the MCP config from env. Disabled unless X_MCP_ENABLED=1. */
export function mcpConfigFromEnv(): McpSourceConfig {
  return {
    enabled: process.env.X_MCP_ENABLED === "1",
    url: process.env.X_MCP_URL ?? "https://api.x.com/mcp",
    bearerToken: process.env.X_MCP_BEARER_TOKEN,
  };
}

export const mcpSource: PostSource = {
  name: "mcp",
  async extract(_id: string, _ctx: ExtractContext): Promise<PostExtraction> {
    // Not yet mapped — see file header. extractPost() catches this and falls
    // through to the next primary (xapi) / the Grok fallback.
    throw new Error(
      "MCP source not yet wired — run `npm run skill:mcp-probe` to inspect the server, then implement mapping in lib/x/mcp-source.ts",
    );
  },
};
