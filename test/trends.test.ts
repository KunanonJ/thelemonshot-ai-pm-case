import { describe, expect, it } from "vitest";
import { proposalBriefSchema } from "../src/worker/products/proposal/brief";
import { buildAssumptions } from "../src/worker/products/proposal/document";
import { TEMPLATES } from "../src/worker/products/proposal/templates";
import { buildTrendBrief, templateAngle, type TermRow } from "../src/worker/products/trends/brief";
import { clusterPosts, MAX_THEMES, postTags, STOP_TAGS } from "../src/worker/products/trends/cluster";
import { dedupePosts, type TrendHit, type UniquePost } from "../src/worker/products/trends/dedupe";
import { applyThemeNarrative, buildThemePrompt, themeNarrativeJsonSchema, TREND_PROMPT_VERSION } from "../src/worker/products/trends/contract";
import { guardTrendText, platformWideWording, sanitiseExcerpt } from "../src/worker/products/trends/guard";
import { hashtagsOf, parseInstagramItems, parseTikTokItems, type ParsedPost } from "../src/worker/products/trends/parse";
import { byEngagement, engagementOf, themeStats, windowOf } from "../src/worker/products/trends/stats";
import { actorRequest, displayLabel, termInputSchema, termKey, watchTokens } from "../src/worker/products/trends/terms";
import { MIN_SUPPORT } from "../src/worker/products/trends/model";

const oct = (day: number) => Date.UTC(2026, 9, day);

// A post as the dedupe step sees it, with its store row ID
function post(platform: "instagram" | "tiktok", id: string, o: Partial<UniquePost> = {}): UniquePost {
  return {
    platform,
    platformPostId: id,
    url: `https://example.test/${platform}/${id}`,
    handle: "demo.food1",
    caption: null,
    hashtags: [],
    postedAt: null,
    likes: null,
    comments: null,
    views: null,
    shares: null,
    id: `row-${platform}-${id}`,
    key: `${platform}:${id}`,
    matchedTerms: [],
    categories: [],
    hits: 1,
    ...o,
  };
}

function parsed(platform: "instagram" | "tiktok", id: string, o: Partial<ParsedPost> = {}): ParsedPost {
  const { id: _id, key: _key, matchedTerms: _m, categories: _c, hits: _h, ...rest } = post(platform, id, o);
  return rest;
}

const term = (id: string, label: string, platform: "instagram" | "tiktok", status: string, postCount: number | null, extra: Partial<TermRow> = {}): TermRow => ({
  id,
  label,
  category: "food_snacks",
  platform,
  status,
  postCount,
  note: null,
  error: null,
  ...extra,
});

describe("terms and actor input (FR-TM-1)", () => {
  it("normalises hashtags and keywords for de-duplication", () => {
    expect(termKey("  #Snack  ")).toBe("snack");
    expect(termKey("Desk  Snack Review")).toBe("desk snack review");
    expect(displayLabel("hashtag", "#snack")).toBe("#snack");
    expect(displayLabel("keyword", "desk snack")).toBe("desk snack");
  });

  it("refuses a hashtag with spaces and accepts a keyword with spaces, with the 30-post default cap", () => {
    const spaced = termInputSchema.safeParse({ term: "snack review", kind: "hashtag", platforms: ["tiktok"], category: "food_snacks" });
    expect(spaced.success).toBe(false);
    const keyword = termInputSchema.parse({ term: "snack review", kind: "keyword", platforms: ["tiktok"], category: "food_snacks" });
    expect(keyword.postCap).toBe(30);
  });

  it("builds the Store input for each platform and term kind", () => {
    const ig = actorRequest("instagram", "hashtag", "#snack", 30);
    expect(ig.actor).toBe("apify~instagram-hashtag-scraper");
    expect(ig.input).toEqual({ hashtags: ["snack"], resultsType: "posts", resultsLimit: 30 });
    expect(actorRequest("instagram", "keyword", "desk snack", 12).input).toEqual({ hashtags: ["desk snack"], resultsType: "posts", resultsLimit: 12, keywordSearch: true });
    expect(actorRequest("tiktok", "hashtag", "#snack", 30).input).toEqual({ hashtags: ["snack"], resultsPerPage: 30 });
    const tk = actorRequest("tiktok", "keyword", "desk snack", 30);
    expect(tk.actor).toBe("clockworks~tiktok-scraper");
    expect(tk.input).toEqual({ searchQueries: ["desk snack"], resultsPerPage: 30 });
  });

  it("watches the term's own tags so the term never becomes a theme", () => {
    expect(watchTokens("hashtag", "#Snack")).toEqual(["snack"]);
    expect(watchTokens("keyword", "desk snack")).toEqual(["desk snack", "desk", "snack"]);
  });
});

