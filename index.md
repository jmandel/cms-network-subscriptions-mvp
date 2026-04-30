# CMS Aligned Networks: Network Activity Notifications

**CMS Interoperability Framework - Subscriptions Workgroup**

*Draft for Discussion*

## 1. Purpose

This proposal defines a small, network-level notification capability: a CMS-Aligned Network can tell an authorized client that patient-relevant activity may exist, and can optionally include hints about how the client should follow up.

The activity notification is a control-plane signal. It is not an encounter notification, an appointment notification, or a clinical payload. It helps a client decide whether to run discovery, query a network service, query a data-holder FHIR endpoint, or create a Patient Data Feed subscription at that same endpoint.

This gives the ecosystem two complementary MVPs:

| MVP | Where it lives | What it does |
|-----|----------------|--------------|
| Network-level activity notifications | CMS-Aligned Network | Tells a client that something relevant may have changed, with optional data-holder and follow-up hints |
| Patient Data Feed subscriptions | Data-holder FHIR endpoint, whether provider-operated or network-hosted for that provider | Delivers encounter and appointment notifications using the US Core Patient Data Feed topic |

Together, these reduce blind polling. The network can say "look here" or "run a narrowed follow-up," and the data-holder FHIR endpoint can deliver detailed encounter and appointment events.

![Network activity notification overview](images/activity-overview.svg)

## 2. Design Principles

1. **No clinical content in the network signal.** The notification does not contain inline Encounter, Appointment, diagnosis, reason-for-visit, or other clinical resources.
2. **Progressive disclosure.** A conformant notification can be fully opaque. A network may add a data-holder organization, endpoint, or explicit follow-up hints when policy and available data allow.
3. **Hints, not commands.** The notification carries facts and follow-up hints. The client follows the most specific usable hint it supports and falls back to discovery.
4. **Opaque handles enable narrowed follow-up.** The network can include an opaque `activity-handle` that the client passes unchanged into follow-up calls. Downstream services can use the handle to narrow processing without revealing why.
5. **No app-specific data-holder memory required at the network.** The network can identify a data holder when it can. The client decides whether that data holder is new, known, already subscribed, or irrelevant.
6. **Existing RLS remains valid.** Activity notifications can point clients back to existing discovery/RLS flows, or provide enough detail to bypass a broad RLS query.
7. **Endpoint-scoped patient context.** A patient id is meaningful only at the endpoint that issued it. A data-holder hint may point to an organization or endpoint, but the client still obtains data-holder authorization and the data-holder-specific patient id from that data holder.
8. **Ids and handles are opaque to clients.** Clients do not parse `activity-id` or `activity-handle`, and networks should avoid values that reveal sensitive meaning to clients.
9. **Authorization is not solved here.** This specification assumes the network sends activity notifications only when the client is authorized to receive that signal.

## 3. What A Network Might Observe

A network may learn about patient-relevant activity from many operational signals, including:

- A participant sends an ADT, scheduling, or other event feed to the network.
- A participant's broker or gateway receives a data-holder Patient Data Feed event.
- A record locator or discovery result changes for a patient.
- A peer network reports that a patient-relevant data holder exists.
- A permitted administrative workflow indicates that a data holder may now have data.

This proposal does not standardize how the network learns the activity. It only standardizes the client-facing notification pattern.

Activity notifications are allowed to be conservative. A signal can mean "the network has confirmed new activity" or only "the network has enough reason to suggest a follow-up." The optional `confidence` field lets a network distinguish these cases without disclosing the underlying evidence.

## 4. Actors

| Actor | Description |
|-------|-------------|
| **Client** | Application that wants patient-relevant activity signals. The initial audience is patient-facing Individual Access Services apps, but the model is not limited to them. |
| **Network Activity Endpoint** | FHIR endpoint operated by a CMS-Aligned Network. The client subscribes here for activity notifications. |
| **Discovery/RLS Service** | Existing network service that helps the client find relevant data holders. This may be FHIR, XCPD/RLS, directory-based, or another network-defined flow. |
| **Data-Holder FHIR Endpoint** | FHIR endpoint operated by or on behalf of a data holder participating in a CMS-Aligned Network. The client may query or read resources there, and when the endpoint supports FHIR Subscriptions it may create a US Core Patient Data Feed subscription there. |

## 5. Topic

This proposal defines one network-level topic:

