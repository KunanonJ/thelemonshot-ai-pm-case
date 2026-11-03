# Lemon Shot AI Suite

A working MVP for The Lemon Shot's AI Product Manager (Data & AI Transformation) case: six products on one creator data spine, live at [lemonshot.kunanonj.com](https://lemonshot.kunanonj.com). Every creator record is sample data built from public profiles, and every screen says so.

The case deck, brief and n8n workflows this repo started with are in its history at [`af6ec0a`](https://github.com/KunanonJ/thelemonshot-ai-pm-case/tree/af6ec0a), including the [deck PDF](https://github.com/KunanonJ/thelemonshot-ai-pm-case/blob/af6ec0a/deck/TheLemonShot_AI-PM-Case.pdf).

## The products

| Product | What it does |
|---|---|
| ① Creator Matrix | Scores and shortlists creators for a brief. Hard rules and data scores are code; the model judges fit and writes a rationale. A planner approves the shortlist |
| ② Trend Monitoring | Pulls posts for a watchlist, clusters them into themes and drafts a brief whose every number stays within the pull |
| ③ Campaign Optimization | Tracks registered posts, writes a digest of what moved and why, and writes outcomes back into each creator's history score |
| ④ Campaign Proposal | Drafts a proposal section by section from a brief and an approved shortlist, with versions, alternatives and a PPTX export |
| ⑤ Creative Variants | Copy per segment and image variants from an allowlist of background, layout and format models, never a creator's face or voice |
| ⑥ Retail Media | Tracked links per creator, a labelled demo store and last-click against time-decay attribution |

The line the build follows: the model judges, code does the arithmetic, a person makes the call. Figures the model can't source become "TBC", every AI output is a draft until someone approves it, and failures show up as plain sentences with a retry.

## How it's built

One Cloudflare Worker serves the API (Hono) and the React app (Vite, Tailwind). D1 (through Drizzle) holds the data, KV the cache and settings, R2 the raw source answers and exports. A Queue runs the long work, and a cron refreshes data and settles anything stuck. Sign-in is Clerk.

The model is reached only through `src/worker/core/llm.ts` (OpenCode). Creator data comes from Apify and the YouTube Data API through `src/worker/core/enrichment/`, and images from fal.ai.

## Run it locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev
```

`DEV_AUTH_BYPASS=1` in `.dev.vars` skips Clerk for requests to localhost only. Without the other keys, each product falls back to its no-model or no-source path and says so.

Checks: `pnpm test` (unit), `pnpm exec tsc -p tsconfig.worker.json --noEmit` and `pnpm exec tsc -p tsconfig.app.json --noEmit` (types), `pnpm build`.

## Deploy

`pnpm db:migrate:remote`, then `pnpm run deploy` (plain `pnpm deploy` is pnpm's own command). Keys go in with `wrangler secret put <NAME>`, using the names in `.dev.vars.example`. None of them is ever in the repo.

Without Apify, `pnpm db:seed:demo:remote` (or `:local`) loads 10 fictional demo creators from `seed/demo-creators.sql`, labelled sample data. Re-running it resets their stats' age so shortlists don't flag them as stale.

## Docs

- [docs/build-plan.md](docs/build-plan.md): decisions, phase status, the error-path review, and every call made where the spec was silent
- [docs/demo-script.md](docs/demo-script.md): the 12-minute walk-through and what to prepare the day before
- [docs/tonight.md](docs/tonight.md): the setup checklist for accounts and keys
