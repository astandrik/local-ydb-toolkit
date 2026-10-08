import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/operations/context.js";
import { ConfigSchema } from "../src/validation.js";
import { ProcessConfirmationStore } from "../src/index.js";
import { authorizeMutation } from "../src/confirmation.js";
import { confirmationContentIntent } from "../src/confirmation-inputs.js";
import type { CommandExecutor, CommandSpec } from "../src/api-client.js";

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "local-ydb-foundation-input-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("confirmation fingerprint foundation", () => {
  it("deduplicates profile inputs and sorts explicit roles deterministically", async () => {
    const parent = directory(), auth = join(parent, "auth"), password = join(parent, "password");
    writeFileSync(auth, "BENIGN_AUTH_INPUT");
    writeFileSync(password, "BENIGN_CREDENTIAL_INPUT");
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({
      profiles: { default: { authConfigPath: auth, rootPasswordFile: password } },
    }));
    const fingerprints = await confirmationContentIntent(ctx, [{ kind: "file", path: auth, role: "explicit-auth" }]);
    expect(fingerprints.map(input => input.role)).toEqual(["explicit-auth", "root-password"]);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]?.sha256 === createHash("sha256").update("BENIGN_AUTH_INPUT").digest("hex")).toBe(true);
  });

  it("distinguishes a missing file from a directory without reading either as file contents", async () => {
    const parent = directory(), ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    const fingerprints = await confirmationContentIntent(ctx, [
      { kind: "file", path: join(parent, "missing"), role: "a" },
      { kind: "file", path: parent, role: "b" },
    ]);
    expect(fingerprints.map(input => input.state)).toEqual(["missing", "not-file"]);
    expect(fingerprints.every(input => input.sha256 === undefined)).toBe(true);
  });

  it("rejects a token when configured credential bytes change before confirmation", async () => {
    const path = join(directory(), "credential");
    writeFileSync(path, "BENIGN_OLD_CREDENTIAL");
    const ctx = {
      ...createContext(undefined, undefined, ConfigSchema.parse({ profiles: { default: { rootPasswordFile: path } } })),
      confirmation: { store: new ProcessConfirmationStore(), toolName: "fixture", configSource: { kind: "built-in" } },
    };
    const planned = await authorizeMutation(ctx, {}, { command: "fixture" });
    writeFileSync(path, "BENIGN_NEW_CREDENTIAL");
    const rejected = await authorizeMutation(ctx, { confirm: true, confirmationToken: planned.confirmation?.token }, { command: "fixture" });
    expect(rejected.execute).toBe(false);
    expect(rejected.confirmation?.status).toBe("rejected");
    const serialized = JSON.stringify(rejected.confirmation);
    expect(serialized.includes("BENIGN_NEW_CREDENTIAL")).toBe(false);
    expect(serialized.includes(path)).toBe(false);
  });

  it("hashes actual directory contents with quoted and newline filenames deterministically", async () => {
    const parent = directory(), path = join(parent, "dump");
    mkdirSync(path);
    const firstFile = join(path, "quoted' name");
    writeFileSync(firstFile, "first");
    writeFileSync(join(path, "line\nbreak"), "second");
    const ctx = createContext(undefined, undefined, ConfigSchema.parse({}));
    const inputs = [{ kind: "directory" as const, path, role: "dump" }];
    const first = await confirmationContentIntent(ctx, inputs);
    expect(first[0]?.state).toBe("directory");
    expect(await confirmationContentIntent(ctx, inputs)).toEqual(first);
    writeFileSync(firstFile, "changed");
    expect(await confirmationContentIntent(ctx, inputs)).not.toEqual(first);
  });

  it("uses the target executor for SSH fingerprints and bounds its request", async () => {
    const seen: CommandSpec[] = [];
    const executor: CommandExecutor = {
      display: () => "redacted fingerprint",
      run: async (_profile, spec) => {
        seen.push(spec);
        return { command: "redacted fingerprint", ok: true, exitCode: 0, stdout: "file:" + "A".repeat(64), stderr: "", timedOut: false };
      },
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { mode: "ssh", ssh: { host: "fixture.invalid" }, rootPasswordFile: "/benign/credential" } },
    }));
    const fingerprints = await confirmationContentIntent(ctx);
    expect(fingerprints[0]?.sha256).toBe("a".repeat(64));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(60_000);
    expect(seen[0]?.args?.join(" ")).toContain("16777216");
    expect(seen[0]?.redactions).toContain("/benign/credential");
  });

  it("hides malformed target fingerprint output behind a fixed error", async () => {
    const executor: CommandExecutor = {
      display: () => "redacted fingerprint",
      run: async () => ({ command: "redacted fingerprint", ok: true, exitCode: 0, stdout: "BENIGN_PRIVATE_OUTPUT", stderr: "", timedOut: false }),
    };
    const ctx = createContext(undefined, executor, ConfigSchema.parse({
      profiles: { default: { mode: "ssh", ssh: { host: "fixture.invalid" }, rootPasswordFile: "/benign/credential" } },
    }));
    await expect(confirmationContentIntent(ctx)).rejects.toThrow("Unable to fingerprint a confirmation content input");
  });
});
