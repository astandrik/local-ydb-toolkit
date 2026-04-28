export function successResult(result: unknown) {
  const data = result as { summary?: string };
  return {
    content: [
      { type: "text", text: data.summary ?? "local-ydb tool completed." },
      { type: "text", text: JSON.stringify(result, null, 2) },
    ],
    structuredContent: result,
  };
}

export function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}
