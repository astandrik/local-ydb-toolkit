import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, loadConfig, loadConfigDocument } from "../src/validation.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "local-ydb-foundation-config-"));
  directories.push(path);
  return path;
}

beforeEach(() => { vi.stubEnv("LOCAL_YDB_TOOLKIT_CONFIG", undefined); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("config document provenance foundation", () => {
  it("keeps loadConfig compatible while recording explicit source bytes internally", () => {
    const path = join(directory(), "config.json");
    const text = '{ "profiles": { "default": { "tenantPath": "/local/foundation" } } }\n';
    writeFileSync(path, text);
    const loaded = loadConfigDocument(path);
    expect(loaded.config).toEqual(loadConfig(path));
    expect(loadConfig(path)).not.toHaveProperty("source");
    expect(loaded.source).toEqual({
      kind: "argument", path, contentSha256: createHash("sha256").update(text).digest("hex"),
    });
  });

  it("preserves argument precedence over the environment", () => {
    const parent = directory(), argumentPath = join(parent, "argument.json"), environmentPath = join(parent, "environment.json");
    writeFileSync(argumentPath, "{}");
    writeFileSync(environmentPath, "{}\n");
    vi.stubEnv("LOCAL_YDB_TOOLKIT_CONFIG", environmentPath);
    expect(loadConfigDocument(argumentPath).source).toMatchObject({ kind: "argument", path: argumentPath });
    expect(loadConfigDocument().source).toMatchObject({ kind: "environment", path: environmentPath });
  });

  it("distinguishes present implicit config from missing built-in fallback", () => {
    const parent = directory();
    vi.spyOn(process, "cwd").mockReturnValue(parent);
    expect(loadConfigDocument()).toEqual({ config: ConfigSchema.parse({}), source: { kind: "built-in" } });
    const path = join(parent, "local-ydb.config.json");
    writeFileSync(path, "{}");
    expect(loadConfigDocument().source).toMatchObject({ kind: "implicit", path });
  });

  it("binds file representation as well as the parsed profile", () => {
    const path = join(directory(), "config.json");
    writeFileSync(path, "{}");
    const first = loadConfigDocument(path);
    writeFileSync(path, "{ }\n");
    const second = loadConfigDocument(path);
    expect(second.config).toEqual(first.config);
    expect(second.source).not.toEqual(first.source);
  });

  it("keeps malformed-file errors non-disclosing", () => {
    const path = join(directory(), "private-marker-config.json");
    writeFileSync(path, "BENIGN_INVALID_CONFIG_MARKER");
    let error: unknown;
    try { loadConfigDocument(path); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "CONFIG_INVALID_JSON" });
    expect(String(error)).not.toContain(path);
    expect(String(error)).not.toContain("BENIGN_INVALID_CONFIG_MARKER");
    expect(error).not.toHaveProperty("cause");
  });
});
