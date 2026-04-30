# Browser Reference Implementation

The demo is a browser-based simulation of the Activity Notifications MVP. It
does not send real HTTP requests. Instead, a small in-memory router records
HTTP-like messages with method, path, query, headers, body, status, and response
body.

Run it with:

```sh
bun install
bun run dev
```

## What It Demonstrates

- A client authorizes at a Network Activity Endpoint and creates one
  network-level subscription.
- The network sends full-resource R4B Backport notification bundles with a
  `Parameters` activity signal and valid bundle-local `urn:uuid:` references.
- Activity signals carry repeatable `activity-type` codings, optional
  confidence, an opaque activity handle, and optional data-holder hints.
- The client treats each signal as a hint: it either runs network discovery/RLS
  or authorizes at the hinted data-holder endpoint and uses ordinary FHIR
  capabilities there.
- Data-holder FHIR endpoints independently authorize `/metadata`, search, read,
  and Patient Data Feed subscription requests.
- Patient Data Feed notifications remain endpoint-level and id-only.
- The simulated clock uses fixed timestamps, so heartbeat webhooks and recovery
  checks appear in the event log at understandable points in time.

Token requests show OAuth token-exchange-style form fields with a placeholder
SMART Permission Ticket in `subject_token`. The simulator does not validate the
ticket; the decoded placeholder simply shows where issuer-signed patient
self-access authorization and IAL2 identity facts could be conveyed.

## Simulation Actors

| Actor | Responsibilities |
|---|---|
| Client App | Creates the network subscription, receives webhooks, parses activity signals, follows the most useful available hint, and tracks known data holders. |
| Network Activity | Issues mock network tokens, accepts the activity subscription, converts simulated events into activity signals, and delivers webhooks. |
| RLS / Query | Simulates existing network discovery and shows how an opaque `activity-handle` can narrow fan-out. |
| Data Holder FHIR | Issues mock data-holder tokens, advertises capabilities in `/metadata`, supports Encounter queries/reads, and accepts Patient Data Feed subscriptions when enabled. |

## Main Routes

| Route | Meaning |
|---|---|
| `POST /network/token` | Mock network token response with network-scoped patient context. |
| `POST /network/fhir/Subscription` | Create the network activity subscription. |
| `POST /app/network-activity` | Client webhook receiver for network activity. |
| `POST /network/internal/heartbeat` | Demo-only trigger for a network Subscription heartbeat webhook. |
| `POST /app/internal/heartbeat-check` | Demo-only trigger for the client checking whether a heartbeat deadline was missed. |
| `POST /network/fhir/$data-holder-discovery` | FHIR-style discovery operation. The request is a `Parameters` resource with network-scoped `patient` and optional `activity-handle`; the response is a searchset `Bundle` of `Organization` and `Endpoint` resources. |
| `POST /data-holders/:id/token` | Mock data-holder token response with endpoint-scoped patient context. |
| `GET /data-holders/:id/fhir/metadata` | Discover data-holder FHIR capabilities. |
| `GET /data-holders/:id/fhir/Encounter` | Query Encounters by endpoint-scoped patient id and `_lastUpdated`. |
| `GET /data-holders/:id/fhir/Encounter/:id` | Read one Encounter. |
| `POST /data-holders/:id/fhir/Subscription` | Create an endpoint-level Patient Data Feed subscription. |
| `POST /app/patient-data-feed/:id` | Client webhook receiver for Patient Data Feed notifications. |

## Scenarios

| Scenario | What to look for |
|---|---|
| Bootstrap | Network token exchange, network activity `Subscription` create, and active app state. |
| Opaque Activity | Webhook contains no data-holder details; the client calls FHIR-style discovery with `activity-handle`, narrowing the result to the data holder tied to that handle. |
| Endpoint Hint | Webhook names a data-holder endpoint; the client authorizes there, checks `/metadata`, and creates a Patient Data Feed subscription. |
| Known Data Holder | Webhook names a known data-holder endpoint; the client skips RLS and runs an ordinary Encounter search there. |
| Activity Tags | Webhook includes activity-type tags; the client uses recognized tags to choose ordinary data-holder follow-up. |
| Patient Data Feed | A network heartbeat arrives between setup and later data-holder activity; the data-holder endpoint then sends an id-only Encounter notification and the client reads the referenced Encounter. |
| Missed Heartbeat | A heartbeat is dropped; after the grace period, the client runs broad discovery, receives multiple visible data holders, and runs connected data-holder queries. |
| Sensitive Policy | A sensitive data holder forces an opaque signal and RLS withholds the data-holder detail. |

## UI Shape

The main desktop workspace uses three scrollable columns:

1. **Events**: a chronological list of exchanges, webhooks, decisions, and state
   changes with fixed simulation timestamps.
2. **Request**: the selected request or internal event details.
3. **Response**: the selected response, payload summary, or merged details for
   non-request events.

The header stays compact: scenario buttons fit on one row on a laptop screen,
advanced knobs are collapsed by default, and the current flow explains the
selected scenario in a few steps.

## Acceptance Checks

- `bun test` passes in `demo/`.
- `bun run build` passes in `demo/`.
- A Chromium smoke check can open the app, run scenarios, and verify the
  three-column layout, readable request/response panes, and non-overlapping SVG
  diagram.
