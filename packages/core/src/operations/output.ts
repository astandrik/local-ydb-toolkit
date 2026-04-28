import { Buffer } from "node:buffer";

export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
export const MAX_OUTPUT_BYTES_LIMIT = 1_048_576;

export interface CappedText {
  text: string;
  bytes: number;
  truncated: boolean;
}

export function normalizeMaxOutputBytes(value: number | undefined): number {
  const maxOutputBytes = value ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("maxOutputBytes must be a positive integer");
  }
  if (maxOutputBytes > MAX_OUTPUT_BYTES_LIMIT) {
    throw new Error(`maxOutputBytes must be ${MAX_OUTPUT_BYTES_LIMIT} or less`);
  }
  return maxOutputBytes;
}

export function capText(input: string, maxBytes: number): CappedText {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes <= maxBytes) {
    return { text: input, bytes, truncated: false };
  }

  let usedBytes = 0;
  const parts: string[] = [];
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    parts.push(char);
    usedBytes += charBytes;
  }

  return { text: parts.join(""), bytes, truncated: true };
}
