import assert from "node:assert/strict";
import test from "node:test";
import { contiguousPortCandidates } from "./live-port-allocation.mjs";

test("allocates an 18-port block from the inclusive lower boundary", () => {
  assert.deepEqual(
    contiguousPortCandidates(18, () => 0),
    Array.from({ length: 18 }, (_, offset) => 20_000 + offset)
  );
});

test("allocates an 18-port block through the inclusive upper boundary", () => {
  const ports = contiguousPortCandidates(18, () => 1 - Number.EPSILON);

  assert.equal(ports[0], 44_983);
  assert.equal(ports.at(-1), 45_000);
});
