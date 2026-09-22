# AutoTranscriptionChecklist

Runs a predefined checklist against two-person conversation transcripts using an LLM — [Amazon Bedrock](https://aws.amazon.com/bedrock/) (Nova Micro by default) or a local [Ollama](https://ollama.com) model. For each transcript, every checklist item is judged as `yes`, `no`, or `unclear`, with a short evidence quote.

Two ways to use it:
- **`backend/cli.py`** — batch-process a folder of transcript files from the command line.
- **`backend/server.py` + `frontend/`** — a web app to paste a transcript, edit/save checklists, and run evaluations with live streaming results.

## Project layout

```
backend/            FastAPI server, CLI, and shared evaluation logic
  checklist_qa/      core package: transcript/checklist parsing, LLM clients, evaluator
  checklists/        checklist definitions (YAML/JSON)
  transcripts/        sample transcripts (CLI input)
  reports/           CLI output (JSON reports)
  cli.py             batch CLI entrypoint
  server.py           FastAPI app (used by the frontend)
  requirements.txt
frontend/           Next.js + Mantine web app
```

## Setup

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

#### Bedrock (default provider)

1. Configure AWS credentials (`aws configure`, or env vars / SSO profile) with `bedrock:InvokeModel`/`Converse` permission.
2. In the [Bedrock console](https://console.aws.amazon.com/bedrock/) → **Model access**, enable **Amazon Nova Micro** in the region you'll use (default: `us-east-1`). Access for Amazon's own Nova models is typically granted instantly.
3. Bedrock has no ongoing free tier for inference — it's pay-per-token from the first call. Nova Micro is roughly $0.035/M input + $0.14/M output tokens, so a full checklist run over a transcript typically costs a fraction of a cent.

#### Ollama (local alternative)

```bash
ollama serve &
ollama pull qwen3:1.7b
```

### Frontend

```bash
cd frontend
npm install
```

## Usage

### Web app

```bash
# terminal 1 — backend API (from backend/, with venv activated)
uvicorn server:app --port 8000 --reload

# terminal 2 — frontend
cd frontend && npm run dev
```

Open http://localhost:3000. Pick a checklist, edit/save it, paste a transcript, and run the evaluation — results stream in live as each item is judged.

### CLI (batch)

```bash
cd backend
python cli.py --transcripts transcripts --checklist checklists/support_call_qa.yaml --output reports

# Local Ollama instead of Bedrock
python cli.py --provider ollama --transcripts transcripts --checklist checklists/support_call_qa.yaml --output reports
```

This evaluates every `.txt`/`.json` file in `transcripts/` against every item in the given checklist, writing one JSON report per transcript plus a `summary.json` into `reports/`.

Other flags: `--model` (override the model ID/name), `--region` (Bedrock AWS region), `--host` (Ollama host URL).

## Input formats

**Transcripts** (`.txt` or `.json`):

- Plain text, one turn per line: `Speaker: text`
- JSON: `[{"speaker": "Agent", "text": "..."}, ...]`

**Checklist** (YAML or JSON), in `backend/checklists/`:

```yaml
name: "Support Call QA Checklist"
items:
  - id: greeting
    description: "The AGENT, in their own line of dialogue, greets the customer and states their own name."
  - id: closing
    description: "The AGENT, in their own line of dialogue, explicitly says a farewell phrase to end the call."
```

## Output

`reports/<transcript_id>.json`:

```json
{
  "transcript_id": "example_call",
  "source_path": "transcripts/example_call.txt",
  "results": [
    {"id": "greeting", "description": "...", "status": "yes", "evidence": "..."},
    ...
  ]
}
```

`reports/summary.json` aggregates yes/no/unclear counts per transcript.

## Notes

- Each checklist item is evaluated concurrently (a thread pool, one call per item) rather than sequentially, which cuts a 6-item checklist from ~5s down to ~1s — see `checklist_qa/evaluator.py`.
- Bedrock calls use the Converse API with a forced tool call to get structured `{status, evidence}` output directly — no free-text JSON parsing needed. Ollama calls use `format: "json"` mode instead.
- Checklist items should be concrete and name the specific speaker (e.g. "The AGENT explicitly says X") — small/cheap models judge vague, compound criteria unreliably, as seen when testing `qwen3:1.7b` on this project.
- The web app's backend API (`server.py`) currently uses your default/root AWS credentials — for anything beyond local dev, set up a dedicated IAM identity scoped to `bedrock:InvokeModel`/`Converse` only.
