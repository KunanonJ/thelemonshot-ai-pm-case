# n8n workflows (Task 2 bonus)

| File | What it is |
|---|---|
| `CM-01_brief-to-shortlist.json` | Creator Match MVP: brief form to approved shortlist (22 nodes, 5 notes) |
| `OPS-01_error-handler.json` | Error workflow: classify, alert `#ai-ops`, dead-letter table |
| `build.mjs` | Regenerates both files (`node build.mjs`). It runs the Code-node logic locally on the demo data, so pinned outputs match the logic |

Node versions were checked against the latest release (n8n 2.45.7, n8n-nodes-base 2.15.1).

## Run it locally (about 10 minutes)

1. Start n8n locally (or use an n8n Cloud trial):
   ```bash
   docker volume create n8n_data
   docker run -it --rm --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n
   ```
   Open http://localhost:5678 and create the owner account.
2. Workflows > Create workflow > `...` menu > **Import from File** > choose `CM-01_brief-to-shortlist.json`. Do the same for `OPS-01_error-handler.json`.
3. In CM-01, click **Execute workflow**. Demo data is pinned on every external node (Claude, BigQuery, Drive, Sheets, Slack), so the run should turn green with no credentials. If n8n insists on credentials first, skip the run and just screenshot the canvas.
4. Click "Zoom to fit", then take a full-canvas screenshot. Save it as `deck/assets/n8n-cm01.png` and run `deck/build.sh`. The screenshot then replaces the drawn diagram on slide 12.

## Make it real

1. Unpin the nodes.
2. Add credentials:
   - Header Auth `x-api-key` for Anthropic.
   - Header Auth `Authorization: Bearer ...` for OpenAI.
   - Google (BigQuery, Drive, Sheets) and Slack.
3. Replace the `REPLACE_WITH_*` IDs: the CM-02 refresh sub-workflow, the PC-01 Proposal Copilot workflow, and the shortlist template Sheet.
4. In CM-01 > Settings > **Error workflow**, choose OPS-01.
5. Check the OpenAI fallback model ID (`gpt-6.1-sol`) against OpenAI's model list before relying on it.
