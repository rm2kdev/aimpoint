/**
 * The name agents give Aimpoint's MCP server in their own MCP client (VEC-198). Every bot uses "aimpoint": bots
 * created since VEC-198 record it, Hermes installs write it, and VEC-319 set it on the last bots that had none
 * (scripts/migrate-connection-fields.mjs), so the pre-rename fallback is gone. Client-safe: no server-only imports.
 */
export const MCP_SERVER_NAME = "aimpoint";
export type McpServerName = typeof MCP_SERVER_NAME;

interface NamedBot {
  /** Recorded when the bot is created or Hermes installs the server. */
  mcpServerName?: string | null;
  connection?: { method?: string } | null;
}

/** The server name this bot's MCP client uses: always "aimpoint". Takes the bot so callers stay per-bot. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function mcpServerNameFor(bot: NamedBot): McpServerName {
  return MCP_SERVER_NAME;
}
