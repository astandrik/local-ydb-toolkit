import { dirname } from "node:path";

export function pathRedactions(...paths: Array<string | undefined>): string[] {
  const exactPaths = paths.filter((path): path is string => Boolean(path));
  const parentPaths = exactPaths
    .map((path) => dirname(path))
    .filter((parent, index) => parent !== "." && parent !== "/" && parent !== exactPaths[index]);
  return [...exactPaths, ...parentPaths];
}
