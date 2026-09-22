export type ItemStatus = "yes" | "no" | "unclear";

export interface ChecklistItem {
  id: string;
  description: string;
}

export interface Checklist {
  id: string;
  name: string;
  items: ChecklistItem[];
}

export interface ItemResult {
  id: string;
  description: string;
  status: ItemStatus;
  confidence: number;
  evidence: string;
}

export interface EvaluateResponse {
  checklist_name: string;
  model: string;
  elapsed_seconds: number;
  transcript_id: string;
  source_path: string;
  results: ItemResult[];
}

export interface EditableItem {
  key: string;
  id: string;
  description: string;
}
