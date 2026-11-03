# Tonight: switching Phase 0 and Phase 1 on

Everything below runs on `https://lemonshot.kunanonj.com`. Steps 1 to 3 are Fronk's (accounts and secrets); the rest are mine.

## 1. Keys (Fronk, phone is fine)

1. Clerk (dashboard.clerk.com): create an application; a development instance is enough. Copy the Publishable key and Secret key.
2. Cloudflare (dash.cloudflare.com), GoGoCash account: Workers & Pages, `lemon-shot-suite`, Settings, Variables and Secrets. Add each as type **Secret**:
   - `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`
   - `OPENCODE_API_KEY` (OpenCode Console; paid credit is needed, free models only work inside the OpenCode app)
   - `APIFY_TOKEN`
   - `YOUTUBE_API_KEY` (Google Cloud, with YouTube Data API v3 enabled)

## 2. Admin role (Fronk)

1. Sign in once at the site.
2. Clerk dashboard, Users, your user, Metadata, Public: `{"role": "admin"}`.
3. Wait a minute (roles are cached for 60 seconds), open **System**, press **Verify my session**.

## 3. Phase 0 completes on its own

The cron runs every 5 minutes and passes each check as soon as its secret exists. Bindings and pptx have already passed. A watcher on the Mac tells me when Clerk, OpenCode and both Apify checks finish.

## 4. Mine, once Phase 0 passes

1. Read the Apify samples saved in R2 (`phase0/apify-instagram-sample.json`, `phase0/apify-tiktok-sample.json`) and adjust the normalisers if a field name differs from the actor docs.
2. Run discovery for Food & snacks and Beauty (Creators, Find creators). Inputs: 4 hashtags per platform, 25 posts each, up to 35 new creators per platform. Estimated Apify spend at the listed per-result prices: roughly USD 5 to 6 for both categories, mostly TikTok profile enrichment.
3. Fronk curates the roster (deactivate anyone off-topic).
4. Run the Phase 1 acceptance criteria on the deployed URL:
   - AC-MX-1: a Food & snacks brief with at least 40 eligible creators returns 10 to 15 rows, each with a rationale or the "unavailable" flag, within 15 minutes.
   - AC-MX-2: a must-include and must-exclude conflict is shown before the run starts.
   - AC-MX-3: System, Force LLM failure on, run a brief, confirm data-only scores with flags and no error screen, switch it off.
   - AC-MX-4: add a creator whose handles don't exist on any platform; it lands in dead letters and in the run's "No usable data" list; other rows are unaffected.
   - AC-MX-5: swap #3 for an alternate, approve, export; the run log keeps the original ranking and the final picks.
5. Switch the cron from every 5 minutes to hourly once Phase 0 has passed.
6. Phase 1 report: deployed URL, AC results, spec conflicts, and screenshots of the main flow at desktop width, light theme, with sample-data labels visible.

## 5. Phase 2 (④ Campaign Proposal), after the Phase 1 report

Already deployed; it needs the same keys. On the deployed URL:

1. AC-CP-1: Campaign Proposal, New proposal, standard template, attach the approved Food & snacks shortlist from AC-MX-1. Time from submit to approval and export (target under 20 minutes). Check every creator row shows its Matrix evidence.
2. AC-CP-2: a second proposal with "No shortlist for now". Approve, export HTML, check the creator section is the explicit empty text and no roster name or handle appears.
3. AC-CP-3: regenerate the big idea as three alternatives; check the other sections keep their version numbers and the history lists every version.
4. BR-CP-2: System, Force LLM failure on, draft a proposal, confirm the failed sections show template drafts with Retry and approval is blocked; switch it off and retry one section.
5. Fronk: open one exported PPTX in PowerPoint or Keynote; I could only check its structure here.
6. Phase 2 report with screenshots (editor with flags, history drawer, preview, exported deck).