describe("parsing Apify items (FR-TM-2 links)", () => {
  it("reads Instagram hashtag items, hides -1 likes as a gap and keeps the post's own link", () => {
    const { posts, errorCodes } = parseInstagramItems([
      {
        shortCode: "DQt1",
        id: "3759",
        url: "https://www.instagram.com/p/DQt1/",
        ownerUsername: "Demo.Food3",
        caption: "Crunchy #snackhack #ขนมอร่อย",
        hashtags: ["snackdeal"],
        timestamp: "2026-10-01T10:00:00.000Z",
        likesCount: -1,
        commentsCount: 4,
        videoPlayCount: 900,
      },
      { errorCode: "NOT_FOUND" },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ platform: "instagram", platformPostId: "DQt1", handle: "demo.food3", likes: null, comments: 4, views: 900 });
    expect(posts[0]!.hashtags).toEqual(["snackdeal", "snackhack", "ขนมอร่อย"]);
    expect(posts[0]!.postedAt).toBe(Date.parse("2026-10-01T10:00:00.000Z"));
    expect(errorCodes).toEqual(["NOT_FOUND"]);
  });

  it("builds the canonical Instagram link when the actor's URL does not name the post", () => {
    const { posts } = parseInstagramItems([{ shortCode: "AB12", url: "https://www.instagram.com/someone/", ownerUsername: "a" }]);
    expect(posts[0]!.url).toBe("https://www.instagram.com/p/AB12/");
  });

  it("reads TikTok video items, keeps error items as notes and drops items with no link", () => {
    const { posts, errorCodes } = parseTikTokItems([
      {
        id: "7400123",
        text: "Desk snack #snackhack",
        webVideoUrl: "https://www.tiktok.com/@demo.food5/video/7400123",
        createTimeISO: "2026-10-02T08:00:00.000Z",
        playCount: 5000,
        diggCount: 300,
        commentCount: 12,
        shareCount: 7,
        hashtags: [{ name: "snackhack" }],
        authorMeta: { name: "demo.food5" },
      },
      { url: "https://www.tiktok.com/search?q=x", input: "x", error: "Search query not found", errorCode: "SEARCH_QUERY_NOT_FOUND" },
      { id: "9", authorMeta: {} },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ platformPostId: "7400123", handle: "demo.food5", likes: 300, comments: 12, shares: 7, views: 5000 });
    expect(posts[0]!.hashtags).toEqual(["snackhack"]);
    expect(errorCodes).toEqual(["SEARCH_QUERY_NOT_FOUND"]);
  });

  it("reads TikTok seconds-based createTime when the ISO time is missing", () => {
    const { posts } = parseTikTokItems([{ id: "1", webVideoUrl: "https://www.tiktok.com/@a/video/1", createTime: 1756403075, authorMeta: { name: "a" } }]);
    expect(posts[0]!.postedAt).toBe(1756403075000);
  });

  it("takes tags from the list and the caption, without duplicates", () => {
    expect(hashtagsOf(["#Snack", "snack"], "love it #snack #deal")).toEqual(["snack", "deal"]);
  });
});

describe("dedupe by platform post ID (FR-TM-1)", () => {
  it("counts a post found by two terms once, with both terms and the highest metrics", () => {
    const first = parsed("tiktok", "1", { likes: 10, comments: null, hashtags: ["snackdeal"] });
    const second = parsed("tiktok", "1", { likes: 40, comments: 3, hashtags: ["snackhack"] });
    const hits: TrendHit[] = [
      { pullTermId: "t1", label: "#snack", category: "food_snacks", postRowId: "row-1", post: first },
      { pullTermId: "t2", label: "#crunch", category: "beauty", postRowId: "row-1", post: second },
    ];
    const { posts, duplicatesRemoved } = dedupePosts(hits);
    expect(posts).toHaveLength(1);
    expect(duplicatesRemoved).toBe(1);
    expect(posts[0]!.matchedTerms).toEqual(["#snack", "#crunch"]);
    expect(posts[0]!.categories).toEqual(["food_snacks", "beauty"]);
    expect(posts[0]!.likes).toBe(40);
    expect(posts[0]!.comments).toBe(3);
    expect(posts[0]!.hashtags).toEqual(["snackdeal", "snackhack"]);
  });

  it("keeps the same numeric ID on two platforms as two posts", () => {
    const hits: TrendHit[] = [
      { pullTermId: "a", label: "#snack", category: "food_snacks", postRowId: "r1", post: parsed("instagram", "55") },
      { pullTermId: "b", label: "#snack", category: "food_snacks", postRowId: "r2", post: parsed("tiktok", "55") },
    ];
    expect(dedupePosts(hits).posts).toHaveLength(2);
  });
});

