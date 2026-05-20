import { formatResponseContent, type ResponseFormatOptions } from "./response-format.js";

export function successResult(
  result: unknown,
  options: ResponseFormatOptions = {},
) {
  const data = result as { summary?: string };
  return {
    content: [
      { type: "text", text: data.summary ?? "local-ydb tool completed." },
      { type: "text", text: formatResponseContent(result, options) },
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
