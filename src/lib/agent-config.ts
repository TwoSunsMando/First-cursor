export const DEFAULT_VOICE = "eve";
export const DEFAULT_MODEL = "grok-voice-latest";
export const REALTIME_URL = "wss://api.x.ai/v1/realtime";

export const VOICES = [
  { id: "eve", label: "Eve", description: "Warm default" },
  { id: "ara", label: "Ara", description: "Bright and conversational" },
  { id: "rex", label: "Rex", description: "Deep and grounded" },
  { id: "sal", label: "Sal", description: "Smooth and calm" },
] as const;

export type VoiceId = (typeof VOICES)[number]["id"];

export const AGENT_INSTRUCTIONS = `You are Grok, a real-time voice agent.
Speak naturally, briefly, and like a sharp friend.
Answer the question first, then add one useful detail if it helps.
If you need current information, use web_search.
If the user asks what time it is, use get_current_time.`;

export const CLIENT_TOOLS = [
  {
    type: "function",
    name: "get_current_time",
    description: "Get the current date and time in the user's locale.",
    parameters: {
      type: "object",
      properties: {
        timeZone: {
          type: "string",
          description: "Optional IANA time zone, such as America/Los_Angeles.",
        },
      },
    },
  },
] as const;

export const SERVER_TOOLS = [{ type: "web_search" }] as const;

export function buildSessionUpdate(options: {
  voice: string;
  sampleRate: number;
  instructions?: string;
}) {
  return {
    type: "session.update",
    session: {
      voice: options.voice,
      instructions: options.instructions ?? AGENT_INSTRUCTIONS,
      reasoning: { effort: "none" },
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 600,
      },
      audio: {
        input: {
          format: { type: "audio/pcm", rate: options.sampleRate },
          transcription: {
            language_hint: "en",
            keyterms: ["Grok", "xAI", "Vercel"],
          },
        },
        output: {
          format: { type: "audio/pcm", rate: options.sampleRate },
        },
      },
      tools: [...SERVER_TOOLS, ...CLIENT_TOOLS],
    },
  };
}