describe("clustering on hashtags (deterministic)", () => {
  it("ignores watched terms, stop tags and one-off tags", () => {
    const p = post("tiktok", "1", { hashtags: ["snack", "fyp", "snackdeal", "2026", "x"] });
    expect(postTags(p, new Set(["snack"]))).toEqual(["snackdeal"]);
    expect(STOP_TAGS.has("fyp")).toBe(true);
  });

  it("seeds a theme from a tag used by at least two posts, and leaves single-use tags out", () => {
    const posts = [
      post("tiktok", "1", { hashtags: ["snackdeal"] }),
      post("tiktok", "2", { hashtags: ["snackdeal", "crispy"] }),
      post("tiktok", "3", { hashtags: ["lonely"] }),
    ];
    const clusters = clusterPosts(posts, []);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.seedTag).toBe("snackdeal");
    expect(clusters[0]!.postKeys).toEqual(["tiktok:1", "tiktok:2"]);
    expect(clusters[0]!.tags).toEqual(["snackdeal", "crispy"]);
  });

  it("is deterministic and never returns more than the theme cap", () => {
    const posts: UniquePost[] = [];
    for (let t = 0; t < 12; t++) {
      for (let i = 0; i < 2; i++) posts.push(post("tiktok", `${t}-${i}`, { hashtags: [`tag${t}`] }));
    }
    const first = clusterPosts(posts, []);
    expect(clusterPosts(posts, [])).toEqual(first);
    expect(first).toHaveLength(MAX_THEMES);
  });
});

describe("within-sample growth signals (FR-TM-3)", () => {
  it("measures the window and the share of dated posts in its newer half", () => {
    const posts = [
      post("tiktok", "1", { postedAt: oct(1) }),
      post("tiktok", "2", { postedAt: oct(4) }),
      post("tiktok", "3", { postedAt: oct(5) }),
      post("tiktok", "4", { postedAt: oct(6) }),
      post("tiktok", "5", { postedAt: oct(6) }),
      post("tiktok", "6", { postedAt: null }),
    ];
    expect(windowOf(posts)).toEqual({ from: oct(1), to: oct(6) });
    const members = [posts[1]!, posts[2]!, posts[0]!];
    const s = themeStats(members, posts, windowOf(posts));
    expect(s.shareOfPostsPct).toBe(50);
    expect(s.recentPosts).toBe(2);
    expect(s.recentSharePct).toBe(67);
    expect(s.rising).toBe(true);
  });

  it("gives no window when fewer than two posts are dated or all share one time", () => {
    expect(windowOf([post("tiktok", "1", { postedAt: oct(1) }), post("tiktok", "2")])).toBeNull();
    expect(windowOf([post("tiktok", "1", { postedAt: oct(1) }), post("tiktok", "2", { postedAt: oct(1) })])).toBeNull();
  });

  it("measures engagement concentration only with three engaged posts, and ranks by engagement", () => {
    const members = [
      post("tiktok", "1", { likes: 100, comments: 0 }),
      post("tiktok", "2", { likes: 50, comments: 0 }),
      post("tiktok", "3", { likes: 10, comments: 0 }),
      post("tiktok", "4", { likes: 5, comments: 0 }),
    ];
    expect(themeStats(members, members, null).topThreeEngagementSharePct).toBe(97);
    expect(themeStats(members.slice(0, 2), members, null).topThreeEngagementSharePct).toBeNull();
    expect([...members].sort(byEngagement)[0]!.key).toBe("tiktok:1");
    expect(engagementOf(post("tiktok", "9"))).toBeNull();
  });
});