```text
https://cms.gov/fhir/SubscriptionTopic/network-activity
```

The topic's focus resource is `Parameters`. REST-hook delivery uses an `empty` wake-up notification, and the client retrieves the authoritative `Parameters` content from the Network Activity Endpoint using the FHIR R4 Subscriptions Backport `$events` operation with `content=full-resource`.

The use of `Parameters` is intentional. It lets the proposal define a small logical message without requiring new FHIR resource types.

## 6. Subscription Setup

The client authorizes at the Network Activity Endpoint. The resulting access token is scoped to one patient, with identity proofing and authorization established before token issuance. That issuance might happen through an authorization-code flow, permission-ticket flow, delegated-access flow, or another framework-defined mechanism. The token response includes a network-scoped patient context, following SMART conventions:

```json
{
  "access_token": "eyJ...",
  "token_type": "bearer",
  "expires_in": 3600,
  "scope": "system/Subscription.crud",
  "patient": "network-patient-123"
}
```

The client creates a subscription filtered to that patient:

```http
POST https://network.example.org/fhir/Subscription
Authorization: Bearer {access_token}
Content-Type: application/fhir+json
```

```json
{
  "resourceType": "Subscription",
  "status": "requested",
  "reason": "Notify when patient-relevant network activity is observed",
  "criteria": "https://cms.gov/fhir/SubscriptionTopic/network-activity",
  "_criteria": {
    "extension": [
      {
        "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
        "valueString": "Parameters?patient=network-patient-123"
      }
    ]
  },
  "channel": {
    "type": "rest-hook",
    "endpoint": "https://app.example.org/fhir/network-activity",
    "payload": "application/fhir+json",
    "_payload": {
      "extension": [
        {
          "url": "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
            "valueCode": "empty"
        }
      ]
    }
  }
}
```

The `patient` filter uses the patient id returned by the Network Activity Endpoint. It is not a cross-network patient identifier.

## 7. Activity Message Model

Every activity notification has:

- An `activity-id` for deduplication.
- The patient context for routing.
- An `activity-type`.
- The time the network observed the activity.

Most other fields are optional. Each activity `Parameters` resource describes one patient activity signal for at most one data holder. If one FHIR notification delivery needs to report several data holders, the `subscription-notification` Bundle can include multiple focus `Parameters` resources, one per activity. This keeps each activity message flat and avoids `Parameters.parameter.part` nesting.

![Network activity detail spectrum](images/detail-spectrum.svg)

### 7.1 Logical TypeScript Model

The logical model is also available as [schema/network-activity.ts](schema/network-activity.ts).

```ts
export interface NetworkActivitySignal {
  topic: Url;
  activityId: string;
  patient: PatientContext;
  observedAt: FhirInstant;
  activityType: ActivityType;
  confidence?: ActivityConfidence;
  handle?: OpaqueActivityHandle;
  dataHolderOrganization?: OrganizationHint;
  dataHolderEndpoint?: Url;
  followUpRead?: UrlTemplate[];
  followUpSearch?: UrlTemplate[];
  followUpSubscribe?: Url[];
  followUpDiscovery?: string;
  extensions?: Record<string, unknown>;
}
```

### 7.2 FHIR Parameters Mapping

| Parameter | Cardinality | Type | Meaning |
|-----------|-------------|------|---------|
| `activity-id` | 1..1 | `valueString` | Stable id for deduplication. |
| `patient` | 1..1 | `valueString` | Network Activity Endpoint-scoped patient id or patient handle known to the subscriber. |
| `activity-type` | 1..1 | `valueCode` | Broad type of signal. Minimum value is `activity-detected`. |
| `observed-at` | 1..1 | `valueInstant` | When the network observed the activity. |
| `confidence` | 0..1 | `valueCode` | `confirmed`, `probable`, or `possible`. |
| `activity-handle` | 0..1 | `valueString` | Opaque handle the client may pass into follow-up actions. |
| `activity-handle-expires` | 0..1 | `valueInstant` | Optional expiration for the handle. |
| `data-holder-organization` | 0..1 | `resource` | Minimal FHIR `Organization` identifying the data holder, usually by NPI, CCN, or network identifier. |
| `data-holder-endpoint` | 0..1 | `valueUrl` | Data-holder FHIR base URL where authorization, read, search, or subscription creation may occur. |
| `follow-up-read` | 0..* | `valueString` | Absolute or templated GET URL for a specific FHIR resource. |
| `follow-up-search` | 0..* | `valueString` | Absolute or templated FHIR search URL. |
| `follow-up-subscribe` | 0..* | `valueUrl` | SubscriptionTopic URL the client may use at `data-holder-endpoint`, usually US Core Patient Data Feed. |
| `follow-up-discovery` | 0..1 | `valueString` | Network-defined discovery/RLS follow-up hint. The value is opaque to the client except as documented by the network. |

