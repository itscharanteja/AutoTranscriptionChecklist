"use client";

import { useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { Checklist, EditableItem, EvaluateResponse, ItemStatus } from "@/lib/types";

function toEditable(checklist: Checklist): EditableItem[] {
  return checklist.items.map((item) => ({ key: crypto.randomUUID(), id: item.id, description: item.description }));
}

function snapshot(name: string, items: EditableItem[]) {
  return JSON.stringify({ name, items: items.map(({ id, description }) => ({ id, description })) });
}

const STATUS_COLOR: Record<ItemStatus, string> = {
  yes: "teal",
  no: "red",
  unclear: "gray",
};

const STATUS_GLYPH: Record<ItemStatus, string> = {
  yes: "✓",
  no: "✗",
  unclear: "?",
};

function confidenceColor(confidence: number): string {
  if (confidence >= 80) return "blue";
  if (confidence >= 50) return "yellow";
  return "orange";
}

interface Props {
  checklists: Checklist[];
  checklistId: string | null;
  onChecklistIdChange: (id: string) => void;
  onSaved: (updated: Checklist) => void;
  result: EvaluateResponse | null;
  evaluating: boolean;
  onLockChange: (locked: boolean) => void;
  callActive?: boolean;
}

// Rendered with key={checklistId} by the parent, so switching checklists remounts this
// component and re-initializes state below, instead of syncing props via an effect.
export function ChecklistEditor({
  checklists,
  checklistId,
  onChecklistIdChange,
  onSaved,
  result,
  evaluating,
  onLockChange,
  callActive = false,
}: Props) {
  const initialChecklist = checklists.find((c) => c.id === checklistId);
  const initialItems = initialChecklist ? toEditable(initialChecklist) : [];
  const initialName = initialChecklist?.name ?? "";

  const [name, setName] = useState(initialName);
  const [items, setItems] = useState<EditableItem[]>(initialItems);
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshot(initialName, initialItems));
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    onLockChange(locked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  const dirty = snapshot(name, items) !== savedSnapshot;

  function updateItem(key: string, patch: Partial<EditableItem>) {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  function removeItem(key: string) {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }

  function addItem() {
    setItems((prev) => [...prev, { key: crypto.randomUUID(), id: "", description: "" }]);
  }

  async function save() {
    if (!checklistId) return;
    if (items.length === 0) {
      notifications.show({ color: "red", title: "Cannot save", message: "Add at least one checklist item." });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/checklists/${encodeURIComponent(checklistId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          items: items.map(({ id, description }) => ({ id, description })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `Save failed (${res.status})`);
      setSavedSnapshot(snapshot(data.name, toEditable(data)));
      onSaved(data as Checklist);
      setLocked(true);
      notifications.show({ color: "teal", title: "Saved", message: `"${data.name}" updated.` });
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Save failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  const resultById = new Map((result?.results ?? []).map((r) => [r.id, r]));
  const hasResults = locked && result !== null && items.every((item) => resultById.has(item.id));
  const counts = hasResults
    ? items.reduce(
        (acc, item) => {
          const status = resultById.get(item.id)!.status;
          acc[status] += 1;
          return acc;
        },
        { yes: 0, no: 0, unclear: 0 } as Record<ItemStatus, number>
      )
    : null;

  return (
    <Paper withBorder p="lg" radius="md" h="100%" style={{ display: "flex", flexDirection: "column" }}>
      <Stack gap="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {evaluating && (
          <Group gap="xs" style={{ flexShrink: 0 }}>
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Evaluating… {resultById.size}/{items.length} items
            </Text>
          </Group>
        )}

        {hasResults && result && (
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {result.model} took {result.elapsed_seconds} secs to evaluate
          </Text>
        )}

        <Select
          label="Checklist"
          placeholder="Choose a checklist"
          data={checklists.map((c) => ({ value: c.id, label: c.name }))}
          value={checklistId}
          onChange={(value) => value && onChecklistIdChange(value)}
          disabled={checklists.length === 0 || callActive}
          style={{ flexShrink: 0 }}
        />

        {locked ? (
          <>
            <Group justify="space-between" style={{ flexShrink: 0 }}>
              <Text fw={600}>{name}</Text>
              {counts && (
                <Group gap={6}>
                  <Badge color="teal" size="sm">
                    {counts.yes} yes
                  </Badge>
                  <Badge color="red" size="sm">
                    {counts.no} no
                  </Badge>
                  <Badge color="gray" size="sm">
                    {counts.unclear} unclear
                  </Badge>
                </Group>
              )}
            </Group>

            <Stack gap={6} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {items.map((item) => {
                const itemResult = resultById.get(item.id);
                const status = itemResult?.status;
                const row = (
                  <Group
                    key={item.key}
                    wrap="nowrap"
                    align="flex-start"
                    gap="sm"
                    p="xs"
                    style={{ borderRadius: 6, cursor: itemResult ? "default" : undefined }}
                    className="checklist-row"
                  >
                    <ThemeIcon
                      radius="xl"
                      size={22}
                      color={status ? STATUS_COLOR[status] : "gray"}
                      variant={status ? "filled" : "light"}
                    >
                      <Text size="xs">{status ? STATUS_GLYPH[status] : "○"}</Text>
                    </ThemeIcon>
                    <div>
                      <Text size="sm">{item.description}</Text>
                      <Group gap={6}>
                        <Text size="xs" c="dimmed" ff="monospace">
                          {item.id}
                        </Text>
                        {itemResult && (
                          <Badge size="xs" variant="light" color={confidenceColor(itemResult.confidence)}>
                            {itemResult.confidence}% confidence
                          </Badge>
                        )}
                      </Group>
                    </div>
                  </Group>
                );
                return itemResult ? (
                  <Tooltip key={item.key} label={itemResult.evidence} multiline w={320} withArrow position="left">
                    {row}
                  </Tooltip>
                ) : (
                  row
                );
              })}
            </Stack>

            {hasResults ? (
              <Group justify="flex-end" style={{ flexShrink: 0 }}>
                <Button variant="light" onClick={() => setLocked(false)} disabled={callActive}>
                  Edit checklist
                </Button>
              </Group>
            ) : (
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                {callActive
                  ? "Scoring live as the call progresses…"
                  : "Checklist saved. Run an evaluation on the left to see results here."}
              </Text>
            )}
            {callActive && hasResults && (
              <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                Scoring live — end the call to edit the checklist.
              </Text>
            )}
          </>
        ) : (
          <>
            <TextInput
              label="Checklist name"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              style={{ flexShrink: 0 }}
            />

            <Stack gap="xs" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                Items
              </Text>
              <Stack gap="xs" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                {items.map((item) => (
                  <Group key={item.key} align="flex-start" gap="xs" wrap="nowrap">
                    <TextInput
                      value={item.id}
                      onChange={(e) => updateItem(item.key, { id: e.currentTarget.value })}
                      placeholder="id"
                      w={130}
                      styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
                    />
                    <Textarea
                      value={item.description}
                      onChange={(e) => updateItem(item.key, { description: e.currentTarget.value })}
                      placeholder="Checklist item description"
                      autosize
                      minRows={1}
                      style={{ flex: 1 }}
                    />
                    <ActionIcon color="red" variant="subtle" onClick={() => removeItem(item.key)} title="Remove item">
                      ×
                    </ActionIcon>
                  </Group>
                ))}
              </Stack>
              <Button variant="light" size="xs" onClick={addItem} style={{ flexShrink: 0 }}>
                + Add item
              </Button>
            </Stack>

            <Group justify="space-between" style={{ flexShrink: 0 }}>
              <Text size="xs" c={dirty ? "orange" : "dimmed"}>
                {dirty ? "Unsaved changes" : "Saved"}
              </Text>
              <Button onClick={save} loading={saving} disabled={!checklistId}>
                Save Checklist
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}
