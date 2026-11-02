# Demo script: Lemon Shot AI Suite

About 12 minutes, live on `https://lemonshot.kunanonj.com`, in flywheel order: shortlist, proposal, campaign, write-back, then the three Tier B products. Everything that takes minutes (pulls, refreshes, image generation) is prepared the day before, so the live demo only clicks through finished work and one or two fast actions.

The line to repeat: **the model judges, code does the arithmetic, a person makes the call.**

## The day before

| Do | Where | Why |
|---|---|---|
| Run creator discovery for Food & snacks and Beauty, then deactivate anyone off-topic | Creators, Find creators | A real public roster, every row labelled sample data |
| Create a Food & snacks shortlist (conversion objective), swap one pick, approve it | Creator Matrix | The proposal and the campaign cite it |
| Draft a proposal from that shortlist, regenerate the big idea as three alternatives, approve, export the PPTX once | Campaign Proposal | Shows versioning; the export is cached |
| Register a campaign with 5 real public posts from shortlisted creators, with baselines on two of them | Campaign Optimization | It needs at least two refreshes before the demo to have a trend |
| Pull a watchlist of three Thai food terms, approve the brief, attach it to a draft proposal | Trend Monitoring | Pulls take a few minutes |
| Create a DCO job with a product photo (rights box ticked), approve a few variants, export the pack | Creative Variants | Needs `FAL_API_KEY`; without it, copy still works and visuals show a retry |
| Create a Retail Media campaign for three creators; open two of the links on your phone and check out once | Retail Media | Gives the dashboard real clicks and one attributed order |

## Thirty minutes before

1. System, **Pre-warm demo data**. It refreshes every active creator whose data is over 12 hours old and every active campaign.
2. System: every Phase 0 check passes, **Force LLM failure is off**, the weekly cost is under the threshold, no surprise dead letters.
3. Open each product page once, signed in, in the browser you will present from. Keep the tab.
4. Have the RMN tracked link ready as a QR code or a short link for a phone.

## The walk-through

**1. Opening (30 s).** One deployable on Cloudflare, six products on one creator data spine. The roster is public profiles used as sample data, and every screen says so.

**2. Creator Matrix (2 min).** Open the approved shortlist.
- "How scoring works": weights by objective, components marked Data or Model. No black box.
- A row: score, fit from the model with a rationale that cites a number, data scores, data age and completeness.
- The flags: low confidence, no history yet, stale data. Missing data is shown as missing, never as zero.
- The decisions log: the swap kept the original ranking; the final picks are what was approved.

**3. Campaign Proposal (2 min).** Open the approved proposal.
- Creator strategy: every creator comes from the shortlist, with the Matrix evidence beside them.
- A "TBC" in the text: a figure the model wrote without a source was replaced. Show the flag on the section.
- History on the big idea: three alternatives, one switched in, nothing else changed.
- Assumptions, then Export PPTX.

**4. Campaign Optimization (2 min).** Open the registered campaign.
- The scope line: organic public metrics only, no ad accounts, no paid-media advice.
- The latest digest: the verdict is code; winners and losers are code; the recommendations name the delta behind them. A hypothesis is labelled as one.
- Log an action against a recommendation.
- If time allows, close a second, small campaign: show the outcome summary, confirm, then open a new Matrix run and point at the creator's history score. That is the flywheel.

**5. Trend Monitoring (1 min).** Open the approved brief: themes with their source posts, a weak-signal label, every number within the pull ("of the 30 posts pulled…"). Then show it on the proposal's assumptions.

**6. Creative Variants (1 min).** The rule at the top: backgrounds, layouts, formats and copy, never a creator's face or voice. A variant's provenance (model, prompt, time). The allowlist audit on the same page.

**7. Retail Media (1.5 min).** Scan the link on a phone: redirect, the clearly labelled demo store, checkout with no payment fields. Back on the dashboard: the click, the order, last-click against time-decay side by side.

**8. Close (30 s).** System: freshness per source, failed jobs, the week's external cost against the threshold. What is real (data pulls, scoring, attribution engine) and what is simulated (the store and its sales).

## If something breaks live

| Symptom | Say and do |
|---|---|
| A model call fails | Runs still ship on data scores with "rationale unavailable"; show it as the designed fallback |
| Apify is slow or failing | The demo uses pre-warmed snapshots; the freshness footer shows when data last landed |
| Sign-in prompts again | Sign in before the meeting and keep the tab; a development Clerk instance shows a small badge, which is expected |
| An image job shows retry | fal.ai is optional for the walk-through; copy variants stand on their own |

Don't show the Phase 0 table or raw logs; they are for the operator, not the client.