### 7.3 Activity Types

| Code | Meaning |
|------|---------|
| `activity-detected` | Generic signal. Something patient-relevant may have changed, but the network is not disclosing more. |
| `care-relationship-detected` | The network believes a data holder may now hold data for the patient. The client decides whether the data holder is new. |
| `data-holder-activity-detected` | The network believes an identified data holder has new or changed patient-relevant activity. |
| `data-holder-resource-detected` | The network can point to a specific data-holder resource for targeted follow-up. |

Networks may define additional codes by agreement, but clients should not need custom codes for the base workflow.

### 7.4 Confidence

| Code | Meaning |
|------|---------|
| `confirmed` | The network observed a concrete event, state change, or data-holder assertion. |
| `probable` | The network has strong reason to suggest follow-up, but the signal may not correspond to retrievable clinical data. |
| `possible` | The signal is intentionally weak or conservative. The client should expect broader follow-up and possible empty results. |

If omitted, clients should treat confidence as unknown and should not assume that data will be available.

## 8. Client Follow-Up

The notification does not tell the client what to do. It provides hints. A client can use a simple deterministic rule: follow the most specific hint it understands, and fall back to ordinary rediscovery.

Recommended client order:

1. If `follow-up-read` is present, authorize at the data holder and run the first usable GET URL.
2. Else if `follow-up-search` is present, authorize at the data holder and run the first usable GET search URL.
3. Else if `follow-up-subscribe` and `data-holder-endpoint` are present, authorize at `data-holder-endpoint` and create or refresh a Patient Data Feed subscription using that topic.
4. Else if `follow-up-discovery` is present, run the network's documented discovery/RLS workflow, passing the hint and `activity-handle` when supported.
5. Else run ordinary discovery/RLS, passing `activity-handle` when supported.
6. If the client cannot use a hint, it falls back to ordinary discovery/RLS.

This keeps the notification from becoming a workflow language. The network can provide better hints when policy allows; the client decides how far to follow them.

Data-holder hints do not carry a data-holder-specific patient id. If the client does not already have an authorized data-holder context, it authorizes at the data holder first and uses the patient context returned by that data holder.

The meaning of `{{patient}}` is always scoped to the endpoint where the follow-up is performed. For data-holder follow-up, `{{patient}}` means the data-holder-scoped patient id returned during authorization at that data holder. For network discovery follow-up, `{{patient}}` means the Network Activity Endpoint-scoped patient id associated with the subscription token. Clients SHALL NOT reuse a patient id from one endpoint at another endpoint.

`follow-up-read` and `follow-up-search` are explicit follow-up templates, not requests for the client to infer a query from loose fields. A network can send:

```text
https://valley-clinic.example.org/fhir/Encounter?patient={{patient}}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z
```

After data-holder authorization returns `patient=data-holder-patient-valley`, the client runs:

```http
GET https://valley-clinic.example.org/fhir/Encounter?patient=data-holder-patient-valley&_lastUpdated=ge2026-04-29T15%3A00%3A00Z
Authorization: Bearer {data_holder_access_token}
```

The template MAY be relative to `data-holder-endpoint`, for example `Encounter?patient={{patient}}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z`. Supported template variables are:

- `{{patient}}`: the data-holder-specific patient id returned during authorization at that data holder.
- `{{activity-handle}}`: the opaque activity handle from the network notification.

The client URL-encodes substituted values. Receiving services are free to ignore unsupported handle parameters.

No method field is needed in the MVP: `follow-up-read` and `follow-up-search` are GET requests, and `follow-up-subscribe` means "create a FHIR `Subscription` at `data-holder-endpoint` using this topic."

`follow-up-discovery` is intentionally less prescriptive. Its value is opaque to the client except as documented by the network. The MVP does not define the transport, method, body shape, or response shape for existing RLS/discovery workflows.

The subscription topic advertised by a data-holder FHIR endpoint is the US Core Patient Data Feed topic:

