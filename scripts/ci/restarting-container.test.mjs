import assert from "node:assert/strict";
import test from "node:test";
import { waitForRestartingContainer } from "./restarting-container.mjs";

const container = "fixture-dynamic-2";
const running = { names: container, id: "fixture-id", state: "running", status: "Up 1 second" };
const restarting = { ...running, state: "restarting", status: "Restarting (1)" };

function inventory(node) {
  return { ok: true, containers: [node] };
}

function fixture(responses) {
  let calls = 0;
  const delays = [];
  return {
    get calls() { return calls; },
    delays,
    wait: () => waitForRestartingContainer({
      container,
      readInventory: async () => {
        const response = responses[Math.min(calls, responses.length - 1)];
        calls += 1;
        if (response instanceof Error) {
          throw response;
        }
        return response;
      },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    }),
  };
}

test("waits through running and returns the restarting inventory snapshot", async () => {
  const probe = fixture([inventory(running), inventory(restarting), inventory(running)]);

  assert.equal(await probe.wait(), restarting);
  assert.equal(probe.calls, 2);
  assert.deepEqual(probe.delays, [500]);
});

test("returns the first restarting observation without another read or delay", async () => {
  const probe = fixture([inventory(restarting), inventory(running)]);

  assert.equal(await probe.wait(), restarting);
  assert.equal(probe.calls, 1);
  assert.deepEqual(probe.delays, []);
});

test("accepts restarting on the twentieth inventory attempt", async () => {
  const probe = fixture([
    ...Array.from({ length: 19 }, () => inventory(running)),
    inventory(restarting),
  ]);

  assert.equal(await probe.wait(), restarting);
  assert.equal(probe.calls, 20);
  assert.deepEqual(probe.delays, Array(19).fill(500));
});

test("reports only the last container observation after bounded polling", async () => {
  const latest = { ...running, status: "Up 2 seconds", privateField: "must-not-appear" };
  const response = { ...inventory(latest), inspect: "must-not-appear", profile: "must-not-appear" };
  const probe = fixture([inventory(running), response]);

  await assert.rejects(probe.wait(), (error) => {
    assert.equal(
      error.message,
      `Container ${container} did not enter restarting state after 20 inventory attempts. `
        + `Last observation: ${JSON.stringify({ id: latest.id, state: latest.state, status: latest.status })}`,
    );
    assert.doesNotMatch(error.message, /must-not-appear/);
    return true;
  });
  assert.equal(probe.calls, 20);
  assert.deepEqual(probe.delays, Array(19).fill(500));
});

test("propagates an MCP failure without retrying", async () => {
  const failure = new Error("MCP inventory request failed");
  const probe = fixture([failure, inventory(restarting)]);

  await assert.rejects(probe.wait(), (error) => error === failure);
  assert.equal(probe.calls, 1);
  assert.deepEqual(probe.delays, []);
});

for (const [description, response, message] of [
  ["failed inventory", { ok: false, summary: "must-not-appear" }, /Inventory failed/],
  ["missing success flag", { containers: [restarting] }, /Inventory failed/],
  ["missing container", { ok: true, containers: [{ ...restarting, names: "another-container" }] }, /or its ID is missing/],
  ["missing container list", { ok: true }, /or its ID is missing/],
  ["missing ID", inventory({ names: container, state: "restarting" }), /or its ID is missing/],
  ["empty ID", inventory({ ...restarting, id: "" }), /or its ID is missing/],
]) {
  test(`rejects ${description} without retrying`, async () => {
    const probe = fixture([response, inventory(restarting)]);

    await assert.rejects(probe.wait(), (error) => {
      assert.match(error.message, message);
      assert.ok(error.message.includes(container));
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    });
    assert.equal(probe.calls, 1);
    assert.deepEqual(probe.delays, []);
  });
}
