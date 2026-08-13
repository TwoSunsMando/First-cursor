# First Grok Voice Agent

A browser voice agent on [Grok Voice](https://docs.x.ai/developers/model-capabilities/audio/voice-agent). You talk into the microphone, Grok answers out loud, and the transcript updates live.

This is the recommended first build: one Next.js app, one secret on the server, and a direct WebSocket to xAI.

## How it works

1. The browser asks `/api/session` for a short-lived [ephemeral token](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens).
2. That route calls `https://api.x.ai/v1/realtime/client_secrets` with your `XAI_API_KEY`. The key never ships to the client.
3. The browser opens `wss://api.x.ai/v1/realtime?model=grok-voice-latest` with `xai-client-secret.<token>`.
4. Microphone audio is sent as 24 kHz PCM. Grok uses server VAD to decide when you finished speaking, then streams speech back.
5. Built-in `web_search` and a `get_current_time` tool give the agent something useful to do on day one.

```
Browser  --POST /api/session-->  Next.js  --API key-->  xAI client_secrets
   |                                                      |
   +-------- WebSocket + ephemeral token -----------------+
                      wss://api.x.ai/v1/realtime
```

## Setup

1. Create an API key in the [xAI console](https://console.x.ai/team/default/api-keys).
2. Copy the env file and add the key:

```bash
cp .env.example .env.local
```

```bash
XAI_API_KEY=xai-...
```

3. Install and run:

```bash
npm install
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000), click **Start talking**, allow the microphone, and say hello.

## What to try

- "Hey Grok, introduce yourself."
- "What time is it?"
- "Search the web for the latest Grok Voice model."

Change the voice in the dropdown before you start a call. `eve` is the xAI default.

## Customize the agent

Edit `src/lib/agent-config.ts` to change instructions, tools, or the default voice. Keep the prompt short — `grok-voice-think-fast-2.0` (what `grok-voice-latest` points at) works best with brief instructions.

Add another client tool in `src/lib/tools.ts`, then declare it in `CLIENT_TOOLS`. Server-side tools such as `web_search`, `x_search`, `file_search`, and remote MCP do not need client handlers.

## Deploy

Set `XAI_API_KEY` in your Vercel project environment, then deploy the app. The browser still talks to xAI directly after the token is minted, so you do not need a custom WebSocket server.

## Official references

- [Speech to Speech / Voice Agent](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
- [Ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens)
- [xAI web cookbook](https://github.com/xai-org/xai-cookbook/tree/main/voice-examples/agent/web)
