"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  REALTIME_URL,
  buildSessionUpdate,
} from "@/lib/agent-config";
import {
  base64PCM16ToFloat32,
  float32ToPCM16Base64,
  supportedSampleRate,
} from "@/lib/audio";
import { executeClientTool } from "@/lib/tools";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "thinking"
  | "error";

export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptEntry = {
  id: string;
  role: TranscriptRole;
  content: string;
};

type VoiceEvent = {
  type: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: {
    role?: string;
    content?: Array<{ type?: string; transcript?: string; text?: string }>;
  };
  error?: { message?: string } | string;
};

type SessionResponse = {
  client_secret?: { value?: string };
  model?: string;
  voice?: string;
  instructions?: string;
  error?: string;
};

const CHUNK_DURATION_MS = 100;

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useVoiceAgent() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackQueueRef = useRef<Float32Array[]>([]);
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sessionReadyRef = useRef(false);
  const pendingToolCallsRef = useRef<VoiceEvent[]>([]);
  const assistantBufferRef = useRef("");
  const statusRef = useRef<AgentStatus>("idle");

  const setAgentStatus = useCallback((next: AgentStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const updateLast = useCallback((role: TranscriptRole, content: string) => {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === role) {
        return [...prev.slice(0, -1), { ...last, content }];
      }
      return [...prev, { id: createId(), role, content }];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/session")
      .then(async (response) => {
        const data = (await response.json()) as {
          configured?: boolean;
          voice?: string;
        };
        if (cancelled) return;
        setConfigured(Boolean(data.configured));
        if (data.voice) setVoice(data.voice);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const getAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }

    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
        currentSourceRef.current.disconnect();
      } catch {
        // Already stopped.
      }
      currentSourceRef.current = null;
    }

    playbackQueueRef.current = [];
    isPlayingRef.current = false;
  }, []);

  const playNextChunkRef = useRef<(audioContext: AudioContext) => void>(() => {});

  useEffect(() => {
    playNextChunkRef.current = (audioContext: AudioContext) => {
      const chunk = playbackQueueRef.current.shift();

      if (!chunk) {
        isPlayingRef.current = false;
        currentSourceRef.current = null;
        if (statusRef.current === "speaking") {
          setAgentStatus("listening");
        }
        return;
      }

      const buffer = audioContext.createBuffer(1, chunk.length, audioContext.sampleRate);
      buffer.getChannelData(0).set(chunk);

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      currentSourceRef.current = source;

      source.onended = () => {
        if (currentSourceRef.current === source) {
          currentSourceRef.current = null;
        }
        playNextChunkRef.current(audioContext);
      };

      source.start();
    };
  }, [setAgentStatus]);

  const playAudio = useCallback(
    async (base64Audio: string) => {
      const audioContext = await getAudioContext();
      playbackQueueRef.current.push(base64PCM16ToFloat32(base64Audio));

      if (!isPlayingRef.current) {
        isPlayingRef.current = true;
        setAgentStatus("speaking");
        playNextChunkRef.current(audioContext);
      }
    },
    [getAudioContext, setAgentStatus],
  );

  const waitForPlayback = useCallback(async () => {
    const started = Date.now();

    while (isPlayingRef.current || playbackQueueRef.current.length > 0) {
      if (Date.now() - started > 15000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(event));
  }, []);

  const resolveToolCalls = useCallback(async () => {
    const calls = pendingToolCallsRef.current;
    if (calls.length === 0) return;

    pendingToolCallsRef.current = [];
    setAgentStatus("thinking");

    await Promise.all(
      calls.map(async (call) => {
        const args = call.arguments ? JSON.parse(call.arguments) : {};
        const output = await executeClientTool(call.name ?? "", args);

        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.call_id,
            output,
          },
        });
      }),
    );

    await waitForPlayback();
    sendEvent({ type: "response.create" });
  }, [sendEvent, setAgentStatus, waitForPlayback]);

  const handleEvent = useCallback(
    async (event: VoiceEvent) => {
      switch (event.type) {
        case "session.updated":
          if (!sessionReadyRef.current) {
            sessionReadyRef.current = true;
            sendEvent({
              type: "conversation.item.create",
              item: {
                type: "force_message",
                role: "assistant",
                interruptible: true,
                content: [
                  {
                    type: "output_text",
                    text: "Hey — I'm Grok. Talk whenever you're ready.",
                  },
                ],
              },
            });
            setAgentStatus("listening");
          }
          break;
        case "response.output_audio.delta":
        case "response.audio.delta":
          if (event.delta) {
            void playAudio(event.delta);
          }
          break;
        case "response.output_audio_transcript.delta":
          if (event.delta) {
            assistantBufferRef.current += event.delta;
            updateLast("assistant", assistantBufferRef.current);
          }
          break;
        case "response.done":
          assistantBufferRef.current = "";
          if (pendingToolCallsRef.current.length > 0) {
            await resolveToolCalls();
          } else if (!isPlayingRef.current) {
            setAgentStatus("listening");
          }
          break;
        case "input_audio_buffer.speech_started":
          stopPlayback();
          setAgentStatus("listening");
          updateLast("user", "Listening…");
          break;
        case "conversation.item.added":
        case "conversation.item.created": {
          const item = event.item;
          if (item?.role === "user" && item.content) {
            for (const part of item.content) {
              const text = part.transcript ?? part.text;
              if (text) {
                updateLast("user", text);
                break;
              }
            }
          }
          break;
        }
        case "response.function_call_arguments.done":
          pendingToolCallsRef.current.push(event);
          break;
        case "error": {
          const message =
            typeof event.error === "string"
              ? event.error
              : event.error?.message ?? "Voice session error";
          setError(message);
          setAgentStatus("error");
          break;
        }
        default:
          break;
      }
    },
    [
      playAudio,
      resolveToolCalls,
      sendEvent,
      setAgentStatus,
      stopPlayback,
      updateLast,
    ],
  );

  const startCapture = useCallback(
    async (onAudio: (base64Audio: string) => void) => {
      const audioContext = await getAudioContext();
      const sampleRate = supportedSampleRate(audioContext.sampleRate);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      const buffers: Float32Array[] = [];
      let totalSamples = 0;
      const chunkSize = Math.round((audioContext.sampleRate * CHUNK_DURATION_MS) / 1000);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        setAudioLevel(Math.sqrt(sum / input.length));

        buffers.push(new Float32Array(input));
        totalSamples += input.length;

        while (totalSamples >= chunkSize) {
          const chunk = new Float32Array(chunkSize);
          let offset = 0;

          while (offset < chunkSize && buffers.length > 0) {
            const next = buffers[0];
            const needed = chunkSize - offset;

            if (next.length <= needed) {
              chunk.set(next, offset);
              offset += next.length;
              totalSamples -= next.length;
              buffers.shift();
            } else {
              chunk.set(next.subarray(0, needed), offset);
              buffers[0] = next.subarray(needed);
              offset += needed;
              totalSamples -= needed;
            }
          }

          onAudio(float32ToPCM16Base64(chunk));
        }
      };

      const mute = audioContext.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(audioContext.destination);

      return sampleRate;
    },
    [getAudioContext],
  );

  const disconnect = useCallback(() => {
    sessionReadyRef.current = false;
    pendingToolCallsRef.current = [];
    assistantBufferRef.current = "";
    stopPlayback();

    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setAudioLevel(0);
    setAgentStatus("idle");
  }, [setAgentStatus, stopPlayback]);

  const connect = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setAgentStatus("connecting");

    try {
      const sessionResponse = await fetch("/api/session", { method: "POST" });
      const session = (await sessionResponse.json()) as SessionResponse;

      if (!sessionResponse.ok || !session.client_secret?.value) {
        throw new Error(session.error ?? "Could not create a voice session.");
      }

      const sampleRate = await startCapture((audio) => {
        if (!sessionReadyRef.current) return;
        sendEvent({ type: "input_audio_buffer.append", audio });
      });

      const model = session.model ?? DEFAULT_MODEL;
      const url = `${REALTIME_URL}?model=${encodeURIComponent(model)}`;
      const token = session.client_secret.value;
      const ws = new WebSocket(url, [`xai-client-secret.${token}`]);
      wsRef.current = ws;

      ws.onopen = () => {
        sendEvent(
          buildSessionUpdate({
            voice,
            sampleRate,
            instructions: session.instructions,
          }),
        );
      };

      ws.onmessage = (message) => {
        if (typeof message.data !== "string") return;

        try {
          void handleEvent(JSON.parse(message.data) as VoiceEvent);
        } catch (parseError) {
          console.error("Failed to parse voice event", parseError);
        }
      };

      ws.onerror = () => {
        setError("The voice connection failed.");
        setAgentStatus("error");
      };

      ws.onclose = () => {
        if (statusRef.current !== "idle") {
          disconnect();
        }
      };
    } catch (connectError) {
      const message =
        connectError instanceof Error
          ? connectError.message
          : "Could not start the voice agent.";
      setError(message);
      setAgentStatus("error");
      disconnect();
    }
  }, [disconnect, handleEvent, sendEvent, setAgentStatus, startCapture, voice]);

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    status,
    error,
    configured,
    voice,
    setVoice,
    audioLevel,
    transcript,
    connect,
    disconnect,
  };
}
