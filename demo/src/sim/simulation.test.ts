import { expect, test } from "bun:test";
import { NetworkActivitySimulation } from "./simulation";

test("bootstrap creates a network subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.bootstrap();
  expect(sim.state.app.networkSubscriptionId).toBe("network-sub-1");
  expect(sim.state.trace.some((event) => event.summary.includes("Create network activity subscription"))).toBe(true);
  const tokenRequest = sim.state.trace.find((event) => event.summary === "Authorize at network")?.request;
  expect(tokenRequest?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect((tokenRequest?.body as any)?.grant_type).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
  expect((tokenRequest?.body as any)?.subject_token_type).toBe("https://smarthealthit.org/token-type/permission-ticket");
  expect(JSON.stringify((tokenRequest?.body as any)?._demo_decoded_permission_ticket)).toContain("ial2-verified-subject-123");
});

test("endpoint-hinted scenario discovers capabilities and creates Patient Data Feed subscription", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("endpoint-hinted");
  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  const bundle = webhook?.request?.body as any;
  expect(bundle.type).toBe("history");
  expect(bundle.entry?.[0]?.fullUrl).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(bundle.entry?.[1]?.fullUrl).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(bundle.entry?.[0]?.resource?.notificationEvent?.[0]?.focus?.reference).toBe(bundle.entry?.[1]?.fullUrl);
  expect(bundle.entry?.[0]?.request?.url).toBe("Subscription/network-sub-1/$status");
  expect(JSON.stringify(bundle)).not.toContain("follow-up-discovery");
  expect(
    sim.state.trace.some(
      (event) => event.request?.method === "GET" && event.request.path === "/data-holders/valley/fhir/metadata",
    ),
  ).toBe(true);
  const dataHolderTokenRequest = sim.state.trace.find((event) => event.summary === "Authorize at Valley Clinic")?.request;
  expect((dataHolderTokenRequest?.body as any)?.subject_token_type).toBe("https://smarthealthit.org/token-type/permission-ticket");
  expect(JSON.stringify((dataHolderTokenRequest?.body as any)?._demo_decoded_permission_ticket)).toContain("Valley Clinic");
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
  expect(webhookPayload).toContain("Parameters");
  expect(webhookPayload).toContain("activity-handle");
  expect(webhookPayload).toContain("valueCoding");
  expect(webhookPayload).not.toContain("follow-up-discovery");
  expect(webhookPayload).not.toContain("client-action");
  expect(webhookPayload).not.toContain("suggested-action");
  expect(webhookPayload).not.toContain("detail-level");
  expect(webhookPayload).not.toContain("resource-type");
  expect(webhookPayload).not.toContain("follow-up-search");
  expect(webhookPayload).not.toContain("follow-up-read");
  expect(webhookPayload).not.toContain("mercy");
  expect(webhookPayload).not.toContain("Mercy Hospital Phoenix");
  expect(webhookPayload).not.toContain("2234567890");
  expect(sim.state.app.knownSources.mercy?.discoveredBy).toBe("RLS");
  expect(sim.state.trace.some((event) => event.summary === "Run network discovery/RLS")).toBe(true);
  const discovery = sim.state.trace.find(
    (event) => event.request?.path === "/network/fhir/$data-holder-discovery" && event.response?.status === 200,
  );
  expect(discovery?.response?.headers["content-type"]).toBe("application/fhir+json");
  expect(discovery?.request?.body).toMatchObject({
    resourceType: "Parameters",
    parameter: expect.arrayContaining([{ name: "activity-handle", valueString: handle }]),
  });
  expect(dataHolderNames(discovery?.response?.body)).toEqual(["Mercy Hospital Phoenix"]);
  expect((discovery?.response?.body as any)?.total).toBe(1);
  expect(extensionValue(discovery?.response?.body, "demo-handle-used")).toBe(true);
});

test("activity-tags scenario uses ordinary data-holder follow-up", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("activity-tags");
  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  const webhookPayload = JSON.stringify(webhook?.request?.body);
  expect(webhookPayload).toContain("diagnostic-related");
  expect(webhookPayload).not.toContain("follow-up-read");
  expect(
    sim.state.trace.some(
      (event) => event.request?.method === "GET" && event.request.path === "/data-holders/mercy/fhir/metadata",
    ),
  ).toBe(true);
  expect(sim.state.app.feedSubscriptions.mercy?.status).toBe("active");
});

