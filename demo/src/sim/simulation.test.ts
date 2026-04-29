import { expect, test } from "bun:test";
import { NetworkActivitySimulation } from "./simulation";

test("bootstrap creates a network subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.bootstrap();
  expect(sim.state.app.networkSubscriptionId).toBe("network-sub-1");
  expect(sim.state.trace.some((event) => event.summary.includes("Create network activity subscription"))).toBe(true);
});

test("feed-hinted scenario creates source feed subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("feed-hinted");
  expect(sim.state.app.feedSubscriptions.valley?.status).toBe("active");
  expect(sim.state.app.sourceTokens.valley?.patient).toBe("source-patient-valley");
});

test("opaque scenario uses an activity handle to narrow RLS", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("opaque-rls");
  expect(Object.keys(sim.state.network.handles)).toHaveLength(1);
  expect(sim.state.app.knownSources.mercy?.discoveredBy).toBe("RLS");
  expect(sim.state.trace.some((event) => event.summary === "Run RLS discovery")).toBe(true);
});

test("missed webhook produces a recovery discovery", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("missed-activity");
  expect(sim.state.trace.some((event) => event.summary.includes("Dropped webhook"))).toBe(true);
  expect(sim.state.trace.some((event) => event.summary.includes("Detected network event gap"))).toBe(true);
});
