import { botRoute } from "@/lib/bot-api";

/** GET /api/v1/me: the bot this key belongs to and its organisation. */
export const GET = botRoute(async (_req, { bot, org }) => ({
  bot: { id: bot._id.toHexString(), name: bot.name, description: bot.description },
  organisation: { id: org._id.toHexString(), name: org.name, slug: org.slug },
}));