```text
http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed
```

### 8.1 Opaque Activity Handles

An `activity-handle` is an opaque value scoped to the network, client, patient, and activity. The client does not inspect it. The client passes it unchanged to network discovery, resolution services, or follow-up URLs when supported.

The handle can help downstream services reduce fan-out. For example, if a broad RLS query would usually touch hundreds of sites, the network can use the handle to know that only one or two sites are plausible for this particular activity. The client does not need to know those sites unless the network chooses to disclose them.

Clients SHALL NOT parse `activity-id` or `activity-handle` or infer meaning from their structure. Networks SHOULD avoid token values that reveal sensitive meaning to clients. Servers MAY maintain internal mappings from handles to data holders, patients, events, routing state, or policy decisions.

The handle is not:

- A patient identifier.
- A clinical resource identifier.
- A consent artifact.
- A guarantee that data exists.
- Authorization to retrieve data.

### 8.2 Passing Handles In Follow-Up Calls

This proposal uses `activity-handle` as the default parameter name for follow-up calls. For FHIR operations, the handle can be a `Parameters` input named `activity-handle`. For HTTP or directory workflows, the same value can be passed as a documented query parameter, body parameter, or header. The receiving service decides whether and how to use it.

If the client cannot pass the handle in the requested way, it may still perform the follow-up without the handle. The result may be broader or slower.

## 9. Examples

### 9.1 Minimal Opaque Notification

The network discloses no data-holder detail in the webhook. The REST-hook delivery is only a wake-up signal:

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-04-29T16:00:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 42,
        "notificationEvent": [
          {
            "eventNumber": 42,
            "timestamp": "2026-04-29T15:59:50Z"
          }
        ],
        "subscription": {
          "reference": "https://network.example.org/fhir/Subscription/sub-123"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/network-activity"
      }
    }
  ]
}
```

The client then retrieves the authoritative event content:

```http
GET https://network.example.org/fhir/Subscription/sub-123/$events?eventsSinceNumber=42&eventsUntilNumber=42&content=full-resource
Authorization: Bearer {access_token}
```

The `$events` response includes the `Parameters` focus resource:

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-04-29T16:00:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 42,
        "notificationEvent": [
          {
            "eventNumber": 42,
            "timestamp": "2026-04-29T15:59:50Z",
            "focus": {
              "reference": "urn:uuid:activity-42",
              "type": "Parameters"
            }
          }
        ],
        "subscription": {
          "reference": "https://network.example.org/fhir/Subscription/sub-123"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/network-activity"
      }
    },
    {
      "fullUrl": "urn:uuid:activity-42",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "activity-id", "valueString": "act-4f7k2p9" },
          { "name": "patient", "valueString": "network-patient-123" },
          { "name": "activity-type", "valueCode": "activity-detected" },
          { "name": "observed-at", "valueInstant": "2026-04-29T15:59:50Z" },
          { "name": "confidence", "valueCode": "probable" },
          { "name": "activity-handle", "valueString": "ah-9c3m1q8" },
          { "name": "follow-up-discovery", "valueString": "ordinary-network-discovery" }
        ]
      }
    }
  ]
}
```

The app should rediscover or query the network, passing the handle when supported.

### 9.2 FHIR Endpoint With Subscribe Follow-Up

The network can disclose an organization and a data-holder FHIR endpoint that supports Patient Data Feed subscriptions. The client may skip broad RLS and create a Patient Data Feed subscription at that endpoint.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-7p2xq4m" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "care-relationship-detected" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:10:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-q8v1n6r" },
    {
      "name": "data-holder-organization",
      "resource": {
        "resourceType": "Organization",
        "identifier": [
          {
            "system": "http://hl7.org/fhir/sid/us-npi",
            "value": "1234567890"
          }
        ],
        "name": "Valley Clinic"
      }
    },
    {
      "name": "data-holder-endpoint",
      "valueUrl": "https://valley-clinic.example.org/fhir"
    },
    {
      "name": "follow-up-subscribe",
      "valueUrl": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed"
    }
  ]
}
```

### 9.3 Search A Data Holder

The network does not need to know whether the app already knows the data holder. It identifies the data holder and provides an explicit search follow-up. The app decides whether to query, subscribe, ignore, or treat it as already covered.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-h2n5s8d" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "data-holder-activity-detected" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:25:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-3wd7k9a" },
    {
      "name": "data-holder-organization",
      "resource": {
        "resourceType": "Organization",
        "identifier": [
          {
            "system": "http://hl7.org/fhir/sid/us-npi",
            "value": "1234567890"
          }
        ],
        "name": "Valley Clinic"
      }
    },
    {
      "name": "data-holder-endpoint",
      "valueUrl": "https://valley-clinic.example.org/fhir"
    },
    {
      "name": "follow-up-search",
      "valueString": "https://valley-clinic.example.org/fhir/Encounter?patient={{patient}}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z&activity-handle={{activity-handle}}"
    }
  ]
}
```

