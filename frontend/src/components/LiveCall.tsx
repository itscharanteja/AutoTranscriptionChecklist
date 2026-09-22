"use client";

import { useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Paper, Stack, Text } from "@mantine/core";

interface Turn {
  id: string;
  speaker: string;
  fromHuman: boolean;
  text: string;
}

const FALLBACK_REPLIES = [
  "Sorry, could you say that again?",
  "I understand, go on.",
  "Okay, got it.",
  "Can you tell me a bit more about that?",
  "That makes sense.",
];

const FALLBACK_CLOSINGS = ["Okay, thank you.", "Alright, got it. Thanks.", "Sounds good, thank you.", "Okay, understood."];

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
  const [interim, setInterim] = useState("");
  const [phase, setPhase] = useState<"idle" | "active" | "ended">("idle");
  const [botPending, setBotPending] = useState(false);
  const [unsupported, setUnsupported] = useState(() => {
    if (typeof window === "undefined") return false;
    return !(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  });
  const [micError, setMicError] = useState<string | null>(null);
  const [noAudioWarning, setNoAudioWarning] = useState(false);
  const [braveWarning, setBraveWarning] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const turnsRef = useRef<Turn[]>([]);
  const humanSpeakerRef = useRef<string | null>(null);
  const botSpeakerRef = useRef<string | null>(null);
  const lastBotLineRef = useRef<string | undefined>(undefined);
  const botRequestRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const noSpeechCountRef = useRef(0);

  useEffect(() => {
    navigator.brave
      ?.isBrave()
      .then((isBrave) => {
        if (isBrave) setBraveWarning(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, interim, botPending]);

  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
      activeRef.current = false;
      botRequestRef.current?.abort();
      recognitionRef.current?.stop();
    };
  }, []);

  function appendTurn(fromHuman: boolean, speaker: string, text: string) {
    const turn: Turn = { id: crypto.randomUUID(), speaker, fromHuman, text };
    turnsRef.current = [...turnsRef.current, turn];
    setTurns(turnsRef.current);
    if (fromHuman) {
      noSpeechCountRef.current = 0;
      setNoAudioWarning(false);
    } else {
      lastBotLineRef.current = text;
    }
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
          human_speaker: humanSpeakerRef.current ?? undefined,
          bot_speaker: botSpeakerRef.current ?? undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Reply request failed (${res.status})`);
      const data = await res.json();
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      if (!reply) throw new Error("Model returned an empty reply");

      if (botRequestRef.current === controller) {
        // First exchange: lock in the roles the model inferred, and retroactively relabel
        // the placeholder "You" turn(s) said before we knew what to call either side.
        if (!humanSpeakerRef.current || !botSpeakerRef.current) {
          const inferredHuman = typeof data.human_speaker === "string" && data.human_speaker.trim() ? data.human_speaker.trim() : "You";
          const inferredBot = typeof data.bot_speaker === "string" && data.bot_speaker.trim() ? data.bot_speaker.trim() : "Them";
          humanSpeakerRef.current = inferredHuman;
          botSpeakerRef.current = inferredBot;
          turnsRef.current = turnsRef.current.map((t) => (t.fromHuman ? { ...t, speaker: inferredHuman } : t));
          setTurns(turnsRef.current);
        }
        appendTurn(false, botSpeakerRef.current ?? "Them", reply);
      }
    } catch (err) {
      // Aborted because the call ended (not a timeout) -- don't append anything more.
      if (controller.signal.aborted && stopRequestedRef.current) return;
      console.warn("Live-call reply failed, falling back to a canned response:", err);
      if (botRequestRef.current === controller) {
        appendTurn(false, botSpeakerRef.current ?? "Them", pickRandom(FALLBACK_REPLIES, lastBotLineRef.current));
      }
    } finally {
      clearTimeout(timeoutId);
      if (botRequestRef.current === controller) {
        botRequestRef.current = null;
        setBotPending(false);
      }
    }
  }

  function startCall() {
    if (!checklistLocked) return;

    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setUnsupported(true);
      return;
    }

    setMicError(null);
    setNoAudioWarning(false);
    noSpeechCountRef.current = 0;
    turnsRef.current = [];
    setTurns([]);
    setInterim("");
    humanSpeakerRef.current = null;
    botSpeakerRef.current = null;
    lastBotLineRef.current = undefined;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interimStr = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript;
        if (res.isFinal) {
          const text = transcript.trim();
          if (text) {
            appendTurn(true, humanSpeakerRef.current ?? "You", text);
            scheduleBotReply();
          }
        } else {
          interimStr += transcript;
        }
      }
      if (interimStr.trim()) {
        noSpeechCountRef.current = 0;
        setNoAudioWarning(false);
      }
      setInterim(interimStr);
    };

    const stopAfterFatalError = (message: string) => {
      setMicError(message);
      stopRequestedRef.current = true;
      activeRef.current = false;
      onActiveChange?.(false);
      setPhase("idle");
    };

    recognition.onerror = (event) => {
      console.warn("Speech recognition error:", event.error, event.message);
      if (event.error === "aborted") return;

      if (event.error === "no-speech") {
        noSpeechCountRef.current += 1;
        if (noSpeechCountRef.current >= 2 && turnsRef.current.every((t) => t.fromHuman === false)) {
          setNoAudioWarning(true);
        }
        return;
      }

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopAfterFatalError(
          "Microphone access was denied. Allow mic access in your browser (and in your OS mic privacy settings) and start the call again."
        );
        return;
      }

      if (event.error === "audio-capture") {
        stopAfterFatalError("No microphone was found. Check that a mic is connected and selected as your system's input device.");
        return;
      }

      if (event.error === "network") {
        stopAfterFatalError(
          "Speech recognition lost its connection (your browser streams audio to a speech-to-text service to transcribe it live, so it needs internet access — some browsers, like Brave, block this entirely). Check your connection or try Chrome/Edge, then start the call again."
        );
        return;
      }

      stopAfterFatalError(`Speech recognition error: ${event.error}`);
    };

    recognition.onend = () => {
      if (activeRef.current && !stopRequestedRef.current) {
        try {
          recognition.start();
        } catch {
          // already running — ignore the restart race
        }
      }
    };

    recognitionRef.current = recognition;
    stopRequestedRef.current = false;
    activeRef.current = true;
    setPhase("active");
    onActiveChange?.(true);

    try {
      recognition.start();
    } catch {
      // ignore — a stray double-start can throw
    }
  }

  function endCall() {
    stopRequestedRef.current = true;
    activeRef.current = false;
    onActiveChange?.(false);
    botRequestRef.current?.abort();
    botRequestRef.current = null;
    setBotPending(false);
    setNoAudioWarning(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setInterim("");

    appendTurn(false, botSpeakerRef.current ?? "Them", pickRandom(FALLBACK_CLOSINGS));
    setPhase("ended");
    onCallEnd(renderTranscript(turnsRef.current));
  }

  const lastHumanSpeaker = [...turns].reverse().find((t) => t.fromHuman)?.speaker ?? "You";
  const lastBotSpeaker = [...turns].reverse().find((t) => !t.fromHuman)?.speaker ?? "The other side";

  return (
    <Paper withBorder p="lg" radius="md" h="100%" style={{ display: "flex", flexDirection: "column" }}>
      <Stack gap="md" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Group justify="space-between" style={{ flexShrink: 0 }}>
          <Text size="sm" fw={500}>
            Live Call
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

        {braveWarning && !unsupported && (
          <Alert color="yellow" title="Brave detected">
            Brave blocks the speech-to-text service this feature relies on, so live transcription will likely fail
            with a network error here. Open this app in Chrome or Edge instead for the live call feature.
          </Alert>
        )}
        {unsupported && (
          <Alert color="yellow" title="Live transcription not supported">
            Your browser doesn&apos;t support live speech recognition. Try Chrome or Edge, or use the
            &quot;Paste / Upload&quot; tab instead.
          </Alert>
        )}
        {micError && (
          <Alert color="red" title="Microphone error">
            {micError}
          </Alert>
        )}
        {noAudioWarning && !micError && (
          <Alert color="yellow" title="No speech detected yet">
            The browser isn&apos;t hearing anything. Check that the mic icon in your address bar isn&apos;t blocked,
            that the correct input device is selected, and that your OS microphone privacy setting allows this
            browser — then keep talking.
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
              Start the call, then just talk — a simulated other side of the conversation will pick up on the
              context and respond automatically, whatever you&apos;re discussing.
            </Text>
          )}

          {turns.map((turn) => (
            <TurnBubble key={turn.id} speaker={turn.speaker} text={turn.text} fromHuman={turn.fromHuman} />
          ))}

          {interim && <TurnBubble speaker={lastHumanSpeaker} text={interim} fromHuman interim />}

          {botPending && (
            <Text size="xs" c="dimmed" fs="italic" ml={4}>
              {lastBotSpeaker} is responding…
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
    <Group justify={fromHuman ? "flex-end" : "flex-start"} wrap="nowrap" className={interim ? undefined : "turn-bubble"}>
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
