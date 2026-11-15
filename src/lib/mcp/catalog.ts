/**
 * The MCP tools Vector exposes to bots. Client-safe: the Bot roles screen renders this list,
 * the MCP server (src/lib/mcp/server.ts) implements it.
 */

export type ToolGroup = "work" | "triage" | "read" | "write";

export interface ToolInfo {
  name: string;
  title: string;
  /** One line for the roles screen. */
  summary: string;
  group: ToolGroup;
  /**
   * Only for bots whose role switches it on: left out for bots without a role and off in new roles.
   * For jobs a bot should only do when an admin has deliberately made it that kind of bot.
   */
  optIn?: boolean;
}

export const TOOL_GROUPS: { id: ToolGroup; title: string; desc: string }[] = [
  { id: "work", title: "Work queue", desc: "Pick up assigned tasks and mentions, and say when the work is finished." },
  {
    id: "triage",
    title: "Triage",
    desc: "Take new Triage tasks and break them into planned work. Off unless a role switches it on, so only bots you make triagers do it.",
  },
  { id: "read", title: "Read", desc: "Look up tasks, projects, statuses and people." },
  { id: "write", title: "Contribute", desc: "Comment, tag people, move and assign tasks, create new ones." },
];

export const MCP_TOOLS: ToolInfo[] = [
  { name: "check_for_work", title: "Check for work", summary: "\"Do I have a task?\" Returns the next mention, close-out of a task it triaged, or assigned task with full context and picks it up.", group: "work" },
  { name: "list_my_tasks", title: "List my tasks", summary: "Tasks assigned to the bot, with whether it has picked each one up.", group: "work" },
  { name: "complete_task", title: "Finish task", summary: "Mark the bot's work on a task as finished, optionally with a final comment and status.", group: "work" },
  { name: "release_task", title: "Release task", summary: "Give a picked-up task back so it is offered again on the next check.", group: "work" },
  {
    name: "check_for_triage",
    title: "Check for triage",
    summary: "Hands the bot the next task waiting in Triage (one bot per task) so it can split it into tasks with dependencies; it's called back to close the task out once they're done.",
    group: "triage",
    optIn: true,
  },
  { name: "get_task", title: "Get task", summary: "Full task: project, description, images, comments and activity.", group: "read" },
  { name: "list_tasks", title: "List tasks", summary: "Search tasks by project, status, assignee or text.", group: "read" },
  { name: "get_workspace", title: "Get workspace", summary: "The organisation's projects, statuses, members and bots.", group: "read" },
  { name: "add_comment", title: "Comment", summary: "Comment on any task and @mention people or bots.", group: "write" },
  { name: "set_status", title: "Move status", summary: "Change a task's status.", group: "write" },
  { name: "assign_task", title: "Assign", summary: "Assign a task to a person, a bot, itself, or nobody.", group: "write" },
  { name: "update_task", title: "Edit task", summary: "Change title, description, type, priority, due date, project, dependencies or manual order.", group: "write" },
  { name: "create_task", title: "Create task", summary: "Create a new task in any project, optionally depending on other tasks.", group: "write" },
];

export const TOOL_NAMES = MCP_TOOLS.map((t) => t.name);

/** Opt-in tools: a role has to switch them on explicitly. */
export const OPT_IN_TOOLS = new Set(MCP_TOOLS.filter((t) => t.optIn).map((t) => t.name));

/** New roles start with every tool allowed except opt-in ones; switch off what the bot shouldn't do. */
export const allToolsAllowed = (): Record<string, boolean> => Object.fromEntries(TOOL_NAMES.map((n) => [n, !OPT_IN_TOOLS.has(n)]));

/** Tools a bot may use. No role = every tool except opt-in ones. Unknown tools in a role default to denied. */
export function allowedTools(role: { tools: Record<string, boolean> } | null | undefined): Set<string> {
  if (!role) return new Set(TOOL_NAMES.filter((n) => !OPT_IN_TOOLS.has(n)));
  return new Set(TOOL_NAMES.filter((n) => role.tools[n] === true));
}
