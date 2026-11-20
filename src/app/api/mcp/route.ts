import { authenticateBot } from "@/lib/bots";
import { MCP_SERVER_NAME } from "@/lib/mcp-name";
import { callTool, listTools, SERVER_INSTRUCTIONS, UnknownToolError, type McpCtx } from "@/lib/mcp/server";

/**
 * Aimpoint's MCP server: Streamable HTTP, stateless. Each POST carries one JSON-RPC message (or a batch)
 * and gets a JSON response. Bots authenticate with their API key as a Bearer token.
 */

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
interface RpcMessage {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });

async function handle(msg: RpcMessage, ctx: McpCtx) {
  const id = msg.id ?? null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(id, -32600, "Invalid request");
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: `Aimpoint · ${ctx.org.name}`, version: "0.1.0" },
        instructions: `${SERVER_INSTRUCTIONS}\nYou are ${ctx.bot.name}${ctx.bot.description ? ` (${ctx.bot.description})` : ""} in ${ctx.org.name}.`,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: await listTools(ctx.bot) });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      try {
        return rpcResult(id, await callTool(name, args, ctx));
      } catch (err) {
        if (err instanceof UnknownToolError) return rpcError(id, -32602, err.message);
        throw err;
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(req: Request) {
  const auth = await authenticateBot(req);
  if (!auth) {
    return Response.json(rpcError(null, -32001, "Missing or invalid API key. Send the bot's key as `Authorization: Bearer <key>`."), {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer realm="${MCP_SERVER_NAME}"` },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const origin = new URL(req.url).origin;
  const ctx: McpCtx = { ...auth, actor: { orgId: auth.org._id, id: auth.bot._id, isAdmin: false, isBot: true }, origin };
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcMessage[];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") {
      out.push(rpcError(null, -32600, "Invalid request"));
      continue;
    }
    // Notifications and client responses get no reply.
    if (m.id === undefined || m.method === undefined) continue;
    try {
      out.push(await handle(m, ctx));
    } catch (err) {
      console.error("[mcp]", err);
      out.push(rpcError(m.id ?? null, -32603, process.env.NODE_ENV === "production" ? "Internal error" : `Internal error: ${(err as Error).message}`));
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}

/** No server-initiated stream and no sessions: GET and DELETE aren't offered. */
export function GET() {
  return new Response("Aimpoint's MCP endpoint takes JSON-RPC over POST.", { status: 405, headers: { Allow: "POST" } });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
