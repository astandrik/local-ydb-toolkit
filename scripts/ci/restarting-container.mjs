import { setTimeout as delay } from "node:timers/promises";

const MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 500;

export async function waitForRestartingContainer({ readInventory, container, sleep = delay }) {
  let lastContainer;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const inventory = await readInventory();
    if (inventory?.ok !== true) {
      throw new Error(`Inventory failed while waiting for container ${container} to restart.`);
    }
    const observedContainer = Array.isArray(inventory.containers)
      ? inventory.containers.find((item) => item.names === container)
      : undefined;
    if (!observedContainer?.id) {
      throw new Error(`Container ${container} or its ID is missing from inventory.`);
    }
    lastContainer = observedContainer;
    if (observedContainer.state === "restarting") {
      return observedContainer;
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(POLL_INTERVAL_MS);
    }
  }
  const { id, state, status } = lastContainer;
  throw new Error(
    `Container ${container} did not enter restarting state after ${MAX_ATTEMPTS} inventory attempts. `
      + `Last observation: ${JSON.stringify({ id, state, status })}`,
  );
}