describe("brief assembly (AC-TM-1, BR-TM-1, BR-TM-2)", () => {
  const set: UniquePost[] = [
    post("tiktok", "1", { hashtags: ["snackdeal", "snackhack"], postedAt: oct(1), likes: 100, comments: 5, categories: ["food_snacks"], matchedTerms: ["#snack"] }),
    post("tiktok", "2", { hashtags: ["snackdeal"], postedAt: oct(4), likes: 50, comments: 5, categories: ["food_snacks"], matchedTerms: ["#snack"] }),
    post("tiktok", "3", { hashtags: ["snackdeal"], postedAt: oct(5), likes: 20, comments: 5, categories: ["food_snacks"], matchedTerms: ["#snack"] }),
    post("tiktok", "4", { hashtags: ["snackdeal"], postedAt: oct(6), likes: 10, comments: 5, categories: ["food_snacks"], matchedTerms: ["#snack"] }),
    post("instagram", "1", { hashtags: ["seaweedchips"], postedAt: oct(2), categories: ["food_snacks"], matchedTerms: ["#seaweed"] }),
    post("instagram", "2", { hashtags: ["seaweedchips"], postedAt: oct(6), categories: ["food_snacks"], matchedTerms: ["#seaweed"] }),
    post("tiktok", "9", { hashtags: ["random"], postedAt: oct(3), categories: ["food_snacks"], matchedTerms: ["#snack"] }),
  ];
  const terms: TermRow[] = [
    term("t1", "#snack", "tiktok", "ok", 5),
    term("t2", "#seaweed", "instagram", "ok", 2),
    term("t3", "#seaweed", "tiktok", "ok", 0, { note: "Apify returned SEARCH_QUERY_NOT_FOUND" }),
  ];

  it("names every theme with real pulled posts, labels the thin one a weak signal, and links exemplars", () => {
    const brief = buildTrendBrief({ terms, posts: set, hits: 9, duplicatesRemoved: 2, watched: ["snack", "seaweed"] });
    const urls = new Set(set.map((p) => p.url));
    expect(brief.themes).toHaveLength(2);
    for (const theme of brief.themes) {
      expect(theme.sources.length).toBeGreaterThanOrEqual(1);
      for (const s of theme.sources) expect(urls.has(s.url)).toBe(true);
    }
    const weak = brief.themes.find((t) => t.seedTag === "seaweedchips")!;
    expect(weak.postCount).toBeLessThan(MIN_SUPPORT);
    expect(weak.weakSignal).toBe(true);
    expect(weak.summary).toContain("weak signal");
    const strong = brief.themes.find((t) => t.seedTag === "snackdeal")!;
    expect(strong.weakSignal).toBe(false);
    // Three of its four dated posts fall in the newer half of the pulled window (days 4 to 6 of 1 to 6)
    expect(strong.stats.recentSharePct).toBe(75);
    expect(strong.rising).toBe(true);
    expect(strong.summary).toContain("In this pull, 4 of the 7 unique posts use #snackdeal.");
    expect(brief.exemplars.length).toBeGreaterThan(0);
    expect(brief.exemplars.length).toBeLessThanOrEqual(5);
    const themed = new Set(brief.themes.flatMap((t) => t.sources.map((s) => s.url)));
    for (const e of brief.exemplars) expect(themed.has(e.url)).toBe(true);
    expect(brief.sample).toMatchObject({ uniquePosts: 7, duplicatesRemoved: 2, otherPosts: 1, termRuns: 3 });
    expect(brief.flags).toContain("weak_signal_themes:1");
  });

  it("gives a zero-post term an explicit empty note and no theme (BR-TM-1)", () => {
    const brief = buildTrendBrief({ terms, posts: set, hits: 9, duplicatesRemoved: 0, watched: ["snack", "seaweed"] });
    const empty = brief.sources.find((s) => s.text.startsWith("No signal in this pull for #seaweed on TikTok"));
    expect(empty).toMatchObject({ level: "info", pullTermId: "t3" });
    expect(empty!.text).toContain("Apify returned SEARCH_QUERY_NOT_FOUND.");
    expect(brief.sample.zeroSignalRuns).toEqual(["#seaweed on TikTok"]);
    expect(brief.flags).toContain("zero_signal_runs:1");
  });

  it("degrades to the other platform with a source note when one actor fails (BR-TM-2)", () => {
    const failing: TermRow[] = [term("a", "#snack", "instagram", "failed", null, { error: "Apify run ended as FAILED" }), term("b", "#snack", "tiktok", "ok", 4)];
    const brief = buildTrendBrief({ terms: failing, posts: set.slice(0, 4), hits: 4, duplicatesRemoved: 0, watched: ["snack"] });
    const note = brief.sources.find((s) => s.level === "warning");
    expect(note!.text).toBe("Instagram pull for #snack failed: Apify run ended as FAILED. #snack is covered by TikTok only.");
    expect(brief.themes.length).toBeGreaterThan(0);
    expect(brief.flags).toContain("source_failed:1");
  });

  it("returns no themes and says so when nothing was pulled", () => {
    const brief = buildTrendBrief({ terms: [term("t", "#snack", "tiktok", "ok", 0)], posts: [], hits: 0, duplicatesRemoved: 0, watched: ["snack"] });
    expect(brief.themes).toEqual([]);
    expect(brief.exemplars).toEqual([]);
    expect(brief.flags).toContain("no_posts");
  });

  it("maps a pitch angle to each brand category of the theme, starting from a template", () => {
    const multi = [
      post("tiktok", "1", { hashtags: ["snackdeal"], categories: ["food_snacks", "beauty"] }),
      post("tiktok", "2", { hashtags: ["snackdeal"], categories: ["beauty"] }),
    ];
    const [theme] = buildTrendBrief({ terms: [], posts: multi, hits: 2, duplicatesRemoved: 0, watched: [] }).themes;
    expect(theme!.pitchAngles.map((p) => p.category)).toEqual(["beauty", "food_snacks"]);
    expect(theme!.pitchAngles.every((p) => p.source === "template")).toBe(true);
    expect(theme!.pitchAngles[0]!.angle).toBe(templateAngle("beauty", "snackdeal"));
  });
});

