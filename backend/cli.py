import argparse
from pathlib import Path

from checklist_qa.checklist import load_checklist
from checklist_qa.evaluator import evaluate_transcript
from checklist_qa.llm_client import BedrockClient, OllamaClient
from checklist_qa.report import write_summary, write_transcript_report
from checklist_qa.transcript import load_transcript

DEFAULT_MODELS = {
    "bedrock": "amazon.nova-micro-v1:0",
    "ollama": "qwen3:1.7b",
}


def build_client(args):
    if args.provider == "bedrock":
        model_id = args.model or DEFAULT_MODELS["bedrock"]
        return BedrockClient(model_id=model_id, region=args.region)
    model = args.model or DEFAULT_MODELS["ollama"]
    return OllamaClient(model=model, host=args.host)


def main():
    parser = argparse.ArgumentParser(description="Run an LLM checklist QA pass over conversation transcripts.")
    parser.add_argument("--transcripts", default="transcripts", help="Directory of transcript files (.txt or .json)")
    parser.add_argument("--checklist", default="checklists/support_call_qa.yaml", help="Path to checklist YAML/JSON file")
    parser.add_argument("--output", default="reports", help="Directory to write JSON reports to")
    parser.add_argument("--provider", choices=["bedrock", "ollama"], default="bedrock", help="LLM backend to use")
    parser.add_argument("--model", default=None, help="Model name/ID (defaults depend on --provider)")
    parser.add_argument("--region", default="us-east-1", help="AWS region for Bedrock")
    parser.add_argument("--host", default="http://localhost:11434", help="Ollama host URL")
    args = parser.parse_args()

    checklist_name, items = load_checklist(args.checklist)
    client = build_client(args)

    transcript_dir = Path(args.transcripts)
    paths = sorted(p for p in transcript_dir.iterdir() if p.suffix.lower() in (".txt", ".json"))
    if not paths:
        raise SystemExit(f"No transcripts found in {transcript_dir}")

    all_results = []
    for path in paths:
        turns = load_transcript(path)
        print(f"Evaluating {path.name} ({len(items)} checklist items)...")
        result = evaluate_transcript(client, transcript_id=path.stem, source_path=path, turns=turns, items=items)
        write_transcript_report(result, args.output)
        all_results.append(result)
        for item in result.results:
            print(f"  [{item.status.upper():7}] {item.id}: {item.description}")

    summary_path = write_summary(all_results, checklist_name, args.output)
    print(f"\nDone. Summary written to {summary_path}")


if __name__ == "__main__":
    main()
