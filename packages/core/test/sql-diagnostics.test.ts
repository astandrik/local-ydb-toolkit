import { describe, expect, it, vi } from "vitest";
import type { QueryServiceExecutionResult } from "../src/query-service.js";

const authMocks = vi.hoisted(() => ({
  redactText: vi.fn((value: string) => value),
}));

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    redactText: authMocks.redactText,
  };
});

describe("managed SQL diagnostic normalization", () => {
  it("rejects multi-megabyte diagnostics before invoking the redactor", async () => {
    // Production break caught: split/join redaction can allocate from an
    // unbounded backend diagnostic before the 4 KiB output check runs.
    const repeatedPath = "/private/root.password";
    const diagnostics = repeatedPath.repeat(
      Math.ceil((2 * 1_048_576) / repeatedPath.length),
    );
    const result: QueryServiceExecutionResult = {
      completion: "success",
      resultSets: [],
      capturedBytes: 0,
      truncationReasons: [],
      diagnostics,
    };
    const { normalizeSqlBackendResult } = await import(
      "../src/operations/sql-result.js"
    );

    expect(normalizeSqlBackendResult(result, {
      captureBudget: 1,
      maxRows: 1,
      diagnosticRedactions: [repeatedPath],
    })).toBeUndefined();
    expect(authMocks.redactText).not.toHaveBeenCalled();
  });
});
