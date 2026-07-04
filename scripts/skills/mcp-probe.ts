/**
 * mcp-probe skill CLI — connect to the official X MCP server and dump the
 * tools (names + descriptions + input schemas) it exposes. READ-ONLY: it only
 * lists capabilities, it never posts, bookmarks, or extracts.
 *
 * This is the prerequisite for wiring lib/x/mcp-source.ts: the X MCP docs list
 * capability groups, not verbatim tool names, so we must inspect a live server
 * before mapping its responses to PostExtraction.
 *
 *   npm run skill:mcp-probe
 *
 * Config (env, credentials are yours — never committed):
 *   X_MCP_URL           MCP endpoint (default https://api.x.com/mcp)
 *   X_MCP_BEARER_TOKEN  bearer for the MCP endpoint; falls back to
 *                       X_API_BEARER_TOKEN (app-only, read access)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const url = process.env.X_MCP_URL ?? "https://api.x.com/mcp";
  const bearer =
    process.env.X_MCP_BEARER_TOKEN ?? process.env.X_API_BEARER_TOKEN;

  if (!bearer) {
    console.error(
      "No bearer token. Set X_MCP_BEARER_TOKEN (or X_API_BEARER_TOKEN) in .env.local.",
    );
    process.exit(1);
  }

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearer}` },
    },
  });

  const client = new Client({
    name: "x-bookmark-harvester-probe",
    version: "0.1.0",
  });

  console.error(`[mcp-probe] connecting to ${url} …`);
  await client.connect(transport);

  const server = client.getServerVersion();
  const capabilities = client.getServerCapabilities();

  const tools = await client.listTools().catch((e) => {
    console.error(`[mcp-probe] listTools failed: ${(e as Error).message}`);
    return { tools: [] };
  });

  // Resources/prompts are optional — probe them best-effort.
  const resources = capabilities?.resources
    ? await client.listResources().catch(() => ({ resources: [] }))
    : { resources: [] };
  const prompts = capabilities?.prompts
    ? await client.listPrompts().catch(() => ({ prompts: [] }))
    : { prompts: [] };

  // Human-readable summary → stderr, so stdout stays clean JSON.
  console.error(
    `\n[mcp-probe] ${server?.name ?? "server"} ${server?.version ?? ""} — ${tools.tools.length} tool(s):`,
  );
  for (const t of tools.tools) {
    console.error(`  • ${t.name}${t.description ? ` — ${t.description}` : ""}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: url,
        server,
        capabilities,
        tools: tools.tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
          inputSchema: t.inputSchema,
        })),
        resources: resources.resources,
        prompts: prompts.prompts,
      },
      null,
      2,
    ),
  );

  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
