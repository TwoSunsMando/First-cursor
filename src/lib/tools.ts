type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

const handlers: Record<string, ToolHandler> = {
  get_current_time: (args) => {
    const timeZone =
      typeof args.timeZone === "string" && args.timeZone.length > 0
        ? args.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;

    const now = new Date();

    return {
      iso: now.toISOString(),
      formatted: new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now),
      timeZone,
    };
  },
};

export async function executeClientTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = handlers[name];

  if (!handler) {
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  const result = await handler(args);
  return JSON.stringify(result);
}
