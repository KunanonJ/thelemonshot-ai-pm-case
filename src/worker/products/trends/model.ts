// ② Trend Monitoring: the shapes a brief stores and the UI reads. No runtime imports, so the pure modules and
// the unit tests can use these without the Workers runtime.

// FR-TM-2: a theme with fewer supporting posts than this is labelled a weak signal
export const MIN_SUPPORT = 3;
// A theme is rising within this pull when at least this share of its dated posts fall in the newer half of the window
export const RISING_RECENT_SHARE = 60;
// Linked exemplar posts per brief (the PRD asks for 3 to 5; a thin pull can have fewer)
export const EXEMPLAR_COUNT = 5;

export type SourcePost = { postId: string; platform: string; url: string; handle: string | null; postedAt: number | null };

// Within-sample numbers only: shares of the posts pulled in this run (FR-TM-3)
export type TrendThemeStats = {
  shareOfPostsPct: number;
  datedPosts: number;
  recentPosts: number;
  recentSharePct: number | null;
  topThreeEngagementSharePct: number | null;
};

export type PitchAngle = { category: string; angle: string; source: "model" | "template" };

export type TrendTheme = {
  id: string;
  seedTag: string;
  tags: string[];
  name: string;
  summary: string;
  postCount: number;
  weakSignal: boolean;
  rising: boolean;
  categories: string[];
  platforms: string[];
  stats: TrendThemeStats;
  pitchAngles: PitchAngle[];
  // Every supporting post, linked (FR-TM-2)
  sources: SourcePost[];
};

export type TrendExemplar = {
  postId: string;
  themeId: string;
  platform: string;
  url: string;
  handle: string | null;
  postedAt: number | null;
  engagement: number | null;
};

export type SourceNote = { level: "info" | "warning"; pullTermId: string | null; text: string };

export type TrendSample = {
  hits: number;
  uniquePosts: number;
  duplicatesRemoved: number;
  postsByPlatform: Record<string, number>;
  otherPosts: number;
  window: { from: number; to: number } | null;
  termRuns: number;
  zeroSignalRuns: string[];
  failedRuns: string[];
};
