from dataclasses import dataclass
from typing import List


@dataclass
class ChecklistItem:
    id: str
    description: str


@dataclass
class Turn:
    speaker: str
    text: str


@dataclass
class ItemResult:
    id: str
    description: str
    status: str  # "yes" | "no" | "unclear"
    evidence: str


@dataclass
class TranscriptResult:
    transcript_id: str
    source_path: str
    results: List[ItemResult]
