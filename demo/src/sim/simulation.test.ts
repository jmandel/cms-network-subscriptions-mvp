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
  expect(webhookPayload).not.toContain("activity-handle");
  expect(webhookPayload).not.toContain("Parameters");
  const eventsResponse = sim.state.trace.find(
    (event) => event.response?.status === 200 && event.request?.path.endsWith("/$events"),
  );
  const eventsPayload = JSON.stringify(eventsResponse?.response?.body);
  expect(eventsPayload).toContain("activity-handle");
  expect(eventsPayload).toContain("follow-up-discovery");
  expect(webhookPayload).not.toContain("client-action");
  expect(webhookPayload).not.toContain("suggested-action");
  expect(webhookPayload).not.toContain("detail-level");
  expect(webhookPayload).not.toContain("resource-type");
  expect(eventsPayload).not.toContain("resource-type");
  expect(eventsPayload).not.toContain("follow-up-search");
  expect(eventsPayload).not.toContain("follow-up-read");
  expect(eventsPayload).not.toContain("follow-up-subscribe");
  expect(webhookPayload).not.toContain("mercy");
  expect(webhookPayload).not.toContain("Mercy Hospital Phoenix");
  expect(webhookPayload).not.toContain("2234567890");
  expect(sim.state.app.knownSources.mercy?.discoveredBy).toBe("RLS");
  expect(sim.state.trace.some((event) => event.summary === "Run network discovery/RLS")).toBe(true);
});

test("read-hinted scenario reads the hinted data-holder resource", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("read-hinted");
  const eventsResponse = sim.state.trace.find(
    (event) => event.response?.status === 200 && event.request?.path.endsWith("/$events"),
  );
  expect(JSON.stringify(eventsResponse?.response?.body)).toContain("follow-up-read");
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
  const eventsResponse = sim.state.trace.find(
    (event) => event.response?.status === 200 && event.request?.path.endsWith("/$events"),
  );
  const eventsPayload = JSON.stringify(eventsResponse?.response?.body);
  expect(eventsPayload).toContain("follow-up-search");
  expect(eventsPayload).toContain("https://valley-clinic.example.org/fhir/Encounter?patient={{patient}}");
  expect(eventsPayload).not.toContain("{{activity-handle}}");

  const query = sim.state.trace.find(
    (event) => event.request?.method === "GET" && event.request.path === "/data-holders/valley/fhir/Encounter",
  );
  expect(query?.request?.query.patient).toBe("data-holder-patient-valley");
  expect(query?.request?.query._lastUpdated).toBe("ge2026-04-29T15:00:00Z");
  expect(query?.request?.query["activity-handle"]).toBeUndefined();
});

test("missed webhook triggers retained event range retrieval", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("missed-activity");
  expect(sim.state.trace.some((event) => event.summary.includes("Dropped webhook"))).toBe(true);
  expect(sim.state.trace.some((event) => event.summary.includes("Detected network event gap"))).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Retrieve missed activity event range")).toBe(true);
});

test("partial retained event ranges fail instead of silently advancing", () => {
  const sim = new NetworkActivitySimulation();
  sim.bootstrap();
  sim.setDisclosurePolicy("opaque");
  sim.state.network.dropNextWebhook = true;
  sim.injectNetworkEvent("valley", "activity-detected", "probable");
  delete sim.state.network.events[1];
  sim.injectNetworkEvent("mercy", "activity-detected", "probable");

  const rangeResponse = sim.state.trace.find(
    (event) =>
      event.response?.status === 410 &&
      event.request?.path.endsWith("/$events") &&
      event.request.query.eventsSinceNumber === "1",
  );
  expect(rangeResponse?.response?.status).toBe(410);
  expect(sim.state.app.lastNetworkEventNumber).toBe(0);
});

test("sensitive data-holder stays withheld after opaque signal", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("sensitive-data-holder");
  const rlsResponse = sim.state.trace.find(
    (event) => event.request?.path === "/network/rls/search" && event.response?.status === 200,
  );
  expect(JSON.stringify(rlsResponse?.response?.body)).not.toContain("Northside Behavioral Health");
  expect((rlsResponse?.response?.body as any)?.withheld).toBe(1);
  expect(sim.state.app.knownSources.northside).toBeUndefined();
});

test("data-holder routes enforce source authorization", () => {
  const sim = new NetworkActivitySimulation();
  const send = (sim as any).kernel.send;

  const search = send({
    from: "client",
    to: "data-holder",
    method: "GET",
    path: "/data-holders/valley/fhir/Encounter?patient=data-holder-patient-valley",
    summary: "Unauthorized search",
  });
  const read = send({
    from: "client",
    to: "data-holder",
    method: "GET",
    path: "/data-holders/valley/fhir/Encounter/enc-valley-1",
    summary: "Unauthorized read",
  });
  const subscription = send({
    from: "client",
    to: "data-holder",
    method: "POST",
    path: "/data-holders/valley/fhir/Subscription",
    body: {},
    summary: "Unauthorized subscription",
  });

  expect(search.status).toBe(401);
  expect(read.status).toBe(401);
  expect(subscription.status).toBe(401);
});

test("network subscription read returns the requested id", () => {
  const sim = new NetworkActivitySimulation();
  sim.bootstrap();
  const response = (sim as any).kernel.send({
    from: "client",
    to: "network",
    method: "GET",
    path: "/network/fhir/Subscription/network-sub-1",
    summary: "Read network subscription",
  });
  expect(response.body.id).toBe("network-sub-1");
});
