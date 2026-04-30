# Browser Reference Implementation Plan

## Goal

Build a browser-based simulation dashboard that lets users explore Network Activity Notifications end to end.

The app should let a user trigger high-level events, watch the app receive activity notifications, inspect the disclosed hints, and see the internal HTTP-like traffic the app performs next. No real HTTP requests are sent. All requests are routed through an in-memory simulation framework that preserves HTTP semantics: method, path, query parameters, headers, body, status, and response body.

## Non-Goals

- No production authorization server.
- No real patient matching.
- No real network calls.
- No complete FHIR server.
- No attempt to solve consent or patient preference infrastructure.

## Stack

- Bun for scripts, tests, and local development.
- Vite + React + TypeScript for the browser app.
- A small in-memory simulation kernel, not `fetch` mocking.
- Optional Playwright smoke tests once the UI exists.

The app should run with:

```sh
bun install
bun run dev
```

## Dashboard Shape

The first screen should be the simulation workspace, not a landing page.

Primary regions:

| Region | Purpose |
|--------|---------|
| Scenario controls | Choose patient, network policy, source capabilities, and trigger high-level events. |
| Actor map | Show Client App, Network Activity Endpoint, RLS/Network Query Service, and Data-Holder FHIR Endpoint. |
| Traffic log | Chronological HTTP-like requests, webhook deliveries, responses, and internal events. |
| Message inspector | Pretty and raw views for selected FHIR bundles, Parameters, requests, and responses. |
| App state | Known sources, source subscriptions, token contexts, last event number, and pending follow-up work. |
| Network state | Watched patients, retained activity handles, source registry, disclosure policy, and event counters. |

The UI should be quiet and dense: tables, segmented controls, tabs, and inspectors. Avoid marketing copy. The user should learn by running flows and inspecting messages.

## Simulation Kernel

The kernel should be framework-independent TypeScript under `demo/src/sim`.

Core types:

```ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SimRequest {
  id: string;
  from: ActorId;
  to: ActorId;
  method: HttpMethod;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body?: unknown;
  correlationId?: string;
}

export interface SimResponse {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RouteHandler {
  actor: ActorId;
  method: HttpMethod;
  pathPattern: string;
  handle(request: SimRequest, context: SimContext): SimResponse | Promise<SimResponse>;
}

export interface TraceEvent {
  id: string;
  at: string;
  kind: "request" | "response" | "webhook" | "state-change" | "decision" | "error";
  actor?: ActorId;
  request?: SimRequest;
  response?: SimResponse;
  summary: string;
  details?: unknown;
}
```

Routing rules:

- `send(request)` records the request, invokes the matching route handler, records the response, and returns it.
- Webhook delivery is just an internal `POST` from the Network Activity Endpoint to the Client App's registered endpoint.
- Query strings are parsed into `request.query`.
- Headers are case-insensitive for matching and displayed with original casing where possible.
- Every request and response gets a correlation id so the UI can group a flow.

## Actors

### Client App

Responsibilities:

- Authorize at the network.
- Create the `network-activity` subscription.
- Receive webhook notifications.
- Decode the `Parameters` focus resource into the logical TypeScript model.
- Follow the most specific usable hint: `target-url`, then explicit `source-query`, then Patient Data Feed subscription, then RLS/discovery.
- Track known sources and Patient Data Feed subscriptions.
- Detect duplicate activity ids and event-number gaps.

Routes:

| Route | Meaning |
|-------|---------|
| `POST /app/network-activity` | Receive network activity webhook. |
| `POST /app/patient-data-feed/:sourceId` | Receive Patient Data Feed webhook from a data-holder FHIR endpoint. |

### Network Activity Endpoint

Responsibilities:

- Issue mock network tokens with network-scoped patient context.
- Accept `Subscription` creates for the `network-activity` topic.
- Convert high-level simulated events into activity notification bundles.
- Apply disclosure policy: opaque, source-hinted, query-hinted, resource-hinted, or subscription-hinted.
- Emit explicit follow-up hints such as `source-query`, `target-url`, and `feed-topic` when disclosure policy permits.
- Mint and retain opaque activity handles.

Routes:

| Route | Meaning |
|-------|---------|
| `POST /network/token` | Mock token response with `patient`. |
| `POST /network/fhir/Subscription` | Create network activity subscription. |
| `GET /network/fhir/Subscription/:id` | Read subscription status. |
| `POST /network/internal/events` | Simulation-only event injection. |
| `POST /network/fhir/$resolve-activity` | Optional network query using `activity-handle`. |

### RLS / Network Query Service

Responsibilities:

- Return broad or narrowed source discovery results.
- Demonstrate fan-out reduction when an `activity-handle` is supplied.
- Return empty results when the signal is possible but no source is currently disclosed.

Routes:

| Route | Meaning |
|-------|---------|
| `POST /network/rls/search` | Existing-style discovery query. |
| `POST /network/fhir/$resolve-activity` | FHIR-shaped narrowed resolution. |

### Data-Holder FHIR Endpoint

Responsibilities:

- Issue mock source tokens with source-scoped patient context.
- Respond to explicit source query templates for `Encounter` and `Appointment`.
- Accept Patient Data Feed subscriptions when the endpoint supports the topic.
- Deliver id-only notifications for active Patient Data Feed subscriptions.
- Enforce source authorization independently of network notifications.

Routes:

| Route | Meaning |
|-------|---------|
| `POST /sources/:sourceId/token` | Mock source token response. |
| `GET /sources/:sourceId/fhir/Encounter?patient={patient}&_lastUpdated=ge...` | Query Encounters using the explicit hinted search URL. |
| `GET /sources/:sourceId/fhir/Encounter/:id` | Read one Encounter by id. |
| `GET /sources/:sourceId/fhir/Appointment` | Query Appointments by patient and `_lastUpdated`. |
| `GET /sources/:sourceId/fhir/Appointment/:id` | Read one Appointment by id. |
| `POST /sources/:sourceId/fhir/Subscription` | Create Patient Data Feed subscription. |
| `GET /sources/:sourceId/fhir/Subscription/:id` | Read Patient Data Feed subscription. |
| `POST /sources/:sourceId/internal/events` | Simulation-only source event injection. |

## Scenarios

Each scenario should be a deterministic script that can be stepped through or run automatically.

### 1. Bootstrap

Shows the client authorizing at the network and creating a `network-activity` subscription.

Traffic:

1. `POST /network/token`
2. `POST /network/fhir/Subscription`
3. Subscription status update in app state

### 2. Opaque Activity, Narrowed RLS

The network sees an event but does not disclose the source. It sends an opaque activity notification with a handle. The client calls RLS with the handle. The network returns one source instead of a broad fan-out result.

Traffic:

1. Simulation event injection
2. Webhook `POST /app/network-activity`
3. App decision: no source hint, run rediscovery
4. `POST /network/rls/search` with `activity-handle`
5. RLS response with narrowed source list

### 3. Subscription-Hinted New Source

The network can disclose a data-holder FHIR endpoint that supports the Patient Data Feed topic. The client skips broad RLS, authorizes at that endpoint, and creates a Patient Data Feed subscription there.

Traffic:

1. Webhook with a `source-endpoint` and `feed-topic` notification
2. `POST /sources/:sourceId/token`
3. `POST /sources/:sourceId/fhir/Subscription`
4. App state shows source subscription active

### 4. Known Source Activity

The network identifies a source. The client follows the source hint and runs a narrow query instead of rediscovery.

Traffic:

1. Webhook with `source-activity-detected`
2. App decision: `source-query` is the most specific usable hint
3. `GET /sources/:sourceId/fhir/Encounter?patient=source-patient-valley&_lastUpdated=ge2026-04-29T15%3A00%3A00Z`

### 5. Specific Resource Hint

The network can disclose a data-holder FHIR endpoint and specific Encounter read URL. The client authorizes at the source and reads that resource directly.

Traffic:

1. Webhook with `target-resource` and `target-url`
2. `POST /sources/:sourceId/token`
3. `GET /sources/:sourceId/fhir/Encounter/:id`

### 6. Patient Data Feed Event

A Patient Data Feed subscription at the data-holder FHIR endpoint delivers an id-only notification. The client reads the resource from the same endpoint.

Traffic:

1. Simulation source event injection
2. Webhook `POST /app/patient-data-feed/:sourceId`
3. `GET /sources/:sourceId/fhir/Encounter/:id`

### 7. Missed Network Activity

The simulation drops one webhook. The next notification has a gap in `eventNumber`. The client detects the gap and runs recovery discovery.

Traffic:

1. Dropped webhook recorded as trace event
2. Next webhook arrives with event-number gap
3. App decision: recovery
4. `POST /network/rls/search`

### 8. Sensitive Source Policy

The network observes an event at a sensitive source. Policy only allows an opaque signal. The client can follow up, but the dashboard shows that source details were intentionally withheld.

Traffic:

1. Webhook with no source, resource, or endpoint hints
2. `POST /network/rls/search` with `activity-handle`
3. Response may be empty, delayed, or narrowed depending on policy controls

## Data Fixtures

Minimum fixture set:

- One patient with network id `network-patient-123`.
- Three sources:
  - Valley Clinic: general outpatient, supports source query and Patient Data Feed.
  - Mercy Hospital Phoenix: hospital, data-holder FHIR endpoint hosted by network on the source's behalf.
  - Northside Behavioral Health: sensitive source, source details withheld by default.
- Four network disclosure policies:
  - Opaque only.
  - Source organization allowed.
  - Source endpoint allowed.
  - Source endpoint plus Patient Data Feed topic allowed.

## UI Interactions

Controls:

- Start bootstrap.
- Trigger selected scenario.
- Toggle network disclosure policy.
- Toggle source support for Patient Data Feed.
- Drop next webhook.
- Clear trace.
- Reset simulation.

Inspectors:

- Raw JSON request/response.
- Decoded FHIR notification summary.
- Logical `NetworkActivitySignal` view.
- Follow-up explanation showing the exact URL or query template the app used.
- State diff before and after each selected trace event.

## Acceptance Criteria

1. A user can run the bootstrap flow and see every internal HTTP-like message.
2. A user can trigger opaque, source-hinted, query-hinted, resource-hinted, and subscription-hinted activity notifications.
3. The traffic log shows webhook delivery and all follow-up requests with method, path, query, headers, body, status, and response body.
4. The app state shows known sources, source subscriptions, last event number, and deduplicated activity ids.
5. Opaque handles are visible as opaque strings and can be traced through follow-up calls.
6. The same simulated event can produce different notifications when the network disclosure policy changes.
7. No code path uses real network requests for simulated actors.
8. TypeScript checks and unit tests pass under Bun.

## Suggested Build Order

1. Add Vite/React/Bun project skeleton under `demo/`.
2. Implement the simulation kernel and route matching with unit tests.
3. Implement FHIR builders for Subscription, SubscriptionStatus bundles, Parameters, and minimal Encounter/Appointment resources.
4. Implement actors without UI and test the scenarios as scripts.
5. Build the traffic log and message inspector.
6. Build scenario controls and state panels.
7. Add Patient Data Feed flows and missed-message recovery.
8. Add Playwright smoke tests for desktop and mobile layout.
