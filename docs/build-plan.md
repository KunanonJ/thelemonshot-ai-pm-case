# Lemon Shot AI Suite: build plan

Specs: PRD-01 (normative) and the build brief. Where the two conflict, PRD-01 wins and the conflict is listed under [Flags](#flags-spec-conflicts-and-gaps).

## Decisions made so far

| Topic | Decision |
|---|---|
| Code | This repo, `~/Developer/lemon-shot-suite`. Local git; no GitHub remote until Fronk asks |
| Cloudflare account | GoGoCash (`187ab61ed9dbc6e616cb23e6b95aa8f1`), wrangler logged in as the account owner |
| URL | `https://lemonshot.kunanonj.com` as a Workers Custom Domain. `kunanonj.com` uses Cloudflare nameservers, and the retired IRIS Worker in this account served `iris.kunanonj.com` |
| Sample roster | Apify discovery for two categories (food & snacks, beauty), every record `is_sample = true`; Fronk curates the list |
| Clerk React SDK | `@clerk/react` (see flag 1) |
| Versions (npm, 2 Nov 2026) | wrangler 4.156.1, @cloudflare/vite-plugin 1.67.0, vite 8.3.5, react 19.3.1, tailwindcss 4.3.3, hono 4.13.16, @clerk/backend 3.26.5, @clerk/react 6.18.4, drizzle-orm 0.45.4, drizzle-kit 0.31.11, zod 4.6.7, pptxgenjs 4.0.1, vitest 5.0.5, TypeScript 6.0.3 |

## Repo shape

My call until `lemon-shot-mvp-tech-stack.md` is available.

```
wrangler.jsonc           account, custom domain, bindings: DB (D1), CONFIG (KV), FILES (R2), ENRICH_QUEUE (Queues), crons
vite.config.ts           React + Tailwind + @cloudflare/vite-plugin
src/worker/index.ts      Hono app: /api/*, /health (later /r/:slug for RMN)
src/worker/core/         auth, db (Drizzle schema), llm, enrichment (apify, youtube, normalise), runs, review, errors, cost
src/worker/products/     matrix/ first; proposal/, optimization/, trends/, dco/, rmn/ in build order
src/client/              React app; shared UI: SampleDataBadge, DraftBadge, ConfidenceFlag, DeadLetterList, HowScoringWorks
drizzle/                 migrations, the only schema-change path (NFR-6)
test/                    Vitest unit tests and acceptance-criteria scripts
```

## Phase 0: verify (brief, before any product code)

1. Scaffold the shell and pin the versions above in `package.json`. The global wrangler is 4.63.0; the project uses its own.
2. Create D1, KV, R2 and the Queue in the GoGoCash account; deploy the shell to `lemonshot.kunanonj.com`.
3. Fronk adds secrets with `wrangler secret put` (and the same values in a gitignored `.dev.vars` for local dev): `APIFY_TOKEN`, `OPENCODE_API_KEY`, `YOUTUBE_API_KEY`, `CLERK_SECRET_KEY`. `FAL_API_KEY` waits until Phase 5. The Clerk publishable key is public by design and goes in the client build. I never read or print secret values.
4. Admin-only diagnostic routes return pass/fail with non-secret detail only:
   - **Apify:** one real run each of a maintained IG and TikTok profile actor; record actor IDs and dataset field names for the normalisers.
   - **OpenCode:** one chat completion returning strict JSON, checked by the same validator `core/llm` will use.
   - **Clerk:** Fronk signs in on the deployed shell; `/api/me` verifies the session through `@clerk/backend` and returns the user ID and role.
   - **pptxgenjs:** build a one-slide deck inside the Worker and write it to R2. If this fails, report it; the fallback is a CI-side export job.
   - **Bindings:** round-trip D1, KV and R2; enqueue and consume one Queue message.
5. Report pass/fail per item and the actor IDs chosen, then stop for Fronk's go-ahead on Phase 1.

## Phases 1 to 7

Each phase exits on its acceptance criteria, run against the deployed URL. A detailed task list is written at the start of each phase.

| Phase | Scope | Exit gate |
|---|---|---|
| 1. Core + ① Matrix | Clerk auth and roles; Drizzle schema (creators, stat_snapshots, content_items, briefs, runs, run_logs, outcome_records, apify_runs, llm_calls, dead letters); enrichment module with Queue and 72 h cron sweep; `core/llm` gateway; review gate and overrides; roster discovery; Matrix brief form, candidates (cap 40), features, one LLM call, composite with hard floors, review UI, CSV export, backtest | AC-MX-1 to AC-MX-5 |
| 2. ④ Proposal | Two templates, cited generation, section editor with versioned regeneration, assumptions block, HTML + PPTX export from R2 | AC-CP-1 to AC-CP-3 |
| 3. ③ Optimization | Campaign registry, tracked posts, cron refresh, delta engine, digests, actions log, transactional write-back into ① features | AC-CO-1 to AC-CO-4 |
| 4. ② Trends | Watchlists, capped Apify pulls, dedupe and clustering, within-sample briefs, attach to ④ | AC-TM-1, AC-TM-2 |
| 5. ⑤ DCO | R2 intake with rights attestation, copy variants, fal.ai allowlisted models only, provenance, export pack | AC-DC-1, AC-DC-2 |
| 6. ⑥ RMN | KV-cached tracked links, click log with bot filter, labelled demo store, last-click and time-decay attribution, separate simulated outcomes | AC-RM-1 to AC-RM-3 |
| 7. Hardening | §7.7 error-path pass, weekly cost alert, pre-warmed demo snapshots, demo scripts, screenshots, full smoke run | All six products pass on the production URL |

Reused from the case repo (`thelemonshot-ai-pm-case/n8n/build.mjs`): Bayesian shrinkage toward benchmark (K = 3) for the write-back history score, engagement normalised against the tier median, the per-objective weight constants pattern, and the LLM-failure fallback that keeps a run shipping with flagged rows.

## Flags: spec conflicts and gaps

1. **Clerk package.** The brief names `@clerk/clerk-react`; npm marks it deprecated ("no longer supported, use @clerk/react"). PRD-01 only says "Clerk React SDK", so `@clerk/react` meets the spec.
2. **Companion docs missing.** `~/workspace/job-applications/` does not exist on this Mac. Repo shape, binding names and the ① 17-step pipeline are my calls until the tech-stack doc, both strategy docs and `lemon-shot-n8n-workflow.json` are shared.
3. **Matrix weights.** PRD-01 gives only the direction (conversion weights history highest, awareness weights reach highest). The starting numbers are my call, shown in the "how scoring works" panel, and Fronk's to own.
4. **FR-MX-9 "formatted Sheet view".** The stack has no Google Sheets integration, so this ships as CSV plus a formatted in-app table.
5. **FR-MX-10 backtest.** Historical briefs and outcomes are seeded sample records, labelled as sample data.
6. **Case deck vs this suite** (the deck, not the PRD): PRD §12 puts screenshots on slide 14, but in the case deck slide 14 is Build vs Buy and the screenshot slot is slide 12. Product names differ (Creator Selection Matrix vs Creator Match, Campaign Proposal vs Proposal Copilot, Campaign Optimization vs Campaign Pulse). The Matrix scoring differs from the deck's appendix A5 formula. Deck slides 11 to 13 describe n8n, BigQuery and Claude.

7. **OpenCode naming and endpoint.** OpenCode's docs now call the service "OpenCode Console". The OpenAI-compatible endpoint is `https://opencode.ai/inference/openai/v1/chat/completions`; Claude models are reached through it by translation. Free models only work inside the OpenCode app, so the suite needs paid credit.
8. **YouTube quota.** FR-CORE-11 cites `search.list` at 100 units. Google's quota page now lists 1 unit per call with a separate cap of 100 calls a day. The rule (no search in refresh paths) still holds.
9. **Retry standard (FR-CORE-13).** "3 attempts, backoff 2s, 5s, 10s" is implemented as one try plus three retries spaced 2s, 5s and 10s. Only network errors, timeouts, 429 and 5xx are retried.
10. **Data completeness (FR-MX-7).** My call: the share of per-platform stats (followers, engagement rate, median views) present for the requested platforms. Missing outcome history is shown as its own "No history yet" flag rather than lowering completeness, because every creator starts with none.
11. **LLM payload (FR-CORE-17).** My call: handles, metrics, top hashtags and up to three caption excerpts per creator, with emails, links and phone numbers stripped. No bios. Brand safety and creative fit can't be judged from numbers alone.
12. **Partial model output (BR-MX-2).** If the model leaves out more than 10% of candidates, the whole run falls back to data scores, so rows are always ranked on the same basis.
13. **Must-include (FR-MX-1).** Must-include creators get a shortlist place regardless of rank, but the brand-safety floor still applies to them.
14. **Backtest (FR-MX-10), not built.** It needs historical briefs and their outcomes. Seeding invented outcomes for the real public creators in the roster would put made-up numbers next to real people (HR-3). Proposed: run the backtest only on fictional fixture creators until real campaign history exists. Needs Fronk's decision.
15. **One model call per section (④).** PRD-01 doesn't say how many calls a proposal takes. BR-CP-2 ("completed sections persist; failed section shows retry") reads as per-section generation, so each of the seven sections is its own queued call, the creator section last. At OpenCode's listed Sonnet 5.5 price that is roughly USD 0.10 per proposal; three alternatives for one section cost about USD 0.03.
16. **Figures guard (FR-CP-3, HR-3).** Besides the prompt rule, code checks every figure the model writes (percentages, money, multiples, magnitudes, numbers of 1,000 or more). A figure that doesn't trace to the brief, the shortlist data or the template (within 5% rounding) becomes "TBC", and the section says how many were replaced. A planner's own edits are never rewritten, only linted.
17. **Creator guard (FR-CP-2).** @mentions and roster names or handles that aren't on the attached shortlist become "(creator TBC)". Names under six characters aren't checked, to avoid hitting ordinary words; the prompt is the first control (the model only ever receives shortlisted creators, and only in the creator section).
18. **Approval gate (④).** My call: a proposal can be approved only when every section is settled (template drafts left by a model failure must be retried or edited) and, if a shortlist is attached, once that shortlist is approved. Otherwise unreviewed picks could reach a client.
19. **Trend items (workflow step 2), not built.** Attaching ② trend items waits for Phase 4.
20. **Language.** My addition: drafts can be written in English or Thai. Only model text changes; template phases, KPI names, the assumptions block and the empty-section text stay in English.
21. **Exports after approval.** Approved content is frozen, so the HTML and PPTX are built once and stored in R2 under `exports/proposal/<run id>/`. To change an approved proposal, start a new one.
22. **PPTX checked by structure only.** The deck was unpacked and checked (slide order, titles, table pages, font sizes), but not opened in PowerPoint or Keynote here. pptxgenjs's "shrink on overflow" only applies after an edit, so text sizes and table pages are worked out in code instead.
23. **Local test hooks.** `DEV_AUTH_BYPASS=1` in `.dev.vars` now also renders the UI without Clerk on localhost (`/config` reports it under the same rule as `requireAuth`), and `LLM_CHAT_URL`, accepted only for localhost URLs, points the gateway at a mock model. Neither can apply in production.
24. **Post-level refresh (③).** Instagram posts go through `apify/instagram-scraper` (`directUrls`, `resultsType: "posts"`, `resultsLimit: 1`), TikTok through `clockworks/tiktok-scraper` (`postURLs`), YouTube through `videos.list`. Inputs checked against the Apify Store input schemas on 2 Nov 2026.
25. **Unavailable posts (BR-CO-1).** An explicit answer (TikTok's `POST_NOT_FOUND_OR_PRIVATE`, a video missing from `videos.list`) marks a post unavailable at once. Instagram gives no such answer, so a post it doesn't return twice in a row is marked unavailable; after one miss it shows "Not in last refresh".
26. **Outcome and history scores (FR-CORE-21).** My call: an outcome of 50 means "performed as expected", the geometric mean of engagement against the campaign median and views against baseline where set, capped at 0 to 100 (`outcome-v1`). The history score the Matrix reads is the mean of a creator's outcomes shrunk toward 50 with K = 3, as in the case repo (`history-v1`), and can be rebuilt from outcome records alone (System action).
27. **Trend (FR-CO-3).** Views only grow, so the trend compares views per day between the last three refreshes: rising, steady or slowing.
28. **Digest timing.** A digest is written once every platform in a refresh has answered, or after 8 minutes, whichever comes first. A manual refresh is limited to one every 5 minutes because each costs actor runs.
29. **Closing.** The close needs the exact summary the planner reviewed (by hash) and refuses if a refresh changed the numbers in between. A written-back campaign can be archived, never deleted.
30. **No digest export.** The ACs don't ask for one; digests live in the app.

## Phase 1 status (2 Nov 2026, before keys)

| Area | State |
|---|---|
| CORE | Built and deployed: Clerk auth and roles, the D1 spine (14 tables, Drizzle migration `0000_spine`), enrichment through the queue with the 72 h sweep and dead letters, the OpenCode gateway with JSON-schema fallback and call logging, runs and run logs, the review gate, overrides, operator overview, `/health` |
| ① Matrix | Built and deployed: brief form with the live conflict warning, candidate pool (cap 40, thin-pool warning), features, one-call LLM contract with split guard, composite with hard floors, shortlist review with swap, approve, CSV export, "how scoring works" |
| Creators | Roster with snapshot freshness, add by handle, refresh, deactivate, dead letters, hashtag discovery |
| Verified | 24 unit tests (brief, features, scoring, LLM contract, normalisers; one real bug fixed: Thai hashtags were cut at the first vowel mark). A scripted local end-to-end run on fictional fixtures passed 15 checks, covering AC-MX-2, AC-MX-5, BR-MX-2, BR-CORE-4 and FR-MX-8 |
| Not verified yet | Anything that needs real keys: Clerk sign-in, real Apify and YouTube payloads, LLM scoring quality, the UI in a browser |
| Not built | FR-MX-10 backtest (flag 14); Phases 2 to 7 |

## Phase 2 status (2 Nov 2026, before keys)

Started on Fronk's go-ahead before Phase 1's checks could run (no keys yet). Deployed as version `a7d83977`; migration `0001_proposal` applied remotely.

| Area | State |
|---|---|
| ④ Proposal | Built and deployed: two templates (standard campaign, always-on retainer) with their own section order and required fields; a brief form that attaches an existing shortlist, starts a new one, or none; per-section drafting through the queue; structured editor; regenerate one section (one version or three alternatives, with an optional steer); version history with "use this version"; attach a shortlist later; assumptions block; approval gate; HTML and PPTX exports stored in R2 |
| Verified | 47 unit tests (23 new: figure and creator guards, lint, KPI merge, templates, deck layout, and the AC-CP-2 inspection test on the HTML export). A scripted local run against a mock model passed 50 checks covering AC-CP-1, AC-CP-2, AC-CP-3, BR-CP-1, BR-CP-2, FR-CP-2, FR-CP-3, FR-CP-5, FR-CORE-17 and BR-CORE-4. The editor, retry, history and preview were exercised in the browser |
| Not verified yet | The real model's drafts and timing, the deployed UI behind Clerk, and the PPTX opened in PowerPoint |
| Not built | Trend attachment (Phase 4) |

## Phase 3 status (2 Nov 2026, before keys)

Deployed as version `7685e9b5`; migration `0002_optimization` applied remotely; committed as `e0c18b3`.

| Area | State |
|---|---|
| ③ Optimization | Built and deployed: campaign registration that resolves every post to a creator or a stub (FR-CO-1); scheduled refresh (daily in flight, weekly after) and a manual refresh; the delta engine; digests with a deterministic verdict, winners, losers and freshness footer plus a guarded model narrative; review gate; actions log; closing write-back into history scores; archive; organic-scope label on every surface |
| Verified | 64 unit tests (17 new). A scripted local run against mock Apify, YouTube and model services passed 34 checks covering AC-CO-1 to AC-CO-4, FR-CO-1, FR-CO-5, FR-CO-7, BR-CO-1 and FR-CORE-21, including a Matrix run reading the written-back score |
| Not verified yet | Real Apify post payloads and real model digests |

## Phases 4 to 6 status (2 Nov 2026, before keys)

Built in parallel by three agents on branches `phase4-trends`, `phase5-dco` and `phase6-rmn` (worktrees in `~/Developer/lemon-shot-suite-wt/`), each with its tables in `src/worker/products/<product>/schema.ts`. Merged into main with one migration per phase (`0003_rmn`, `0004_trends`, `0005_dco`), all applied remotely. Live as version `7b7a1307`.

| Phase | Built | Verified |
|---|---|---|
| 4. ② Trends | Watchlists, capped Apify pulls per term and platform, dedupe, hashtag clustering with model theme naming, within-sample briefs with weak-signal labels, review gate, attach an approved brief to a draft proposal (shown in its assumptions) | 31 unit tests; 31 end-to-end checks covering AC-TM-1, AC-TM-2, BR-TM-1 and BR-TM-2, plus a forced model failure |
| 5. ⑤ DCO | Base-asset intake with rights attestation, copy variants per segment, fal.ai visuals from a code-level allowlist only, provenance on every variant, per-variant review, ZIP export pack | 38 unit tests; 51 end-to-end checks covering AC-DC-1, AC-DC-2, BR-DC-1, BR-DC-2 and FR-DC-1 |
| 6. ⑥ RMN | Campaigns with per-creator tracked links, public redirect with KV mapping and bot filter, a labelled public demo store, last-click and time-decay attribution, simulated orders kept apart from history scores | 22 unit tests; 25 end-to-end checks covering AC-RM-1 to AC-RM-3, FR-RM-1 and FR-RM-2 |

Regression on the merged code: 155 unit tests, and every product's end-to-end script rerun against main (Phase 2 50 of 50, Phase 3 34 of 34, Phase 4 31 of 31, Phase 5 51 of 51, Phase 6 25 of 25). Not verified yet: real Apify, fal.ai and model payloads, the Phase 4 to 6 pages in a browser, and redirect latency in production.

Calls made in Phases 4 to 6, from the builders' reports:

31. **Trend pulls** run on demand only, 30 posts per term by default (100 at most), at most 10 terms per pull. Each term and platform is one Apify run; its cost is Apify's `usageTotalUsd`, or "Not reported".
32. **Themes** are seeded by a hashtag shared by at least two posts (at most eight themes). Fewer than three posts is a weak signal. "Rising within this pull" means at least 60% of dated posts fall in the newer half of the pulled window. Platform-wide wording from the model is dropped and flagged.
33. **Trend attachment** needs an approved brief and a draft proposal. Detaching isn't built.
34. **DCO allowlist:** `fal-ai/bria/expand`, `fal-ai/bria/background/replace` and `fal-ai/bria/product-shot`, each checked on its fal model page on 2 Nov 2026. A unit test fails if an allowlisted model looks like a face, person, portrait, swap, avatar or headshot model.
35. **DCO base asset** reaches fal through `/api/dco/public/input/:token`: a 256-bit token kept in KV for two hours, mapped to one stored image. fal has no session and documents no REST upload.
36. **DCO jobs** have five visual slots (1:1, 4:5 and 9:16 layouts plus two scenes) and N copy options per segment (default 3, English only). Assets up to 8 MB. `FAL_API_KEY` isn't set yet, so visuals show a retry state until it is.
37. **DCO safety flags:** the three Bria pages document no safety field, so BR-DC-2 checks fal's common flag names; only the mock has exercised it.
38. **RMN links:** 12-symbol slugs from a 32-symbol alphabet (60 bits). A turned-off link returns 410 with a neutral page; the attempt is logged, not counted. Raw user agents aren't stored, only their class; referrers as host only.
39. **RMN attribution:** time decay weighs each in-window click by 0.5^(age in days / 2), normalised per order; the window is inclusive. Simulated orders live in their own tables, never in outcome records or history scores. Exporting attributed summaries isn't built.
40. **Commit trailers:** the three builders ran on a smaller model than the integrator; the Phase 6 commit names Opus 5.5 although its builder wasn't.

UI direction (Mobbin references): Lightfield and Twenty for the shell and tables, Kit's Recommendations for the stat strip, Whop's Launch campaign for the brief form. Neutral greys, one near-black primary, lemon only as the brand mark.

## Error-path review (2 Nov 2026, before keys)

An independent review traced every queue message and status field to the code that writes it and found 25 ways work could stall, fail silently or show raw errors. All 25 are fixed. Creative Variants, Trend Monitoring and Retail Media were fixed in parallel on their own branches and merged; the shared code was fixed on main.

| Area | What changed |
|---|---|
| Queue (`queue.ts`) | Retries are spaced out. On the last delivery, the work a message owned settles in a visible, retryable failed state and a dead letter records it. Unknown messages are logged and dropped. Logs carry the kind, ids, attempt and stack. |
| Stuck-work sweep | Covers every product, re-queues digests whose message was lost, and aborts paid Apify runs nothing polls. Each part runs on its own. |
| Cron | Each step runs on its own; `/health` names failing steps and System shows their errors. Sweep gates are handed back when work fails. |
| Model gateway | `callJson` never throws, so every product's deterministic fallback runs. |
| ① Matrix | Runs are claimed in one guarded update, a dead delivery's run is taken over cleanly, and failures show a fixed sentence. A run that can't be queued fails at once. |
| ④ Proposal | A failed first send fails the run; a failed regenerate or attach send puts the section back. The sweep judges a first draft by the latest update across its sections. |
| ③ Optimization | Platform answers are applied once, even when delivered twice. A stale refresh no longer blocks new ones. Digests have one run per refresh. Footer failures are fixed phrases. |
| Enrichment | Jobs are claimed, each profile saves on its own, and partial YouTube answers fail the job instead of replacing good data. A source outage shows a notice on every page instead of dead-lettering every creator. |
| ②, ⑤, ⑥ | Pulls, briefs and slots can no longer stay running; term and slot failures are plain sentences; short links fall back to D1 when KV fails. |
| Auth | A Clerk outage falls back to the last known role, or answers 503 instead of 500. |

Checks on the merged code: 196 unit tests. End-to-end, every earlier script still passes on main (Phase 2 50 of 50, Phase 3 34 of 34, Phase 4 31 of 31, Phase 5 51 of 51, Phase 6 25 of 25, Phase 7 10 of 10). New failure-path scripts pass too: 26 shared checks, 25 for Trends and 23 for Creative Variants. Not exercised: a queue that refuses a send (local dev can't make it fail without a test hook in production code), the real dead-letter queue, a Clerk outage, and real Apify abort responses.

41. **Queue deliveries:** four in all (`max_retries` 3), retried after 15 s, 60 s and 180 s. The fourth failure settles the work and writes a dead letter; the dead-letter queue only receives a message whose settling failed too.
42. **Sweep thresholds:** 20 minutes for runs, sections, refreshes, pulls and slots; 45 for enrichment jobs; 30 for an Apify run before it is aborted. A done refresh with no digest is re-queued for up to six hours.
43. **Source failures** are stored as a code and a fixed phrase. A failure that would hit anyone (a missing or refused key, quota, an outage) doesn't dead-letter the creator or hold them out of the next sweep; it raises a notice on every page for up to three hours, cleared by the next success.
44. **Role cache:** fresh for 60 seconds, kept 7 days as a fallback. During a Clerk outage a role revoked in Clerk keeps working until Clerk answers again.
45. **Migration 0007** adds `enrichment_jobs.failure_scope`, one digest per refresh and one running refresh per campaign. Its cleanup statements are hand-added before each unique index, so existing duplicates can't make it fail.

## Needed from Fronk

- Phase 0: the secrets above via `wrangler secret put`, a Clerk application (a development instance is enough for Phase 0) and its publishable key, and one sign-in on the deployed shell.
- Before Phase 1: the companion docs if they exist, and a go-ahead on the Phase 0 report.
- During Phase 1: curation of the discovered roster.

## Per-phase report

Deployed URL; which acceptance criteria ran and their results; spec conflicts found; screenshots of the main flow at desktop width, light theme, with sample-data labels visible.