### 9.4 Read A Specific Resource

The network can disclose a data-holder endpoint and a specific read follow-up. The client still authorizes at the data holder before reading it.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-m7q4n2v" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "data-holder-resource-detected" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:28:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-n8w2p5s" },
    {
      "name": "data-holder-endpoint",
      "valueUrl": "https://hospital.example.org/fhir"
    },
    {
      "name": "follow-up-read",
      "valueString": "https://hospital.example.org/fhir/Encounter/enc-123"
    }
  ]
}
```

### 9.5 Network Query With Fan-Out Reduction

The notification is opaque, but the follow-up handle lets the network return a narrowed result without the app learning why the result was narrow.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-r6k1v0p" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "activity-detected" },
    { "name": "confidence", "valueCode": "probable" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:30:00Z" },
    { "name": "activity-handle", "valueString": "ah-b5m8x2t" },
    { "name": "follow-up-discovery", "valueString": "ordinary-network-discovery" }
  ]
}
```

## 10. Relationship To RLS And Discovery

Activity notifications do not replace RLS. They add a streaming front door to discovery.

A network may:

- Send an opaque notification that causes the client to run its existing RLS workflow.
- Include an `activity-handle` so the RLS workflow can be narrowed.
- Include `data-holder-organization` so the client can decide whether it already knows the data holder.
- Include `follow-up-read`, `follow-up-search`, or `follow-up-subscribe` with `data-holder-endpoint` so the client can skip broad discovery and run a concrete follow-up.

This makes the same topic useful across networks with different policy and technical capabilities. A network that cannot disclose data-holder detail can still send useful signals. A network that can disclose more can reduce client work and avoid unnecessary fan-out.

## 11. Relationship To Patient Data Feed

The data-holder FHIR endpoint data plane should use the US Core Patient Data Feed topic:

```text
http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed
```

Activity notifications help the client decide where to establish or refresh those data-holder endpoint subscriptions.

For example:

1. The client subscribes to `network-activity` at the network.
2. The network sends an activity notification with both `data-holder-endpoint` and `follow-up-subscribe`.
3. The client authorizes at that endpoint.
4. The client creates a Patient Data Feed subscription there.
5. Encounter and appointment notifications flow directly from that data-holder FHIR endpoint.

The network-level activity signal stays out of the clinical data path. The data-holder FHIR endpoint remains responsible for data-holder authorization, data-holder-specific patient identity, clinical data access, and any Patient Data Feed subscription it accepts.

## 12. Delivery And Catch-Up

REST-hook delivery is best effort. Servers MAY retry failed delivery, and clients SHOULD be idempotent, but clients SHALL NOT assume guaranteed at-least-once delivery.

For the `network-activity` topic, REST-hook notifications use the FHIR Subscriptions Backport `empty` payload content mode. The webhook notification is a wake-up signal and SHALL NOT include the NetworkActivitySignal `Parameters` resource. This keeps the actionable payload behind the Network Activity Endpoint's normal authenticated FHIR API.

Clients retrieve authoritative notification content from the Network Activity Endpoint using:

```http
GET [base]/Subscription/{id}/$events?eventsSinceNumber={n}&eventsUntilNumber={n}&content=full-resource
Authorization: Bearer {access_token}
```

For this topic, Network Activity Endpoints SHALL honor `content=full-resource` for retained events and SHALL return notification bundles that include the NetworkActivitySignal `Parameters` focus resource.

Clients SHOULD process network activity events by event number and remember the highest successfully processed event number per subscription. If a client receives event number N after last successfully processing event M, and N > M + 1, the client SHOULD retrieve events M+1 through N using `$events`.

