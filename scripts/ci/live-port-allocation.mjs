const MIN_PORT = 20_000;
const MAX_PORT = 45_000;

export function contiguousPortCandidates(count, random = Math.random) {
  const startCount = MAX_PORT - MIN_PORT - count + 2;
  const first = MIN_PORT + Math.floor(random() * startCount);
  return Array.from({ length: count }, (_, offset) => first + offset);
}
