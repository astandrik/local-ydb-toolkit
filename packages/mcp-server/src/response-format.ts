import { decode, encode } from "@toon-format/toon";

export type ResponseContentFormat = "json" | "toon";

export interface ResponseFormatOptions {
  responseContentFormat?: ResponseContentFormat;
}

export function formatResponseContent(
  result: unknown,
  options: ResponseFormatOptions = {},
): string {
  const format = resolveResponseContentFormat(options.responseContentFormat);
  const jsonModel = toJsonDataModel(result);
  if (format === "json") {
    return JSON.stringify(jsonModel, null, 2);
  }
  const toon = encode(jsonModel);
  return decodesToJsonModel(toon, jsonModel)
    ? toon
    : JSON.stringify(jsonModel, null, 2);
}

function toJsonDataModel(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  return serialized === undefined ? null : JSON.parse(serialized);
}

function decodesToJsonModel(toon: string, jsonModel: unknown): boolean {
  try {
    return stableJson(decode(toon)) === stableJson(jsonModel);
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function resolveResponseContentFormat(
  format = process.env.LOCAL_YDB_MCP_CONTENT_FORMAT,
): ResponseContentFormat {
  return normalizeResponseContentFormat(format);
}

export function normalizeResponseContentFormat(
  format: string | undefined,
): ResponseContentFormat {
  if (!format) {
    return "json";
  }
  if (format === "json" || format === "toon") {
    return format;
  }
  throw new Error(
    `Invalid LOCAL_YDB_MCP_CONTENT_FORMAT: expected "json" or "toon", got ${JSON.stringify(format)}.`,
  );
}
