import json
from dataclasses import asdict
from pathlib import Path
from typing import List

from .models import TranscriptResult


def write_transcript_report(result: TranscriptResult, output_dir: str) -> Path:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{result.transcript_id}.json"
    out_path.write_text(json.dumps(asdict(result), indent=2))
    return out_path


def write_summary(results: List[TranscriptResult], checklist_name: str, output_dir: str) -> Path:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = {
        "checklist": checklist_name,
        "transcripts": [
            {
                "transcript_id": r.transcript_id,
                "source_path": r.source_path,
                "counts": {
                    "yes": sum(1 for i in r.results if i.status == "yes"),
                    "no": sum(1 for i in r.results if i.status == "no"),
                    "unclear": sum(1 for i in r.results if i.status == "unclear"),
                },
            }
            for r in results
        ],
    }
    out_path = out_dir / "summary.json"
    out_path.write_text(json.dumps(summary, indent=2))
    return out_path
