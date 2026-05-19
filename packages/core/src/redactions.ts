import { dirname } from "node:path";

export function pathRedactions(...paths: Array<string | undefined>): string[] {
  const exactPaths = paths.filter((path): path is string => Boolean(path));
  const parentPaths = exactPaths
    .map((path) => dirname(path))
    .filter((parent, index) => parent !== exactPaths[index] && isSpecificParentDirectory(parent));
  return [...exactPaths, ...parentPaths];
}

function isSpecificParentDirectory(parent: string): boolean {
  const normalized = stripTrailingSlashes(parent);
  if ([".", "/", "/tmp", "/var/tmp", "/home", "/Users"].includes(normalized)) {
    return false;
  }
  const parts = normalized.split("/").filter(Boolean);
  return !((parts[0] === "home" || parts[0] === "Users") && parts.length <= 2);
}

function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === 0 ? "/" : path.slice(0, end);
}
