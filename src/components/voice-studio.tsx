"use client";

import { VOICES } from "@/lib/agent-config";
import { useVoiceAgent } from "@/hooks/use-voice-agent";
import { TranscriptList } from "@/components/transcript-list";
import { VoiceOrb } from "@/components/voice-orb";

export function VoiceStudio() {
  const {
    status,
    error,
    configured,
    voice,
    setVoice,
    audioLevel,
    transcript,
    connect,
    disconnect,
  } = useVoiceAgent();

  const live = status === "connecting" || status === "listening" || status === "speaking" || status === "thinking";

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-10 sm:px-10">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-amber-200/70">
            Grok Voice Agent
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
            Talk to your first voice agent
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
            This app mints a short-lived xAI token on the server, then streams
            your microphone to Grok Voice over a WebSocket. The API key never
            reaches the browser.
          </p>
        </div>
        <label className="flex flex-col gap-2 text-xs uppercase tracking-[0.18em] text-zinc-500">
          Voice
          <select
            value={voice}
            disabled={live}
            onChange={(event) => setVoice(event.target.value)}
            className="rounded-full border border-white/10 bg-black/40 px-4 py-2 text-sm normal-case tracking-normal text-zinc-100 outline-none disabled:opacity-50"
          >
            {VOICES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label} — {option.description}
              </option>
            ))}
          </select>
        </label>
      </header>

      {configured === false ? (
        <section className="rounded-3xl border border-amber-400/20 bg-amber-400/10 px-5 py-4 text-sm leading-6 text-amber-50">
          Add an <code className="font-mono text-amber-100">XAI_API_KEY</code> to{" "}
          <code className="font-mono text-amber-100">.env.local</code>, then
          restart the dev server. Create a key in the{" "}
          <a
            className="underline decoration-amber-300/60 underline-offset-4"
            href="https://console.x.ai/team/default/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            xAI console
          </a>
          .
        </section>
      ) : null}

      <section className="grid flex-1 gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col items-center justify-center gap-8 rounded-[2rem] border border-white/10 bg-white/5 px-6 py-12">
          <VoiceOrb status={status} audioLevel={audioLevel} />
          <div className="flex flex-wrap items-center justify-center gap-3">
            {live ? (
              <button
                type="button"
                onClick={disconnect}
                className="rounded-full bg-zinc-100 px-6 py-3 text-sm font-medium text-zinc-950 transition hover:bg-white"
              >
                End conversation
              </button>
            ) : (
              <button
                type="button"
                onClick={connect}
                disabled={configured === false}
                className="rounded-full bg-amber-300 px-6 py-3 text-sm font-medium text-zinc-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Start talking
              </button>
            )}
          </div>
          {error ? (
            <p className="max-w-md text-center text-sm leading-6 text-red-300">
              {error}
            </p>
          ) : (
            <p className="max-w-md text-center text-sm leading-6 text-zinc-500">
              Allow the microphone, then speak naturally. Grok detects the end
              of your turn and can search the web or tell you the time.
            </p>
          )}
        </div>

        <aside className="flex min-h-80 flex-col rounded-[2rem] border border-white/10 bg-black/30 p-5">
          <h2 className="mb-4 text-xs uppercase tracking-[0.22em] text-zinc-500">
            Transcript
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <TranscriptList entries={transcript} />
          </div>
        </aside>
      </section>
    </main>
  );
}
