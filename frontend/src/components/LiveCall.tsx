"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Paper, Stack, Text } from "@mantine/core";

interface Turn {
  id: string;
  speaker: string;
  fromHuman: boolean;
  text: string;
  pending?: boolean;
}

const HUMAN_SPEAKER = "Doctor";
const BOT_SPEAKER = "Patient";

const FALLBACK_REPLIES = [
  "Sorry, could you say that again?",
  "I'm not sure, could you rephrase that?",
  "Okay, give me a moment to think.",
  "Can you ask that a different way?",
  "Sorry, I didn't quite catch that.",
];

const FALLBACK_CLOSINGS = ["Okay, thank you doctor.", "Alright, thanks for your help.", "Okay, I understand. Thank you."];

const NO_SPEECH_HINT_MS = 8000;
const TARGET_SAMPLE_RATE = 16000;
const PREVIEW_MAX_ERRORS = 3;

const WS_BASE = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? "ws://localhost:8000";

// Downsamples mic audio to 16kHz mono, converts to 16-bit PCM, and posts
// ~100ms chunks back to the main thread -- the format Nova Sonic expects.
const WORKLET_SOURCE = `
class PCMStreamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetSampleRate = options.processorOptions.targetSampleRate;
    this.ratio = sampleRate / targetSampleRate;
    this.chunkSamples = Math.round(targetSampleRate * 0.1);
    this.buffer = [];
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += this.ratio) {
      this.buffer.push(channel[Math.floor(i)] ?? 0);
      if (this.buffer.length >= this.chunkSamples) {
        const int16 = new Int16Array(this.buffer.length);
        for (let j = 0; j < this.buffer.length; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]));
          int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(int16.buffer, [int16.buffer]);
        this.buffer = [];
      }
    }
    return true;
  }
}
registerProcessor("pcm-stream-processor", PCMStreamProcessor);
`;

function pickRandom<T>(pool: T[], avoid?: T): T {
  if (pool.length === 1) return pool[0];
  let choice = pool[Math.floor(Math.random() * pool.length)];
  if (choice === avoid) {
    choice = pool[Math.floor(Math.random() * pool.length)];
  }
  return choice;
}

