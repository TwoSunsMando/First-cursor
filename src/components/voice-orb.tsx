"use client";

import type { AgentStatus } from "@/hooks/use-voice-agent";

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Ready when you are",
  connecting: "Connecting to Grok…",
  listening: "Listening",
  speaking: "Grok is speaking",
  thinking: "Looking that up…",
  error: "Something went wrong",
};

export function VoiceOrb({
  status,
  audioLevel,
}: {
  status: AgentStatus;
  audioLevel: number;
}) {
  const active = status === "listening" || status === "speaking" || status === "thinking";
  const scale = active ? 1 + Math.min(audioLevel * 4, 0.28) : 1;

  return (
    <div className="relative flex h-64 w-64 items-center justify-center">
      <div
        className={`absolute inset-0 rounded-full blur-3xl transition-opacity duration-500 ${
          status === "speaking"
            ? "bg-amber-400/30"
            : status === "listening"
              ? "bg-sky-400/20"
              : status === "thinking"
                ? "bg-violet-400/20"
                : "bg-amber-500/10"
        }`}
      />
      <div
        className="relative h-44 w-44 rounded-full border border-white/10 bg-[radial-gradient(circle_at_30%_25%,#f8e7b0,transparent_42%),radial-gradient(circle_at_70%_70%,#f59e0b,transparent_55%),linear-gradient(180deg,#1a1408,#050505)] shadow-[0_0_80px_rgba(245,158,11,0.18)] transition-transform duration-100"
        style={{ transform: `scale(${scale})` }}
      >
        <div
          className={`absolute inset-6 rounded-full border border-white/10 ${
            active ? "animate-pulse" : ""
          }`}
        />
      </div>
      <p className="absolute bottom-0 text-sm tracking-wide text-zinc-400">
        {STATUS_LABEL[status]}
      </p>
    </div>
  );
}
