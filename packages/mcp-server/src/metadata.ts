import { readFileSync } from "node:fs";
import { z } from "zod";

const PackageMetadata = z.object({
  version: z.string(),
});

export const localYdbMcpServerVersion = PackageMetadata.parse(
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
).version;
