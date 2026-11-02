# Win. Match. Optimize.

Case submission for The Lemon Shot's AI Product Manager (Data & AI Transformation) role: a Phase 1 roadmap that turns every campaign into proprietary creator data, and earns the right to build a Creator Retail Media Network in Year 2.

**Start with the deck:** [TheLemonShot_AI-PM-Case.pdf](deck/TheLemonShot_AI-PM-Case.pdf) (25 slides).

## The four tasks

| Task | Answer | Slides |
|---|---|---|
| 1. Portfolio prioritization | Proposal Copilot (months 1-2), Creator Match (months 2-4), Campaign Pulse (months 4-6). Creator RMN, Trend Monitoring and DCO move to Year 2, each with a clear trigger. | 5-9 |
| 2. MVP blueprint and low-code logic | Creator Match in n8n, from a brief form to a shortlist approved in Slack. Hard rules run in SQL before any AI; Claude parses the brief and judges brand fit. | 10-13 |
| 3. Build vs buy | Rent the model, own the memory: buy commodity layers, build the creator graph and scoring. Vendors pass hard gates before they are scored. | 14-15 |
| 4. The "Human x AI" reality check | Shadow mode on real briefs, one-click overrides, AI-assisted brief coverage as the proof metric, and a kill rule. | 16-18 |

Slide 19 covers the asks. The appendix (slides 20-25) holds the score rationale, the Proposal Copilot and Campaign Pulse flows, the API reference, the Creator Match scoring model and likely questions.

## What's in the repo

| Path | What it is |
|---|---|
| `deck/TheLemonShot_AI-PM-Case.pdf` | The deck, one slide per page |
| `deck/TheLemonShot_AI-PM-Case.html` | The same deck, interactive: on slide 5 the weight presets re-score the use cases live. Download it and open it in a browser. Arrow keys move between slides, `N` shows speaker notes, `F` goes full screen |
| `deck/src/`, `deck/build.sh` | Slide sources. `deck/build.sh` joins them into the HTML and exports the PDF with Google Chrome (macOS path) |
| `n8n/` | The Creator Match workflow (CM-01), its error handler (OPS-01) and the script that generates both. [n8n/README.md](n8n/README.md) covers import and setup |

All creator data is fictional (`@demo.*` handles), and every external node (Claude, BigQuery, Drive, Sheets, Slack) has demo output pinned, so the workflow can be explored without credentials.
