/**
 * The name agents give Aimpoint's MCP server in their own MCP client (VEC-198). The product was called Vector, and
 * bots set up before the rename have the server as "vector" (their tools are mcp__vector__*), so wake-ups name the
 * server the way each bot actually has it until it reinstalls. Client-safe: no server-only imports.
 */
export const MCP_SERVER_NAME = "aimpoint";
export const LEGACY_MCP_SERVER_NAME = "vector";
export type McpServerName = typeof MCP_SERVER_NAME | typeof LEGACY_MCP_SERVER_NAME;

export const isMcpServerName = (v: unknown): v is McpServerName => v === MCP_SERVER_NAME || v === LEGACY_MCP_SERVER_NAME;

interface NamedBot {
  /** Recorded when the bot is created or Hermes installs the server. Unset = set up before the rename. */
  mcpServerName?: string | null;
  connection?: { method?: string } | null;
}

/** The server name this bot's MCP client uses. Claude/OpenAI connections get the server per request, so always the new name. */
export function mcpServerNameFor(bot: NamedBot): McpServerName {
  const method = bot.connection?.method;
  if (method === "claude-api" || method === "openai-api") return MCP_SERVER_NAME;
  return isMcpServerName(bot.mcpServerName) ? bot.mcpServerName : LEGACY_MCP_SERVER_NAME;
}

/** One clause for bots still on the old name, so "the `vector` tools" doesn't read as another product. Empty otherwise. */
export const legacyMcpNote = (bot: NamedBot) =>
  mcpServerNameFor(bot) === LEGACY_MCP_SERVER_NAME ? " (Aimpoint was called Vector, and your MCP client still has its server under that name)" : "";
