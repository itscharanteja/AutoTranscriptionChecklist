"use client";

import { useEffect, useState } from "react";
import { Alert, Button, Container, FileButton, Grid, Group, Paper, Stack, Text, Textarea, Title } from "@mantine/core";
import { ChecklistEditor } from "@/components/ChecklistEditor";
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
  const [runError, setRunError] = useState<string | null>(null);

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
    setRunError(null);
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
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const canRun = !!checklistId && !!transcriptText.trim() && checklistLocked;

  return (
    <Container size="xl" py="xl">
      <Title order={1} mb="xs">
        Transcript Checklist QA
      </Title>
      <Text c="dimmed" mb="lg">
        Paste a two-person transcript, save your checklist, then run the review.
      </Text>

      {loadError && (
        <Alert color="red" mb="md" title="Could not load checklists">
          {loadError}
        </Alert>
      )}

      <Grid mb="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder p="lg" radius="md" h="100%">
            <div>
              <Group justify="space-between" mb={4}>
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
                autosize
                minRows={14}
                maxRows={28}
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.currentTarget.value)}
                styles={{ input: { fontFamily: "monospace", fontSize: 13 } }}
              />
              <Text size="xs" c="dimmed" mt={4}>
                One line per turn: <code>Speaker: text</code> — or paste a JSON array of {"{speaker, text}"}.
              </Text>
            </div>

            <Stack gap={4} mt="md" align="flex-end">
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
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
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
        </Grid.Col>
      </Grid>

      {runError && (
        <Alert color="red" title="Evaluation failed">
          {runError}
        </Alert>
      )}
    </Container>
  );
}
