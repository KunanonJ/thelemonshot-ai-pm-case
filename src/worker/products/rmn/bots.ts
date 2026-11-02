// FR-RM-2: basic bot filter. Known crawler and automation user agents are excluded from headline counts and kept
// in the raw log, with the reason. This is a list of common cases, not a detector.
const KNOWN_BOTS =
  /(googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|facebot|twitterbot|linkedinbot|whatsapp|telegrambot|discordbot|slackbot|applebot|petalbot|semrushbot|ahrefsbot|mj12bot|bytespider|gptbot|claudebot|crawler|spider|headlesschrome|phantomjs|lighthouse|pingdom|uptimerobot|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|axios\/|node-fetch|scrapy)/i;

export type UaClass = "human" | "bot";
export type UaVerdict = { uaClass: UaClass; reason: string | null };

// A request with no user agent is treated as automation: real browsers always send one
export function classifyUserAgent(userAgent: string | null | undefined): UaVerdict {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { uaClass: "bot", reason: "empty user agent" };
  const match = KNOWN_BOTS.exec(ua);
  if (match) return { uaClass: "bot", reason: `known bot: ${match[1]!.toLowerCase()}` };
  return { uaClass: "human", reason: null };
}
