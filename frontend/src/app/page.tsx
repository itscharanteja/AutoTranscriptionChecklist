"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Container, FileButton, Group, Paper, Stack, Tabs, Text, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { ChecklistEditor } from "@/components/ChecklistEditor";
import { LiveCall } from "@/components/LiveCall";
import type { Checklist, EvaluateResponse } from "@/lib/types";

const PLACEHOLDER = `Agent: Hi, thanks for calling, this is Jamie.
Customer: Hi Jamie, I need help with my order.
Agent: Sure, can I get your order number?
...`;

export default function Home() {
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [checklistId, setChecklistId] = useState<string | null>(null);
  const [checklistLocked, setChecklistLocked] = useState(false);
  const [transcriptText, setTranscriptText] = useState("");
  const [result, setResult] = useState<EvaluateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>("live");
  const [callActive, setCallActive] = useState(false);

  useEffect(() => {
    fetch("/api/checklists")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load checklists (${res.status})`);
        return res.json() as Promise<Checklist[]>;
      })
      .then((data) => {
        setChecklists(data);
        if (data.length > 0) setChecklistId(data[0].id);
      })
      .catch((err) => setLoadError(err.message));
  }, []);

  function handleChecklistSaved(updated: Checklist) {
    setChecklists((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    setResult(null);
  }

  async function handleFileUpload(file: File | null) {
    if (!file) return;
    const text = await file.text();
    setTranscriptText(text);
  }

  async function runEvaluation() {
    if (!checklistId || !transcriptText.trim() || !checklistLocked) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/evaluate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checklist_id: checklistId, transcript_text: transcriptText }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail ?? `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let current: EvaluateResponse = {
        checklist_name: "",
        model: "",
        elapsed_seconds: 0,
        transcript_id: "ui-submission",
        source_path: "<pasted>",
        results: [],
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "start") {
            current = { ...current, checklist_name: evt.checklist_name, model: evt.model };
          } else if (evt.type === "item") {
            current = { ...current, results: [...current.results, evt] };
          } else if (evt.type === "done") {
            current = { ...current, elapsed_seconds: evt.elapsed_seconds };
          }
          setResult({ ...current });
        }
      }
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Evaluation failed",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }

  const canRun = !!checklistId && !!transcriptText.trim() && checklistLocked;

  return (
    <div className="app-shell">
      <Container size="xl" pt="xl" pb="md" style={{ flexShrink: 0, width: "100%" }}>
        <Title order={1} mb={4}>
          Transcript Checklist QA
        </Title>
        <Text c="dimmed" size="sm">
          Paste a two-person transcript, save your checklist, then run the review.
        </Text>

        {loadError && (
          <Alert color="red" mt="md" title="Could not load checklists">
            {loadError}
          </Alert>
        )}
      </Container>

      <Container size="xl" pb="xl" style={{ flex: 1, minHeight: 0, width: "100%", display: "flex" }}>
        <div className="two-col-row">
          <div className="two-col">
            <Tabs
              value={activeTab}
              onChange={setActiveTab}
              style={{ height: "100%", display: "flex", flexDirection: "column" }}
            >
              <Tabs.List style={{ flexShrink: 0 }}>
                <Tabs.Tab value="live">Live Call</Tabs.Tab>
                <Tabs.Tab value="paste" disabled={callActive}>
                  Paste / Upload
                </Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="live" pt="md" style={{ flex: 1, minHeight: 0 }}>
                <LiveCall
                  checklistLocked={checklistLocked}
                  onActiveChange={setCallActive}
                  onCallEnd={(text) => {
                    setTranscriptText(text);
                    setResult(null);
                    setActiveTab("paste");
                  }}
                />
              </Tabs.Panel>

              <Tabs.Panel value="paste" pt="md" style={{ flex: 1, minHeight: 0 }}>
                <Paper withBorder p="lg" radius="md" h="100%" style={{ display: "flex", flexDirection: "column" }}>
                  <Group justify="space-between" mb={4} style={{ flexShrink: 0 }}>
                    <Text size="sm" fw={500}>
                      Transcript
                    </Text>
                    <FileButton onChange={handleFileUpload} accept=".txt,.json">
                      {(props) => (
                        <Button variant="subtle" size="xs" {...props}>
                          Upload file
                        </Button>
                      )}
                    </FileButton>
                  </Group>
                  <Textarea
                    placeholder={PLACEHOLDER}
                    value={transcriptText}
                    onChange={(e) => setTranscriptText(e.currentTarget.value)}
                    style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
                    styles={{
                      wrapper: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
                      input: { fontFamily: "monospace", fontSize: 13, flex: 1, height: "100%", resize: "none" },
                    }}
                  />
                  <Text size="xs" c="dimmed" mt={4} style={{ flexShrink: 0 }}>
                    One line per turn: <code>Speaker: text</code> — or paste a JSON array of {"{speaker, text}"}. Or
                    finish a live call to fill this in automatically.
                  </Text>

                  <Stack gap={4} mt="md" align="flex-end" style={{ flexShrink: 0 }}>
                    <Button onClick={runEvaluation} loading={loading} disabled={!canRun}>
                      Run Evaluation
                    </Button>
                    {!checklistLocked && (
                      <Text size="xs" c="dimmed">
                        Save the checklist on the right before running.
                      </Text>
                    )}
                  </Stack>
                </Paper>
              </Tabs.Panel>
            </Tabs>
          </div>

          <div className="two-col">
            <ChecklistEditor
              key={checklistId ?? "none"}
              checklists={checklists}
              checklistId={checklistId}
              onChecklistIdChange={setChecklistId}
              onSaved={handleChecklistSaved}
              result={result}
              evaluating={loading}
              onLockChange={setChecklistLocked}
            />
          </div>
        </div>
      </Container>
    </div>
  );
}
