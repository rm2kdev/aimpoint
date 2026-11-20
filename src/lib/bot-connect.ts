/**
 * Bot backends. Client-safe: the connect wizard renders this, the server validates against it and
 * src/lib/bot-dispatch.ts calls the backends.
 *
 * The model: an admin picks the backend that runs a bot and fills in its settings here in Aimpoint.
 * When the bot is assigned a task or @mentioned, Aimpoint calls that backend with the task and its
 * thread, and the agent acts on the ticket through Aimpoint's MCP tools.
 */
import type { BotAgent, BotMethod } from "@/lib/types";

export interface SecretField {
  label: string;
  placeholder: string;
  /** Offer "make one for me" (Aimpoint generates it, the admin copies it to the other side). */
  canGenerate?: { prefix: string };
}

export interface Backend {
  agent: BotAgent;
  method: BotMethod;
  title: string;
  /** One line under the title in the picker. */
  summary: string;
  /** What has to be true on the other side, shown above the form. */
  requires: string;
  url?: { label: string; placeholder: string; help?: string };
  secret?: SecretField;
  model?: { label: string; placeholder: string; default?: string; help?: string };
  /** Aimpoint hands the provider this bot's own key so it can call Aimpoint's MCP server. */
  needsAimpointKey?: boolean;
  /** Where to get the credential. */
  keyHelp?: { label: string; href: string };
  /** Advanced options sit below the main three. */
  advanced?: boolean;
  /** Aimpoint calls this backend when work arrives. "mcp" is pull-only. */
  push: boolean;
}

export const BACKENDS: Backend[] = [
  {
    agent: "claude",
    method: "claude-api",
    title: "Claude",
    summary: "Aimpoint runs the bot on Claude with your Anthropic API key.",
    requires: "An Anthropic API key. Claude reaches Aimpoint's tools from Anthropic's servers, so Aimpoint has to be on a public https:// address.",
    secret: { label: "Anthropic API key", placeholder: "sk-ant-…" },
    model: { label: "Model", placeholder: "claude-opus-5-5", default: "claude-opus-5-5", help: "Any model id your key can use. Aimpoint checks it when you save." },
    needsAimpointKey: true,
    keyHelp: { label: "Get a key", href: "https://platform.claude.com/settings/keys" },
    push: true,
  },
  {
    agent: "openai",
    method: "openai-api",
    title: "OpenAI",
    summary: "Aimpoint runs the bot on OpenAI's Responses API with your OpenAI API key.",
    requires: "An OpenAI API key. The model reaches Aimpoint's tools from OpenAI's servers, so Aimpoint has to be on a public https:// address.",
    secret: { label: "OpenAI API key", placeholder: "sk-…" },
    model: { label: "Model", placeholder: "Model id from platform.openai.com/docs/models", help: "Any model id your key can use. Aimpoint checks it when you save." },
    needsAimpointKey: true,
    keyHelp: { label: "Get a key", href: "https://platform.openai.com/api-keys" },
    push: true,
  },
  {
    agent: "hermes",
    method: "hermes-api",
    title: "Hermes",
    summary: "Aimpoint starts runs on your Hermes Agent through its Agent API.",
    requires:
      "Hermes with its API server on (API_SERVER_ENABLED=true and an API_SERVER_KEY in its .env). Once Aimpoint can reach it, Aimpoint asks Hermes to install Aimpoint's MCP server with this bot's key, so there's nothing to set up by hand.",
    url: {
      label: "Hermes API URL",
      placeholder: "http://127.0.0.1:8642",
      help: "Where Aimpoint can reach the Hermes API server: port 8642 unless API_SERVER_PORT says otherwise. For a named profile on a shared gateway, end it with /p/<profile>.",
    },
    secret: { label: "API_SERVER_KEY", placeholder: "The API_SERVER_KEY from Hermes's .env", canGenerate: { prefix: "hapi_" } },
    push: true,
  },
  {
    agent: "other",
    method: "webhook",
    title: "Webhook",
    summary: "Aimpoint POSTs a signed event to your URL. For your own agent or service.",
    requires: "An endpoint that answers 2xx within 15 seconds. It acts on the ticket through Aimpoint's MCP server or REST API with this bot's key.",
    url: { label: "Endpoint URL", placeholder: "https://example.com/hooks/aimpoint" },
    secret: { label: "Signing secret", placeholder: "Your signing secret", canGenerate: { prefix: "whsec_" } },
    advanced: true,
    push: true,
  },
  {
    agent: "other",
    method: "mcp",
    title: "MCP only",
    summary: "No push. Your agent connects to Aimpoint's MCP server and calls check_for_work on its own schedule.",
    requires: "An MCP client that speaks Streamable HTTP and sends this bot's key as a Bearer token.",
    advanced: true,
    push: false,
  },
];

export const backendFor = (method: BotMethod) => BACKENDS.find((b) => b.method === method)!;
export const isPush = (method: BotMethod) => BACKENDS.find((b) => b.method === method)?.push ?? false;
export const METHOD_IDS = BACKENDS.map((b) => b.method);

/** Short label for lists: "Claude · claude-opus-5-5", "Hermes", "Webhook". */
export function backendLabel(c: { method: BotMethod; model: string | null }) {
  const b = backendFor(c.method);
  return c.model ? `${b.title} · ${c.model}` : b.title;
}
