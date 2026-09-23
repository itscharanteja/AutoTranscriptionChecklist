import asyncio
import json
import time
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from checklist_qa.checklist import find_checklist_path, list_checklists, load_checklist, save_checklist
from checklist_qa.evaluator import evaluate_transcript, evaluate_transcript_stream
from checklist_qa.live_call import BOT_SPEAKER, HUMAN_SPEAKER, generate_reply
from checklist_qa.llm_client import BedrockClient
from checklist_qa.models import ChecklistItem, Turn
from checklist_qa.nova_sonic_stt import NovaSonicSession
from checklist_qa.transcript import parse_transcript_auto

CHECKLISTS_DIR = Path("checklists")

app = FastAPI(title="AutoTranscriptionChecklist API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_client = BedrockClient()


class EvaluateRequest(BaseModel):
    checklist_id: str
    transcript_text: str


class ChecklistItemIn(BaseModel):
    id: str
    description: str


class SaveChecklistRequest(BaseModel):
    name: str
    items: List[ChecklistItemIn]


class LiveCallTurnIn(BaseModel):
    speaker: str
    text: str


class LiveCallReplyRequest(BaseModel):
    turns: List[LiveCallTurnIn]
    scenario_id: Optional[str] = None


@app.get("/checklists")
def get_checklists():
    return list_checklists(CHECKLISTS_DIR)


@app.put("/checklists/{checklist_id}")
def put_checklist(checklist_id: str, req: SaveChecklistRequest):
    if not req.items:
        raise HTTPException(status_code=400, detail="Checklist must have at least one item")
    ids = [i.id.strip() for i in req.items]
    if any(not i for i in ids):
        raise HTTPException(status_code=400, detail="Every checklist item needs a non-empty id")
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="Checklist item ids must be unique")

    items = [ChecklistItem(id=i.id.strip(), description=i.description.strip()) for i in req.items]
    save_checklist(CHECKLISTS_DIR, checklist_id, req.name.strip(), items)
    return {"id": checklist_id, "name": req.name.strip(), "items": [asdict(i) for i in items]}


def _load_checklist_and_turns(req: EvaluateRequest):
    checklist_path = find_checklist_path(CHECKLISTS_DIR, req.checklist_id)
    if checklist_path is None:
        raise HTTPException(status_code=404, detail=f"Checklist '{req.checklist_id}' not found")

    checklist_name, items = load_checklist(checklist_path)

    turns = parse_transcript_auto(req.transcript_text)
    if not turns:
        raise HTTPException(
            status_code=400,
            detail="Could not parse any turns from the transcript. Use one 'Speaker: text' line per turn.",
        )
    return checklist_name, items, turns


@app.post("/evaluate")
def evaluate(req: EvaluateRequest):
    checklist_name, items, turns = _load_checklist_and_turns(req)

    start = time.perf_counter()
    result = evaluate_transcript(
        _client,
        transcript_id="ui-submission",
        source_path=Path("<pasted>"),
        turns=turns,
        items=items,
    )
    elapsed_seconds = round(time.perf_counter() - start, 1)

    return {
        "checklist_name": checklist_name,
        "model": _client.model_name,
        "elapsed_seconds": elapsed_seconds,
        **asdict(result),
    }


@app.post("/evaluate/stream")
def evaluate_stream(req: EvaluateRequest):
    checklist_name, items, turns = _load_checklist_and_turns(req)

    def sse():
        start = time.perf_counter()
        yield f"data: {json.dumps({'type': 'start', 'checklist_name': checklist_name, 'model': _client.model_name, 'total': len(items)})}\n\n"
        for result in evaluate_transcript_stream(_client, turns, items):
            yield f"data: {json.dumps({'type': 'item', **asdict(result)})}\n\n"
        elapsed_seconds = round(time.perf_counter() - start, 1)
        yield f"data: {json.dumps({'type': 'done', 'elapsed_seconds': elapsed_seconds})}\n\n"

    return StreamingResponse(
        sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/live-call/reply")
def live_call_reply(req: LiveCallReplyRequest):
    turns = [Turn(speaker=t.speaker, text=t.text) for t in req.turns]
    try:
        scenario_id, reply = generate_reply(_client, turns, scenario_id=req.scenario_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Model call failed: {exc}")
    if not reply:
        raise HTTPException(status_code=502, detail="Model returned an empty reply")
    return {"scenario_id": scenario_id, "human_speaker": HUMAN_SPEAKER, "bot_speaker": BOT_SPEAKER, "reply": reply}


@app.websocket("/live-call/stt")
async def live_call_stt(websocket: WebSocket):
    await websocket.accept()
    session = NovaSonicSession()
    try:
        await session.start()
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": f"Could not start Nova Sonic session: {exc}"})
        await websocket.close()
        return

    async def forward_transcripts():
        try:
            async for text in session.transcripts():
                await websocket.send_json({"type": "transcript", "text": text})
            await websocket.send_json({"type": "session_ended"})
        except Exception:
            pass  # client likely already disconnected

    forward_task = asyncio.create_task(forward_transcripts())
    try:
        while True:
            data = await websocket.receive_bytes()
            await session.send_audio(data)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        # Close the Nova Sonic session first so its reader task winds down
        # naturally (feeding forward_task its final sentinel) instead of
        # being cancelled out from under an in-flight receive.
        await session.close()
        try:
            await asyncio.wait_for(forward_task, timeout=2)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            forward_task.cancel()