describe("guards (FR-TM-3, HR-3, FR-CORE-17)", () => {
  it("flags platform-wide wording in English and Thai, and leaves within-sample wording alone", () => {
    expect(platformWideWording("This is trending on TikTok right now")).toBe(true);
    expect(platformWideWording("Creators across the platform are doing this")).toBe(true);
    expect(platformWideWording("ทั้งแพลตฟอร์มกำลังฮิต")).toBe(true);
    expect(platformWideWording("In this pull, 4 of the 9 posts use the tag.")).toBe(false);
  });

  it("drops platform-wide text instead of rewriting it, and marks unsupported figures TBC", () => {
    expect(guardTrendText("Works across TikTok as a whole", [])).toEqual({ text: null, figuresReplaced: 0, platformWide: true });
    expect(guardTrendText("Of the 9 posts pulled, 4 use it.", [9, 4])).toEqual({ text: "Of the 9 posts pulled, 4 use it.", figuresReplaced: 0, platformWide: false });
    expect(guardTrendText("Engagement is 45% higher", [9]).text).toBe("Engagement is TBC higher");
  });

  it("strips links, e-mail addresses and phone numbers from captions sent to the model", () => {
    expect(sanitiseExcerpt("Order at https://shop.example.test/x or mail me@example.test, call 081-234-5678")).toBe(
      "Order at [link] or mail [email], call [number]",
    );
  });
});

