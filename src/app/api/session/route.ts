import { NextResponse } from "next/server";
import {
  AGENT_INSTRUCTIONS,
  DEFAULT_MODEL,
  DEFAULT_VOICE,
} from "@/lib/agent-config";

const CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets";

function getApiKey() {
  return process.env.XAI_API_KEY?.trim() ?? "";
}

export async function GET() {
  return NextResponse.json({
    configured: Boolean(getApiKey()),
    model: process.env.XAI_VOICE_MODEL ?? DEFAULT_MODEL,
    voice: process.env.XAI_VOICE ?? DEFAULT_VOICE,
  });
}

export async function POST() {
  const apiKey = getApiKey();

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Missing XAI_API_KEY. Add it to .env.local from https://console.x.ai/team/default/api-keys",
      },
      { status: 503 },
    );
  }

  const response = await fetch(CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: { seconds: 300 },
    }),
  });

  const payload = (await response.json().catch(() => null)) as
    | {
        value?: string;
        expires_at?: number;
        client_secret?: { value?: string; expires_at?: number };
        error?: string | { message?: string };
      }
    | null;

  if (!response.ok || !payload) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : payload?.error?.message ?? "Failed to create an ephemeral voice session.";

    return NextResponse.json({ error: message }, { status: response.status });
  }

  const value = payload.client_secret?.value ?? payload.value;
  const expiresAt = payload.client_secret?.expires_at ?? payload.expires_at;

  if (!value) {
    return NextResponse.json(
      { error: "xAI did not return an ephemeral token." },
      { status: 502 },
    );
  }

  return NextResponse.json({
    client_secret: {
      value,
      expires_at: expiresAt,
    },
    model: process.env.XAI_VOICE_MODEL ?? DEFAULT_MODEL,
    voice: process.env.XAI_VOICE ?? DEFAULT_VOICE,
    instructions: AGENT_INSTRUCTIONS,
  });
}