Network Activity Endpoints SHALL retain retrievable notification event content for at least 24 hours after notification generation. They SHOULD retain at least the most recent 100 events per active subscription, even when some events are older than 24 hours. They SHALL document their event retention window and any maximum supported `$events` range size.

If requested event content is no longer available, the Network Activity Endpoint SHALL return a 4xx response with an `OperationOutcome` explaining that the requested events are no longer available. The client SHOULD then run ordinary discovery/RLS for the patient, passing the most recent `activity-handle` when available.

## 13. Security, Privacy, And Consent

This proposal deliberately does not define the ecosystem consent model.

Minimum assumptions:

- The network sends activity notifications only when policy authorizes the client to receive that kind of signal.
- Even an opaque activity notification may reveal sensitive information because it says something happened.
- Optional data-holder hints may reveal more, especially if the organization or endpoint implies a sensitive service.
- The webhook is only a wake-up signal, but clients should still authenticate the sender where practical and protect the endpoint from abusive wake-up traffic.
- A hint is not authorization to retrieve clinical data.
- Data-holder FHIR endpoints enforce their own authorization and access control before returning clinical resources or accepting Patient Data Feed subscriptions.
- An `activity-handle` may narrow routing or processing, but it must not bypass authorization.

Networks should choose the least detailed notification that still gives the client a useful follow-up path.

## 14. Conformance Summary

### Network Activity Endpoint

- SHALL support the `network-activity` topic.
- SHALL accept subscriptions filtered to an endpoint-scoped patient context.
- SHALL deliver empty wake-up notification bundles using the FHIR R4 Subscriptions Backport format.
- SHALL support `Subscription/{id}/$events` with `content=full-resource` for retained `network-activity` events.
- SHALL include a `Parameters` focus resource with `activity-id`, `patient`, `activity-type`, and `observed-at` in authoritative `$events` responses.
- SHALL retain retrievable notification event content for at least 24 hours.
- SHALL NOT include inline clinical resources in the activity notification.
- SHALL NOT include data-holder-specific patient identifiers in the activity notification.
- SHALL treat `activity-id` and `activity-handle` as opaque client-facing values.
- SHOULD include an `activity-handle` when follow-up services can use it to reduce fan-out.
- MAY include data-holder organization, data-holder endpoint, follow-up-read, follow-up-search, follow-up-subscribe, and follow-up-discovery hints.

### Client

- SHALL treat all data-holder and follow-up hints as hints, not commands.
- SHALL treat `activity-handle` as opaque.
- SHALL be idempotent for duplicate notifications.
- SHALL retrieve authoritative network activity content through `$events` before making follow-up decisions.
- SHOULD detect event gaps using `eventNumber` and retrieve missing retained events through `$events`.
- SHOULD follow the most specific usable hint and fall back to rediscovery.
- SHOULD use Patient Data Feed subscriptions when the data-holder FHIR endpoint supports them and the client is authorized.

### Data-Holder FHIR Endpoint

- If accepting Patient Data Feed subscriptions, SHALL support the US Core Patient Data Feed topic for Encounter.
- MAY support Appointment when available, and SHALL document whether Appointment is supported.
- SHALL enforce data-holder authorization independently of the network activity notification.

## 15. Out Of Scope

- The consent and patient preference model.
- Identity proofing and token choreography.
- The transport and query syntax of existing RLS or discovery services.
- Cross-network peer signaling.
- How networks internally observe activity.
- Whether a data holder is new to a particular client.
- Guaranteed delivery of every network-observed activity.
- Detailed Patient Data Feed conformance, except as a referenced data-holder endpoint capability.

## 16. Open Questions

1. Should the topic URL live under a CMS namespace, an HL7 namespace, or a future implementation guide namespace?
2. Should `follow-up-*` templates support only `{{patient}}` and `{{activity-handle}}`, or should a broader URI-template profile be allowed?
3. Should handle-scoped discovery remain entirely network-defined in the MVP, or should a later version define a standard discovery operation?
4. Should data-holder hints use only FHIR `Organization`, or should they also allow FHIR `Endpoint` resources inline?

## References

- [US Core Patient Data Feed](https://build.fhir.org/ig/HL7/US-Core/patient-data-feed.html)
- [FHIR R4 Subscriptions Backport IG](https://build.fhir.org/ig/HL7/fhir-subscription-backport-ig/)
- [CMS Health Tech Ecosystem](https://www.cms.gov/health-technology-ecosystem)
