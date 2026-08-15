import { describe, expect, it } from "vitest";
import {
  additionalDynamicNodePlans,
  configuredDynamicNodePlans,
  dynamicNodePlan
} from "../src/operations/dynamic-node-topology.js";
import { ConfigSchema, resolveProfile } from "../src/validation.js";

function profile(dynamicNodeCount: number, ports: Record<string, number> = {}) {
  return resolveProfile(ConfigSchema.parse({
    profiles: {
      default: {
        dynamicNodeCount,
        ports
      }
    }
  }));
}

describe("dynamic-node topology", () => {
  it.each([1, 3, 11])("builds a configured %i-node plan", (count) => {
    const plans = configuredDynamicNodePlans(profile(count));

    expect(plans).toHaveLength(count);
    expect(plans[0]).toEqual({
      container: "ydb-dyn-example",
      index: 1,
      grpcPort: 2137,
      monitoringPort: 8766,
      icPort: 19002
    });
    expect(plans.at(-1)).toEqual(dynamicNodePlan(profile(count), count));
  });

  it("derives deterministic suffixes and contiguous ports", () => {
    expect(configuredDynamicNodePlans(profile(3))).toEqual([
      { container: "ydb-dyn-example", index: 1, grpcPort: 2137, monitoringPort: 8766, icPort: 19002 },
      { container: "ydb-dyn-example-2", index: 2, grpcPort: 2138, monitoringPort: 8767, icPort: 19003 },
      { container: "ydb-dyn-example-3", index: 3, grpcPort: 2139, monitoringPort: 8768, icPort: 19004 }
    ]);
  });

  it("starts default one-off plans after the configured count", () => {
    expect(additionalDynamicNodePlans(profile(3), {})).toEqual([
      { container: "ydb-dyn-example-4", index: 4, grpcPort: 2140, monitoringPort: 8769, icPort: 19005 }
    ]);
  });

  it("rejects an explicit one-off range that overlaps configured nodes", () => {
    expect(() => additionalDynamicNodePlans(profile(3), {
      startIndex: 2,
      grpcPortStart: 30_000,
      monitoringPortStart: 30_001,
      icPortStart: 30_002
    })).toThrow(/startIndex.*greater than dynamicNodeCount.*3/);
  });

  it("accepts an explicit one-off range immediately after configured nodes", () => {
    expect(additionalDynamicNodePlans(profile(1), { startIndex: 2 })).toHaveLength(1);
    expect(additionalDynamicNodePlans(profile(3), { startIndex: 4 })).toHaveLength(1);
  });

  it("rejects dynamic port overflow", () => {
    expect(() => configuredDynamicNodePlans(profile(11, { dynamicIc: 65530 }))).toThrow(/65536/);
  });

  it("rejects collisions in the shared network namespace", () => {
    expect(() => configuredDynamicNodePlans(profile(3, {
      dynamicGrpc: 2137,
      dynamicMonitoring: 2137
    }))).toThrow(/shared network namespace/);
  });

  it("rejects collisions with the static node", () => {
    expect(() => configuredDynamicNodePlans(profile(1, {
      staticGrpc: 2137,
      dynamicGrpc: 2137
    }))).toThrow(/static gRPC.*ydb-dyn-example gRPC.*2137/);
  });

  it("reserves the static node IC port in the shared network namespace", () => {
    expect(() => configuredDynamicNodePlans(profile(2, {
      dynamicIc: 19000
    }))).toThrow(/static IC.*ydb-dyn-example-2 IC.*19001/);
  });

  it("accepts a dynamic IC range adjacent to the static IC port", () => {
    expect(configuredDynamicNodePlans(profile(1, { dynamicIc: 19000 }))).toHaveLength(1);
  });

  it.each([
    { staticContainer: "ydb-dyn-example", dynamicNodeCount: 1 },
    { staticContainer: "ydb-dyn-example-2", dynamicNodeCount: 2 }
  ])("rejects a configured container name that aliases $staticContainer", ({ staticContainer, dynamicNodeCount }) => {
    const resolved = resolveProfile(ConfigSchema.parse({
      profiles: {
        default: {
          dynamicContainer: "ydb-dyn-example",
          dynamicNodeCount,
          staticContainer
        }
      }
    }));

    expect(() => configuredDynamicNodePlans(resolved)).toThrow(/static container.*configured dynamic node|configured dynamic node.*static container/i);
  });
});
