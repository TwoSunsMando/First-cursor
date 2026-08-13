"use client";

import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "@/hooks/use-voice-agent";

export function TranscriptList({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <p className="text-sm leading-6 text-zinc-500">
        Your conversation will appear here. Ask Grok the time, a current-events
        question, or just say hello.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 ${
            entry.role === "user"
              ? "self-end bg-white/10 text-zinc-100"
              : "self-start bg-amber-300/10 text-amber-50"
          }`}
        >
          <p className="mb-1 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            {entry.role === "user" ? "You" : "Grok"}
          </p>
          {entry.content}
        </li>
      ))}
      <div ref={endRef} />
    </ol>
  );
}
