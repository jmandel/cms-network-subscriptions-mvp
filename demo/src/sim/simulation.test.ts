import { expect, test } from "bun:test";
import { NetworkActivitySimulation } from "./simulation";

test("bootstrap creates a network subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.bootstrap();
  expect(sim.state.app.networkSubscriptionId).toBe("network-sub-1");
  expect(sim.state.trace.some((event) => event.summary.includes("Create network activity subscription"))).toBe(true);
});

test("subscription-hinted scenario creates Patient Data Feed subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("subscription-hinted");
  expect(sim.state.app.feedSubscriptions.valley?.status).toBe("active");
  expect(sim.state.app.sourceTokens.valley?.patient).toBe("data-holder-patient-valley");
});

test("opaque scenario uses an activity handle to narrow RLS", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("opaque-rls");
  expect(Object.keys(sim.state.network.handles)).toHaveLength(1);
  const handle = Object.keys(sim.state.network.handles)[0];
  expect(handle).toMatch(/^ah-[0-9a-z]+$/);
  expect(handle).not.toContain("mercy");

  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  const webhookPayload = JSON.stringify(webhook?.request?.body);
  expect(webhookPayload).toContain("activity-handle");
  expect(webhookPayload).not.toContain("client-action");
  expect(webhookPayload).not.toContain("suggested-action");
  expect(webhookPayload).not.toContain("detail-level");
  expect(webhookPayload).not.toContain("resource-type");
  expect(webhookPayload).not.toContain("follow-up-search");
  expect(webhookPayload).not.toContain("follow-up-read");
  expect(webhookPayload).not.toContain("follow-up-subscribe");
  expect(webhookPayload).not.toContain("mercy");
  expect(webhookPayload).not.toContain("Mercy Hospital Phoenix");
  expect(webhookPayload).not.toContain("2234567890");
  expect(sim.state.app.knownSources.mercy?.discoveredBy).toBe("RLS");
  expect(sim.state.trace.some((event) => event.summary === "Run RLS discovery")).toBe(true);
});

test("read-hinted scenario reads the hinted data-holder resource", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("read-hinted");
  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  expect(JSON.stringify(webhook?.request?.body)).toContain("follow-up-read");
  expect(
    sim.state.trace.some(
      (event) => event.request?.method === "GET" && event.request.path === "/data-holders/mercy/fhir/Encounter/enc-mercy-1",
    ),
  ).toBe(true);
  expect(sim.state.app.knownSources.mercy?.discoveredBy).toBe("follow-up-read");
});

test("search scenario runs the explicit follow-up search template", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("known-data-holder");
  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  const webhookPayload = JSON.stringify(webhook?.request?.body);
  expect(webhookPayload).toContain("follow-up-search");
  expect(webhookPayload).toContain("https://valley-clinic.example.org/fhir/Encounter?patient={{patient}}");

  const query = sim.state.trace.find(
    (event) => event.request?.method === "GET" && event.request.path === "/data-holders/valley/fhir/Encounter",
  );
  expect(query?.request?.query.patient).toBe("data-holder-patient-valley");
  expect(query?.request?.query._lastUpdated).toBe("ge2026-04-29T15:00:00Z");
});

test("missed webhook produces a recovery discovery", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("missed-activity");
  expect(sim.state.trace.some((event) => event.summary.includes("Dropped webhook"))).toBe(true);
  expect(sim.state.trace.some((event) => event.summary.includes("Detected network event gap"))).toBe(true);
});
