import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterator, List, Tuple

from .models import ChecklistItem, ItemResult, Turn, TranscriptResult
from .transcript import render_transcript

SYSTEM_PROMPT = (
    "You are a QA analyst reviewing a transcript of a conversation between two people. "
    "You will be given the full transcript and a single checklist item. "
    "Decide whether the transcript satisfies that checklist item. "
    "Only answer \"yes\" if the exact action described is explicitly and literally present in the "
    "transcript, performed by the specific speaker named in the checklist item. Pay close attention "
    "to which speaker said which line — do not credit one speaker for words said by the other. "
    "Do not infer, assume, or give credit for similar-sounding but different actions. "
    "If in doubt, answer \"no\" or \"unclear\" rather than \"yes\". "
    'Respond with ONLY a JSON object of the form '
    '{"status": "yes" | "no" | "unclear", "evidence": "<short quote from the transcript>"}. '
    'Use "unclear" only if the transcript gives no basis to decide either way.'
)

VALID_STATUSES = {"yes", "no", "unclear"}


def evaluate_item(client, transcript_text: str, item: ChecklistItem) -> ItemResult:
    user_prompt = (
        f"Transcript:\n{transcript_text}\n\n"
        f"Checklist item: {item.description}\n\n"
        "Respond with only the JSON object."
    )
    status, evidence = "unclear", ""
    try:
        raw = client.chat_json(SYSTEM_PROMPT, user_prompt)
        data = json.loads(raw)
        status = str(data.get("status", "unclear")).lower().strip()
        if status not in VALID_STATUSES:
            status = "unclear"
        evidence = str(data.get("evidence", "")).strip()
    except Exception as exc:
        evidence = f"Evaluation failed ({type(exc).__name__}): {exc}"[:200]

    return ItemResult(id=item.id, description=item.description, status=status, evidence=evidence)


def _evaluate_items_concurrently(
    client, transcript_text: str, items: List[ChecklistItem], max_workers: int = 8
) -> Iterator[Tuple[int, ItemResult]]:
    """Runs evaluate_item for every item concurrently via a thread pool -- each call
    is dominated by network wait on the Bedrock/Ollama request, so threads overlap
    that wait instead of the calls running one after another. Yields (original_index,
    ItemResult) as each completes, in completion order."""
    if not items:
        return
    workers = max(1, min(max_workers, len(items)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_to_index = {
            pool.submit(evaluate_item, client, transcript_text, item): idx for idx, item in enumerate(items)
        }
        for future in as_completed(future_to_index):
            idx = future_to_index[future]
            try:
                yield idx, future.result()
            except Exception as exc:
                item = items[idx]
                yield idx, ItemResult(item.id, item.description, "unclear", f"Unexpected error: {exc}"[:200])


def evaluate_transcript(
    client,
    transcript_id: str,
    source_path: Path,
    turns: List[Turn],
    items: List[ChecklistItem],
) -> TranscriptResult:
    transcript_text = render_transcript(turns)
    ordered: List[ItemResult] = [None] * len(items)  # type: ignore[list-item]
    for idx, result in _evaluate_items_concurrently(client, transcript_text, items):
        ordered[idx] = result
    return TranscriptResult(transcript_id=transcript_id, source_path=str(source_path), results=ordered)


def evaluate_transcript_stream(client, turns: List[Turn], items: List[ChecklistItem]) -> Iterator[ItemResult]:
    """Same work as evaluate_transcript but yields each ItemResult as soon as it's
    ready, in completion order (not necessarily checklist order) -- for streaming
    partial results to a client as they become available."""
    transcript_text = render_transcript(turns)
    for _, result in _evaluate_items_concurrently(client, transcript_text, items):
        yield result