describe("model contract (FR-CORE-15, FR-CORE-17, FR-TM-3)", () => {
  const posts = [
    post("tiktok", "1", { hashtags: ["snackdeal"], postedAt: oct(1), caption: "Buy at https://shop.example.test", likes: 4, categories: ["food_snacks"] }),
    post("tiktok", "2", { hashtags: ["snackdeal"], postedAt: oct(6), caption: "Call 081-234-5678 now", likes: 9, categories: ["food_snacks"] }),
    post("tiktok", "3", { hashtags: ["snackdeal"], postedAt: oct(3), caption: "Snack break", categories: ["food_snacks"] }),
  ];
  const brief = buildTrendBrief({ terms: [term("t", "#snackdeal", "tiktok", "ok", 3)], posts, hits: 3, duplicatesRemoved: 0, watched: [] });

  it("sends computed numbers and sanitised captions, and states the within-sample rule", () => {
    const prompt = buildThemePrompt({ terms: [term("t", "#snackdeal", "tiktok", "ok", 3)], uniquePosts: 3, themes: brief.themes, posts });
    expect(prompt.user).not.toContain("https://");
    expect(prompt.user).not.toContain("081-234-5678");
    expect(prompt.user).toContain("[link]");
    expect(prompt.system).toContain("All quantitative language is within this pull");
    expect(prompt.system).toContain(`{"themes"`);
    expect(prompt.figures).toContain(3);
    expect(TREND_PROMPT_VERSION).toBe("trends-v1");
    expect(themeNarrativeJsonSchema().name).toBe("trend_themes");
    expect(themeNarrativeJsonSchema().schema).not.toHaveProperty("$schema");
  });

  it("keeps the model's names and angles when they pass the guards, and drops answers for unknown themes", () => {
    const theme = brief.themes[0]!;
    const raw = {
      themes: [
        {
          id: theme.id,
          name: "Desk snack breaks",
          summary: "Of the 3 posts pulled, 2 show a snack break at a desk.",
          pitchAngles: [{ category: "food_snacks", angle: "Film a three-post desk snack break series." }],
        },
        { id: "theme-99", name: "Ghost theme", summary: "Not in the brief.", pitchAngles: [] },
      ],
    };
    const applied = applyThemeNarrative(brief.themes, raw, [3, 2]);
    expect(applied.themes[0]!.name).toBe("Desk snack breaks");
    expect(applied.themes[0]!.pitchAngles[0]).toMatchObject({ source: "model", angle: "Film a three-post desk snack break series." });
    expect(applied.flags).toEqual(["items_dropped:1"]);
  });

  it("falls back to the deterministic sentence for platform-wide wording and marks figures it cannot trace", () => {
    const theme = brief.themes[0]!;
    const applied = applyThemeNarrative(
      brief.themes,
      {
        themes: [
          { id: theme.id, name: "Snack break", summary: "Trending across TikTok everywhere.", pitchAngles: [{ category: "food_snacks", angle: "Lift sales by 40%." }] },
        ],
      },
      [3],
    );
    expect(applied.themes[0]!.summary).toBe(theme.summary);
    // The untraceable figure is marked TBC in place; the angle itself is kept
    expect(applied.themes[0]!.pitchAngles[0]).toMatchObject({ source: "model", angle: "Lift sales by TBC." });
    expect(applied.flags).toEqual(expect.arrayContaining(["platform_wording_removed:1", "figures_replaced:1"]));
  });

  it("matches model angles to the theme's own categories only", () => {
    const theme = brief.themes[0]!;
    const applied = applyThemeNarrative(brief.themes, { themes: [{ id: theme.id, name: theme.name, summary: theme.summary, pitchAngles: [{ category: "beauty", angle: "Serum demo." }] }] }, [3]);
    expect(applied.themes[0]!.pitchAngles.map((p) => p.category)).toEqual(["food_snacks"]);
    expect(applied.themes[0]!.pitchAngles[0]!.source).toBe("template");
    expect(applied.flags).toContain("items_dropped:1");
  });
});

describe("proposal assumptions (AC-TM-2)", () => {
  const brief = proposalBriefSchema.parse({ template: "standard", brand: "Crunchy Co", product: "Seaweed chips", objective: "awareness", budgetBand: "100k_500k" });
  const base = { brief, template: TEMPLATES[brief.template], shortlist: null, attached: false, model: null, sampleData: false };

  it("adds one line per attached trend brief, stating that its figures are within the sample", () => {
    const lines = buildAssumptions({
      ...base,
      trends: [{ runId: "9f8e7d6c-5b4a-4321-8765-0fedcba98765", approvedAt: oct(2), terms: ["#snack", "#seaweed"], uniquePosts: 27, themeCount: 3, weakThemes: 1, risingThemes: 1 }],
    });
    const line = lines.find((l) => l.startsWith("Trend brief 9f8e7d6c"));
    expect(line).toContain("27 unique public posts pulled for #snack, #seaweed.");
    expect(line).toContain("3 themes, 1 marked weak signal and 1 rising within the pull.");
    expect(line).toContain("not the platforms as a whole.");
  });

  it("leaves the assumptions unchanged when no trend brief is attached", () => {
    expect(buildAssumptions(base)).toEqual(buildAssumptions({ ...base, trends: [] }));
    expect(buildAssumptions(base).some((l) => l.startsWith("Trend brief"))).toBe(false);
  });
});
