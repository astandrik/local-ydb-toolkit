import { chmod, cp, mkdir, rm } from "node:fs/promises";
import {
  helperAssetDirectory,
  helperDistDirectory,
} from "./config.mjs";

await rm(helperDistDirectory, { recursive: true, force: true });
await mkdir(helperDistDirectory, { recursive: true });
await cp(helperAssetDirectory, helperDistDirectory, { recursive: true });
await chmod(`${helperDistDirectory}/cleanup-helper`, 0o755);
