import json
from pathlib import Path
from typing import List

from .models import Turn


def parse_transcript_text(text: str) -> List[Turn]:
    turns = []
    for line in text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        speaker, spoken = line.split(":", 1)
        turns.append(Turn(speaker=speaker.strip(), text=spoken.strip()))
    return turns


def parse_transcript_json(text: str) -> List[Turn]:
    data = json.loads(text)
    return [Turn(speaker=t["speaker"], text=t["text"]) for t in data]


def parse_transcript_auto(text: str) -> List[Turn]:
    stripped = text.lstrip()
    if stripped.startswith("["):
        return parse_transcript_json(text)
    return parse_transcript_text(text)


def load_transcript(path: Path) -> List[Turn]:
    text = path.read_text()
    if path.suffix.lower() == ".json":
        return parse_transcript_json(text)
    return parse_transcript_text(text)


def render_transcript(turns: List[Turn]) -> str:
    return "\n".join(f"{t.speaker}: {t.text}" for t in turns)