function renderTranscript(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker}: ${t.text}`).join("\n");
}

interface Props {
  checklistLocked: boolean;
  onCallEnd: (transcriptText: string) => void;
  onActiveChange?: (active: boolean) => void;
}

export function LiveCall({ checklistLocked, onCallEnd, onActiveChange }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<"idle" | "active" | "ended">("idle");
  const [botPending, setBotPending] = useState(false);
  const [unsupported] = useState(() => {
    if (typeof window === "undefined") return false;
    return !(
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      typeof WebSocket !== "undefined"
    );
  });
  const [micError, setMicError] = useState<string | null>(null);
  const [noAudioWarning, setNoAudioWarning] = useState(false);

  const activeRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const turnsRef = useRef<Turn[]>([]);
  const pendingTurnIdRef = useRef<string | null>(null);
  const scenarioIdRef = useRef<string | null>(null);
  const lastBotLineRef = useRef<string | undefined>(undefined);
  const botRequestRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const noSpeechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  // Cosmetic-only: the browser's own speech recognition, shown as a live "ghost"
  // preview while talking. Nova Sonic (over the WebSocket above) remains the sole
  // source of truth for the actual transcript and for triggering bot replies.
  const previewRecognitionRef = useRef<SpeechRecognition | null>(null);
  const previewActiveRef = useRef(false);
  const previewErrorCountRef = useRef(0);
  const suppressPreviewResultRef = useRef(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, botPending]);

  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
      activeRef.current = false;
      botRequestRef.current?.abort();
      if (noSpeechTimeoutRef.current) clearTimeout(noSpeechTimeoutRef.current);
      wsRef.current?.close();
      stopAudioPipeline();
      stopPreviewRecognition();
    };
  }, []);

  function stopAudioPipeline() {
    workletNodeRef.current?.port.close();
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  }

  function startPreviewRecognition() {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return; // no live preview in this browser -- everything else still works

    previewActiveRef.current = true;
    previewErrorCountRef.current = 0;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      // Discard the "final flush" result that .stop() triggers when we force a
      // clean restart after Nova Sonic confirms a segment -- otherwise it would
      // recreate a ghost bubble with the very text we just confirmed.
      if (suppressPreviewResultRef.current) return;
      let text = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
      }
      text = text.trim();
      if (text) upsertPendingHumanTurn(text);
    };

    recognition.onerror = (event) => {
      if (event.error === "aborted") return;
      console.warn("Preview speech recognition error (cosmetic only, non-fatal):", event.error);
      previewErrorCountRef.current += 1;
      if (previewErrorCountRef.current >= PREVIEW_MAX_ERRORS) {
        previewActiveRef.current = false; // give up quietly, e.g. Brave/Firefox with no live preview support
      }
    };

    recognition.onend = () => {
      suppressPreviewResultRef.current = false;
      if (previewActiveRef.current) {
        try {
          recognition.start();
        } catch {
          // already running -- ignore the restart race
        }
      }
    };

    previewRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore -- a stray double-start can throw
    }
  }

  function stopPreviewRecognition() {
    previewActiveRef.current = false;
    previewRecognitionRef.current?.stop();
    previewRecognitionRef.current = null;
  }

  // The browser's own recognizer segments speech independently from Nova
  // Sonic -- without this, it keeps reporting the tail end of an utterance
  // Nova Sonic already confirmed, creating a second ghost bubble under the
  // confirmed one. Forcing a clean restart on every confirmation stops it
  // from ever reporting content that overlaps with what's already confirmed.
  function restartPreviewRecognitionForCleanBoundary() {
    if (!previewRecognitionRef.current) return;
    suppressPreviewResultRef.current = true;
    try {
      previewRecognitionRef.current.stop();
    } catch {
      // ignore
    }
  }

  function appendTurn(fromHuman: boolean, speaker: string, text: string) {
    const turn: Turn = { id: crypto.randomUUID(), speaker, fromHuman, text };
    turnsRef.current = [...turnsRef.current, turn];
    setTurns(turnsRef.current);
    if (fromHuman) {
      setNoAudioWarning(false);
    } else {
      lastBotLineRef.current = text;
    }
  }

  // Creates (or updates in place) a single live-updating bubble for the
  // in-progress utterance, sourced from the browser's own speech recognition.
  function upsertPendingHumanTurn(text: string) {
    setNoAudioWarning(false);
    if (pendingTurnIdRef.current) {
      const id = pendingTurnIdRef.current;
      turnsRef.current = turnsRef.current.map((t) => (t.id === id ? { ...t, text } : t));
      setTurns(turnsRef.current);
      return;
    }
    const turn: Turn = { id: crypto.randomUUID(), speaker: HUMAN_SPEAKER, fromHuman: true, text, pending: true };
    turnsRef.current = [...turnsRef.current, turn];
    pendingTurnIdRef.current = turn.id;
    setTurns(turnsRef.current);
  }

  // Nova Sonic's finalized transcript for that same utterance: upgrade the
  // pending bubble in place (accurate text, no longer ghosted) instead of
  // appending a second one. Falls back to a fresh turn if no pending bubble
  // exists (e.g. the browser preview isn't available in this browser).
  function confirmHumanTurn(text: string) {
    restartPreviewRecognitionForCleanBoundary();
    if (pendingTurnIdRef.current) {
      const id = pendingTurnIdRef.current;
      pendingTurnIdRef.current = null;
      turnsRef.current = turnsRef.current.map((t) => (t.id === id ? { ...t, text, pending: false } : t));
      setTurns(turnsRef.current);
      setNoAudioWarning(false);
      return;
    }
    appendTurn(true, HUMAN_SPEAKER, text);
  }

  async function scheduleBotReply() {
    setBotPending(true);
    botRequestRef.current?.abort();
    const controller = new AbortController();
    botRequestRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch("/api/live-call/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          turns: turnsRef.current.map((t) => ({ speaker: t.speaker, text: t.text })),
          scenario_id: scenarioIdRef.current ?? undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Reply request failed (${res.status})`);
      const data = await res.json();
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      if (!reply) throw new Error("Model returned an empty reply");

      if (botRequestRef.current === controller) {
        if (typeof data.scenario_id === "string" && data.scenario_id) {
          scenarioIdRef.current = data.scenario_id;
        }
        appendTurn(false, BOT_SPEAKER, reply);
      }
    } catch (err) {
      // Aborted because the call ended (not a timeout) -- don't append anything more.
      if (controller.signal.aborted && stopRequestedRef.current) return;
      console.warn("Live-call reply failed, falling back to a canned response:", err);
      if (botRequestRef.current === controller) {
        appendTurn(false, BOT_SPEAKER, pickRandom(FALLBACK_REPLIES, lastBotLineRef.current));
      }
    } finally {
      clearTimeout(timeoutId);
      if (botRequestRef.current === controller) {
        botRequestRef.current = null;
        setBotPending(false);
      }
    }
  }

  async function setupAudioPipeline(stream: MediaStream, onChunk: (buf: ArrayBuffer) => void) {
    const audioContext = new AudioContext();
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(blob);
    try {
      await audioContext.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-stream-processor", {
      processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
    });
    workletNode.port.onmessage = (event) => onChunk(event.data as ArrayBuffer);
    source.connect(workletNode);
    // Deliberately not connected to audioContext.destination -- we don't want to play the mic back.

    audioContextRef.current = audioContext;
    workletNodeRef.current = workletNode;
  }

  function stopAfterFatalError(message: string) {
    setMicError(message);
    stopRequestedRef.current = true;
    activeRef.current = false;
    onActiveChange?.(false);
    setPhase("idle");
    wsRef.current?.close();
    wsRef.current = null;
    stopAudioPipeline();
    stopPreviewRecognition();
  }

  async function startCall() {
    if (!checklistLocked) return;
    if (unsupported) return;

    setMicError(null);
    setNoAudioWarning(false);
    turnsRef.current = [];
    setTurns([]);
    pendingTurnIdRef.current = null;
    scenarioIdRef.current = null;
    lastBotLineRef.current = undefined;
    stopRequestedRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn("getUserMedia failed:", err);
      setMicError("Microphone access was denied. Allow mic access in your browser (and in your OS mic privacy settings) and start the call again.");
      return;
    }
    mediaStreamRef.current = stream;

    const ws = new WebSocket(`${WS_BASE}/live-call/stt`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = async () => {
      try {
        await setupAudioPipeline(stream, (buf) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(buf);
        });
      } catch (err) {
        console.warn("Could not start audio pipeline:", err);
        stopAfterFatalError("Could not start audio capture in this browser. Try Chrome, Edge, or Firefox.");
        return;
      }

      activeRef.current = true;
      setPhase("active");
      onActiveChange?.(true);
      startPreviewRecognition();

      noSpeechTimeoutRef.current = setTimeout(() => {
        if (turnsRef.current.every((t) => !t.fromHuman)) setNoAudioWarning(true);
      }, NO_SPEECH_HINT_MS);
    };

    ws.onmessage = (event) => {
      let data: { type?: string; text?: string; message?: string };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === "transcript" && data.text) {
        confirmHumanTurn(data.text);
        scheduleBotReply();
      } else if (data.type === "error") {
        stopAfterFatalError(data.message ?? "The transcription service reported an error.");
      } else if (data.type === "session_ended" && activeRef.current && !stopRequestedRef.current) {
        stopAfterFatalError("The transcription session ended unexpectedly. Start the call again.");
      }
    };

    ws.onerror = () => {
      if (activeRef.current && !stopRequestedRef.current) {
        stopAfterFatalError("Lost connection to the transcription service. Check that the backend is running and start the call again.");
      } else if (!activeRef.current) {
        setMicError("Could not connect to the transcription service. Check that the backend is running.");
      }
    };
  }

  function endCall() {
    stopRequestedRef.current = true;
    activeRef.current = false;
    onActiveChange?.(false);
    botRequestRef.current?.abort();
    botRequestRef.current = null;
    setBotPending(false);
    setNoAudioWarning(false);
    if (noSpeechTimeoutRef.current) {
      clearTimeout(noSpeechTimeoutRef.current);
      noSpeechTimeoutRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    stopAudioPipeline();
    stopPreviewRecognition();

    // Don't leave a bubble stuck looking "unconfirmed" once the call is over.
    if (pendingTurnIdRef.current) {
      const id = pendingTurnIdRef.current;
      pendingTurnIdRef.current = null;
      turnsRef.current = turnsRef.current.map((t) => (t.id === id ? { ...t, pending: false } : t));
    }

    appendTurn(false, BOT_SPEAKER, pickRandom(FALLBACK_CLOSINGS));
    setPhase("ended");
    onCallEnd(renderTranscript(turnsRef.current));
  }

  return (
    <Paper withBorder p="lg" radius="md" h="100%" style={{ display: "flex", flexDirection: "column" }}>
      <Stack gap="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Group justify="space-between" style={{ flexShrink: 0 }}>
          <Text size="sm" fw={500}>
            Live Call — Medical Consultation
          </Text>
          {phase === "active" && (
            <Group gap={6}>
              <span className="live-dot" />
              <Text size="xs" c="dimmed">
                Listening…
              </Text>
            </Group>
          )}
        </Group>

        {unsupported && (
          <Alert color="yellow" title="Live transcription not supported">
            Your browser doesn&apos;t support microphone streaming (Web Audio + WebSocket). Try Chrome, Edge, or
            Firefox, or use the &quot;Paste / Upload&quot; tab instead.
          </Alert>
        )}
        {micError && (
          <Alert color="red" title="Microphone error">
            {micError}
          </Alert>
        )}
        {noAudioWarning && !micError && (
          <Alert color="yellow" title="No speech detected yet">
            The mic is capturing but nothing has been transcribed yet. Check that it isn&apos;t muted and that the
            correct input device is selected, then keep talking.
          </Alert>
        )}

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 4,
          }}
        >
          {turns.length === 0 && phase === "idle" && !unsupported && (
            <Text c="dimmed" size="sm">
              Start the call — you&apos;re the doctor. A simulated patient will pick a condition and describe their
              symptoms naturally as you ask; anything off-topic will be politely refused, in character.
            </Text>
          )}

          {turns.map((turn) => (
            <TurnBubble
              key={turn.id}
              speaker={turn.speaker}
              text={turn.text}
              fromHuman={turn.fromHuman}
              interim={turn.pending}
            />
          ))}

          {botPending && (
            <Text size="xs" c="dimmed" fs="italic" ml={4}>
              {BOT_SPEAKER} is responding…
            </Text>
          )}
        </div>

        <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
          {phase === "active" ? (
            <Button color="red" onClick={endCall}>
              End Call
            </Button>
          ) : (
            <Button onClick={startCall} disabled={unsupported || !checklistLocked}>
              {phase === "ended" ? "Start New Call" : "Start Call"}
            </Button>
          )}
          {phase !== "active" && !checklistLocked && (
            <Text size="xs" c="dimmed">
              Save the checklist on the right before starting a call.
            </Text>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

function TurnBubble({
  speaker,
  text,
  fromHuman,
  interim,
}: {
  speaker: string;
  text: string;
  fromHuman: boolean;
  interim?: boolean;
}) {
  return (
    <Group
      justify={fromHuman ? "flex-end" : "flex-start"}
      wrap="nowrap"
      className={interim ? undefined : "turn-bubble"}
    >
      <Paper
        withBorder={!fromHuman}
        p="xs"
        radius="md"
        maw="80%"
        style={{
          backgroundColor: fromHuman ? "var(--mantine-color-blue-6)" : "var(--mantine-color-default)",
          color: fromHuman ? "var(--mantine-color-white)" : undefined,
          opacity: interim ? 0.6 : 1,
        }}
      >
        <Text size="xs" fw={600} mb={2} c={fromHuman ? "blue.1" : "dimmed"}>
          {speaker}
        </Text>
        <Text size="sm">{text}</Text>
      </Paper>
    </Group>
  );
}
