import json
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional, Tuple

import yaml

from .models import ChecklistItem


def load_checklist(path) -> Tuple[str, List[ChecklistItem]]:
    file_path = Path(path)
    text = file_path.read_text()
    if file_path.suffix.lower() in (".yaml", ".yml"):
        data = yaml.safe_load(text)
    else:
        data = json.loads(text)

    items = [ChecklistItem(id=i["id"], description=i["description"]) for i in data["items"]]
    name = data.get("name", file_path.stem)
    return name, items


def find_checklist_path(directory, checklist_id: str) -> Optional[Path]:
    dir_path = Path(directory)
    for ext in (".yaml", ".yml", ".json"):
        candidate = dir_path / f"{checklist_id}{ext}"
        if candidate.exists():
            return candidate
    return None


def list_checklists(directory) -> List[dict]:
    dir_path = Path(directory)
    if not dir_path.exists():
        return []
    paths = sorted(p for p in dir_path.iterdir() if p.suffix.lower() in (".yaml", ".yml", ".json"))
    checklists = []
    for path in paths:
        name, items = load_checklist(path)
        checklists.append({"id": path.stem, "name": name, "items": [asdict(i) for i in items]})
    return checklists


def save_checklist(directory, checklist_id: str, name: str, items: List[ChecklistItem]) -> Path:
    dir_path = Path(directory)
    dir_path.mkdir(parents=True, exist_ok=True)
    path = find_checklist_path(directory, checklist_id) or (dir_path / f"{checklist_id}.yaml")

    data = {"name": name, "items": [{"id": i.id, "description": i.description} for i in items]}
    if path.suffix.lower() in (".yaml", ".yml"):
        path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    else:
        path.write_text(json.dumps(data, indent=2))
    return path