test("known data-holder scenario runs ordinary source query without RLS", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("known-data-holder");
  const webhook = sim.state.trace.find(
    (event) => event.kind === "webhook" && event.request?.path === "/app/network-activity",
  );
  const webhookPayload = JSON.stringify(webhook?.request?.body);
  expect(webhookPayload).toContain("data-holder-activity-detected");
  expect(webhookPayload).toContain("visit-related");
  expect(webhookPayload).not.toContain("follow-up-search");
  expect(webhookPayload).not.toContain("follow-up-discovery");
  expect(sim.state.trace.some((event) => event.summary === "Run network discovery/RLS")).toBe(false);

  const query = sim.state.trace.find(
    (event) => event.request?.method === "GET" && event.request.path === "/data-holders/valley/fhir/Encounter",
  );
  expect(query?.request?.query.patient).toBe("data-holder-patient-valley");
  expect(query?.request?.query._lastUpdated).toBe("ge2026-04-29T15:00:00Z");
  expect(query?.request?.query["activity-handle"]).toBeUndefined();
  expect(sim.state.app.knownSources.valley?.discoveredBy).toBe("data-holder-query");
});

test("patient-data-feed scenario shows heartbeat between spaced actions", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("patient-data-feed");
  expect(sim.state.trace.some((event) => event.summary === "Five minutes later" && event.at === "2026-04-30T14:05:00.000Z")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Deliver network heartbeat")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Received network heartbeat")).toBe(true);
  expect(sim.state.app.lastNetworkHeartbeatAt).toBe("2026-04-30T14:05:00.000Z");
  expect(sim.state.app.nextNetworkHeartbeatDueAt).toBe("2026-04-30T14:11:00.000Z");
  expect(
    sim.state.trace.some(
      (event) =>
        event.summary === "Deliver Valley Clinic Encounter notification" &&
        event.at === "2026-04-30T14:22:00.000Z",
    ),
  ).toBe(true);
});

test("missed heartbeat triggers discovery and connected data-holder recovery", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("missed-activity");
  expect(sim.state.trace.some((event) => event.summary === "Deliver network heartbeat")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Received network heartbeat")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Dropped network heartbeat")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Missed network heartbeat; run recovery discovery")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary.includes("Detected network event gap"))).toBe(false);
  expect(sim.state.trace.some((event) => event.summary === "Retrieve missed activity event range")).toBe(false);
  expect(sim.state.trace.some((event) => event.request?.path.endsWith("/$events"))).toBe(false);
  const discovery = sim.state.trace.find(
    (event) => event.request?.path === "/network/fhir/$data-holder-discovery" && event.response?.status === 200,
  );
  expect(dataHolderNames(discovery?.response?.body).sort()).toEqual(["Mercy Hospital Phoenix", "Valley Clinic"]);
  expect((discovery?.response?.body as any)?.total).toBe(2);
  expect(extensionValue(discovery?.response?.body, "demo-handle-used")).toBe(false);
  expect(sim.state.trace.some((event) => event.summary === "Recovery query at Valley Clinic")).toBe(true);
  expect(sim.state.trace.some((event) => event.summary === "Recovery query at Mercy Hospital Phoenix")).toBe(true);
  expect(sim.state.app.lastNetworkEventNumber).toBe(0);
  expect(sim.state.app.lastNetworkHeartbeatAt).toBe("2026-04-30T14:05:00.000Z");
  expect(sim.state.app.nextNetworkHeartbeatDueAt).toBe("2026-04-30T14:22:00.000Z");
});

test("sensitive data-holder stays withheld after opaque signal", () => {
  const sim = new NetworkActivitySimulation();
  sim.runScenario("sensitive-data-holder");
  const rlsResponse = sim.state.trace.find(
    (event) => event.request?.path === "/network/fhir/$data-holder-discovery" && event.response?.status === 200,
  );
  expect(JSON.stringify(rlsResponse?.response?.body)).not.toContain("Northside Behavioral Health");
  expect(extensionValue(rlsResponse?.response?.body, "demo-withheld-count")).toBe(1);
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

function dataHolderNames(body: unknown) {
  return (
    (body as any)?.entry
      ?.map((entry: any) => entry.resource)
      .filter((resource: any) => resource?.resourceType === "Organization")
      .map((resource: any) => resource.name) ?? []
  );
}

function extensionValue(body: unknown, suffix: string) {
  const extension = (body as any)?.extension?.find?.((item: any) => String(item.url ?? "").endsWith(suffix));
  return extension?.valueInteger ?? extension?.valueBoolean ?? extension?.valueString;
}
