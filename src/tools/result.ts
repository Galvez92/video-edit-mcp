/** Shared MCP tool response helpers: one JSON text result, or a tool-level error. */
export const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export const fail = (message: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: message }],
});
