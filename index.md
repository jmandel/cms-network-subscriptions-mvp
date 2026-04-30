# CMS Aligned Networks: Network Activity Notifications

**CMS Interoperability Framework - Subscriptions Workgroup**

*Draft for Discussion*

## 1. Purpose

This proposal defines a small, network-level notification capability: a CMS-Aligned Network can tell an authorized client that patient-relevant activity may exist, and can optionally include hints about how the client should follow up.

The activity notification is a control-plane signal. It is not an encounter notification, an appointment notification, or a clinical payload. It helps a client decide whether to run discovery, query a network service, query a source, or subscribe to a source-level feed.

This gives the ecosystem two complementary MVPs:

| MVP | Where it lives | What it does |
|-----|----------------|--------------|
| Network-level activity notifications | CMS-Aligned Network | Tells a client that something relevant may have changed, with optional source and action hints |
| Source-level Patient Data Feed subscriptions | EHR, provider endpoint, or provider-hosted network endpoint | Delivers encounter and appointment notifications using the US Core Patient Data Feed topic |

Together, these reduce blind polling. The network can say "look here" or "run a narrowed follow-up," and the source endpoint can deliver detailed encounter and appointment events.

![Network activity notification overview](images/activity-overview.svg)

## 2. Design Principles

1. **No clinical content in the network signal.** The notification does not contain inline Encounter, Appointment, diagnosis, reason-for-visit, or other clinical resources.
2. **Progressive disclosure.** A conformant notification can be fully opaque. A network may add organization, endpoint, explicit source-query, target-url, or feed hints when policy and available data allow.
3. **Hints, not commands.** The notification carries facts and follow-up hints. The client follows the most specific usable hint it supports and falls back to discovery.
4. **Opaque handles enable narrowed follow-up.** The network can include an opaque `activity-handle` that the client passes unchanged into follow-up calls. Downstream services can use the handle to narrow processing without revealing why.
5. **No app-specific source memory required at the network.** The network can identify a source when it can. The client decides whether that source is new, known, already subscribed, or irrelevant.
6. **Existing RLS remains valid.** Activity notifications can point clients back to existing discovery/RLS flows, or provide enough detail to bypass a broad RLS query.
7. **No source-scoped patient context in the network signal.** A source hint may point to a source, but the client still obtains source authorization and source-scoped patient context from that source.
8. **Ids and handles are non-semantic.** `activity-id` and `activity-handle` are not allowed to encode source ids, patient ids, endpoint hostnames, organization identifiers, resource ids, or other meaningful hints.
9. **Authorization is not solved here.** This specification assumes the network sends activity notifications only when the client is authorized to receive that signal.

## 3. What A Network Might Observe

A network may learn about patient-relevant activity from many operational signals, including:

- A participant sends an ADT, scheduling, or other event feed to the network.
- A participant's broker or gateway receives a source-level Patient Data Feed event.
- A record locator or discovery result changes for a patient.
- A participant publishes a new FHIR endpoint or feed capability.
- A peer network reports that a patient-relevant source exists.
- A permitted administrative workflow indicates that a source may now have data.

This proposal does not standardize how the network learns the activity. It only standardizes the client-facing notification pattern.

Activity notifications are allowed to be conservative. A signal can mean "the network has confirmed new activity" or only "the network has enough reason to suggest a follow-up." The optional `confidence` field lets a network distinguish these cases without disclosing the underlying evidence.

## 4. Actors

| Actor | Description |
|-------|-------------|
| **Client** | Application that wants patient-relevant activity signals. The initial audience is patient-facing Individual Access Services apps, but the model is not limited to them. |
| **Network Activity Endpoint** | FHIR endpoint operated by a CMS-Aligned Network. The client subscribes here for activity notifications. |
| **Discovery/RLS Service** | Existing network service that helps the client find relevant sources. This may be FHIR, XCPD/RLS, directory-based, or another network-defined flow. |
| **Source Endpoint** | FHIR endpoint where the client can query or read clinical resources, subject to source authorization. |
| **Source Feed Endpoint** | FHIR endpoint that supports the US Core Patient Data Feed topic for encounter and appointment notifications. This may be operated by the provider or hosted by the network on the provider's behalf. |

## 5. Topic

This proposal defines one network-level topic:

```text
https://cms.gov/fhir/SubscriptionTopic/network-activity
```

The topic's focus resource is `Parameters`, delivered as `full-resource` content in a FHIR R4 Subscriptions Backport notification bundle.

The use of `Parameters` is intentional. It lets the proposal define a small logical message without requiring new FHIR resource types.

## 6. Subscription Setup

The client authorizes at the Network Activity Endpoint. The token response includes a network-scoped patient context, following SMART conventions:

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
          "valueCode": "full-resource"
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

Most other fields are optional.

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
  source?: SourceHint;
  targetResource?: TargetResourceHint;
  sourceQueries?: SourceQueryHint[];
  feedTopic?: Url;
  activityWindow?: TimeWindow;
  resourceTypes?: FhirResourceType[];
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
| `source-organization` | 0..1 | `resource` | Minimal FHIR `Organization` identifying the source, usually by NPI, CCN, or network identifier. |
| `source-endpoint` | 0..1 | `valueUrl` | FHIR base URL where source query or read may occur. |
| `feed-endpoint` | 0..1 | `valueUrl` | FHIR base URL supporting source-level Patient Data Feed subscriptions. |
| `feed-topic` | 0..1 | `valueUrl` | SubscriptionTopic URL the client should use at the feed endpoint, usually US Core Patient Data Feed. |
| `target-resource` | 0..1 | `valueReference` | Specific resource reference at the hinted source, such as `Encounter/123`. |
| `target-url` | 0..1 | `valueUrl` | Absolute FHIR read URL for the target resource. Preferred when a specific read is intended. |
| `source-query` | 0..* | `valueString` | Explicit FHIR search URL template the client may run after source authorization. It may be absolute or relative to `source-endpoint`. |
| `activity-window-start` | 0..1 | `valueInstant` | Optional descriptive lower bound for likely relevant activity. Not sufficient by itself to define follow-up. |
| `activity-window-end` | 0..1 | `valueInstant` | Optional descriptive upper bound for likely relevant activity. Not sufficient by itself to define follow-up. |
| `resource-type` | 0..* | `valueCode` | Optional descriptive resource types, such as `Encounter` or `Appointment`. Clients SHOULD prefer `source-query` when present. |

### 7.3 Activity Types

| Code | Meaning |
|------|---------|
| `activity-detected` | Generic signal. Something patient-relevant may have changed, but the network is not disclosing more. |
| `care-relationship-detected` | The network believes a source may now hold data for the patient. The client decides whether the source is new. |
| `source-activity-detected` | The network believes an identified source has new or changed patient-relevant activity. |
| `source-resource-detected` | The network can point to a specific source resource for targeted follow-up. |
| `feed-available` | A relevant source feed endpoint may be available. |
| `capability-changed` | A source or network capability changed in a way that may affect follow-up. |

Networks may define additional codes by agreement, but clients should not need custom codes for the base workflow.

### 7.4 Confidence

| Code | Meaning |
|------|---------|
| `confirmed` | The network observed a concrete event, state change, or source assertion. |
| `probable` | The network has strong reason to suggest follow-up, but the signal may not correspond to retrievable clinical data. |
| `possible` | The signal is intentionally weak or conservative. The client should expect broader follow-up and possible empty results. |

If omitted, clients should treat confidence as unknown and should not assume that data will be available.

## 8. Client Follow-Up

The notification does not tell the client what to do. It provides hints. A client can use a simple deterministic rule: follow the most specific hint it understands, and fall back to ordinary rediscovery.

Recommended client order:

1. If `target-url` is present, authorize at that source and read the URL. If only `target-resource` and `source-endpoint` are present, authorize at the source and construct the read URL from those fields.
2. Else if `feed-endpoint` is present, authorize at that endpoint and create or refresh a Patient Data Feed subscription. If `feed-topic` is present, use that topic.
3. Else if `source-query` and `source-endpoint` are present, authorize at the source, substitute the source-scoped `{patient}` value into the query template, and run that query.
4. Else run the network's existing discovery/RLS flow, passing `activity-handle` when present.
5. If the client cannot use a hint, it falls back to rediscovery.

This keeps the notification from becoming a workflow language. The network can provide better hints when policy allows; the client decides how far to follow them.

Source hints do not carry a source-scoped patient id. If the client does not already have an authorized source context, it authorizes at the source first and uses the patient context returned by that source.

`source-query` is an explicit follow-up template, not a request for the client to infer a query from loose fields. A network can send:

```text
https://valley-clinic.example.org/fhir/Encounter?patient={patient}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z
```

After source authorization returns `patient=source-patient-valley`, the client runs:

```http
GET https://valley-clinic.example.org/fhir/Encounter?patient=source-patient-valley&_lastUpdated=ge2026-04-29T15%3A00%3A00Z
Authorization: Bearer {source_access_token}
```

The template MAY be relative to `source-endpoint`, for example `Encounter?patient={patient}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z`. If a template contains `{activity-handle}`, the client substitutes the opaque handle unchanged except for URL encoding. Receiving services are free to ignore unsupported handle parameters.

The source-level subscription topic is the US Core Patient Data Feed topic:

```text
http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed
```

### 8.1 Opaque Activity Handles

An `activity-handle` is an opaque value scoped to the network, client, patient, and activity. The client does not inspect it. The client passes it unchanged to network discovery or resolution services when supported.

The handle can help downstream services reduce fan-out. For example, if a broad RLS query would usually touch hundreds of sites, the network can use the handle to know that only one or two sites are plausible for this particular activity. The client does not need to know those sites unless the network chooses to disclose them.

The network SHALL generate `activity-id` and `activity-handle` values as non-semantic tokens. They SHALL NOT embed source ids, patient ids, endpoint hostnames, organization identifiers, clinical resource ids, or readable business meaning. If the network needs those associations, it keeps them in its own server-side mapping.

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

The network discloses no source detail. The app should rediscover or query the network, passing the handle.

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
              "reference": "urn:uuid:activity-1",
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
      "fullUrl": "urn:uuid:activity-1",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "activity-id", "valueString": "act-4f7k2p9" },
          { "name": "patient", "valueString": "network-patient-123" },
          { "name": "activity-type", "valueCode": "activity-detected" },
          { "name": "observed-at", "valueInstant": "2026-04-29T15:59:50Z" },
          { "name": "confidence", "valueCode": "probable" },
          { "name": "activity-handle", "valueString": "ah-9c3m1q8" }
        ]
      }
    }
  ]
}
```

### 9.2 Source And Feed Hinted Notification

The network can disclose an organization and a source feed endpoint. The client may skip broad RLS and create a Patient Data Feed subscription at the feed endpoint.

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
      "name": "source-organization",
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
      "name": "feed-endpoint",
      "valueUrl": "https://valley-clinic.example.org/fhir"
    },
    {
      "name": "feed-topic",
      "valueUrl": "http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed"
    },
    { "name": "resource-type", "valueCode": "Encounter" },
    { "name": "resource-type", "valueCode": "Appointment" }
  ]
}
```

### 9.3 Query A Source The Client May Already Know

The network does not need to know whether the app already knows the source. It identifies the source. The app decides whether to query, subscribe, ignore, or treat it as already covered.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-h2n5s8d" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "source-activity-detected" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:25:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-3wd7k9a" },
    {
      "name": "source-organization",
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
      "name": "source-endpoint",
      "valueUrl": "https://valley-clinic.example.org/fhir"
    },
    {
      "name": "source-query",
      "valueString": "https://valley-clinic.example.org/fhir/Encounter?patient={patient}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z"
    },
    { "name": "activity-window-start", "valueInstant": "2026-04-29T15:00:00Z" },
    { "name": "resource-type", "valueCode": "Encounter" }
  ]
}
```

### 9.4 Specific Resource Hint

The network can disclose a source and a specific resource reference. The client still authorizes at the source before reading it.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-m7q4n2v" },
    { "name": "patient", "valueString": "network-patient-123" },
    { "name": "activity-type", "valueCode": "source-resource-detected" },
    { "name": "observed-at", "valueInstant": "2026-04-29T16:28:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-n8w2p5s" },
    {
      "name": "source-endpoint",
      "valueUrl": "https://hospital.example.org/fhir"
    },
    {
      "name": "target-resource",
      "valueReference": {
        "reference": "Encounter/enc-123",
        "type": "Encounter"
      }
    },
    {
      "name": "target-url",
      "valueUrl": "https://hospital.example.org/fhir/Encounter/enc-123"
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
    { "name": "activity-handle", "valueString": "ah-b5m8x2t" }
  ]
}
```

## 10. Relationship To RLS And Discovery

Activity notifications do not replace RLS. They add a streaming front door to discovery.

A network may:

- Send an opaque notification that causes the client to run its existing RLS workflow.
- Include an `activity-handle` so the RLS workflow can be narrowed.
- Include `source-organization` so the client can decide whether it already knows the source.
- Include `source-query`, `target-url`, or `feed-endpoint` so the client can skip broad discovery and run a concrete follow-up.

This makes the same topic useful across networks with different policy and technical capabilities. A network that cannot disclose source detail can still send useful signals. A network that can disclose more can reduce client work and avoid unnecessary fan-out.

## 11. Relationship To Patient Data Feed

The source-level data plane should use the US Core Patient Data Feed topic:

```text
http://hl7.org/fhir/us/core/SubscriptionTopic/patient-data-feed
```

Activity notifications help the client decide where to establish or refresh those source-level subscriptions.

For example:

1. The client subscribes to `network-activity` at the network.
2. The network sends a `feed-hinted` activity notification with a source feed endpoint.
3. The client authorizes at that endpoint.
4. The client creates a Patient Data Feed subscription there.
5. Encounter and appointment notifications flow directly from the source feed endpoint.

The network-level activity signal stays out of the clinical data path. The source endpoint remains responsible for source authorization, source-scoped patient identity, and clinical data access.

## 12. Delivery And Catch-Up

Delivery is best effort and at least once. Clients must be idempotent.

Notifications use standard FHIR subscription semantics:

- `eventNumber` lets clients detect gaps.
- Heartbeat notifications can help clients notice a broken delivery path.
- Clients may use standard subscription status and event history operations where supported.
- If a client suspects it missed activity notifications, it should run discovery or network query again using its own recovery policy.

This proposal does not require a network to maintain a complete activity log. Networks should document any event retention and catch-up behavior they support.

## 13. Security, Privacy, And Consent

This proposal deliberately does not define the ecosystem consent model.

Minimum assumptions:

- The network sends activity notifications only when policy authorizes the client to receive that kind of signal.
- Even an opaque activity notification may reveal sensitive information because it says something happened.
- Optional source hints may reveal more, especially if the organization or endpoint implies a sensitive service.
- A hint is not authorization to retrieve clinical data.
- Source endpoints enforce their own authorization and access control before returning clinical resources or accepting Patient Data Feed subscriptions.
- An `activity-handle` may narrow routing or processing, but it must not bypass authorization.

Networks should choose the least detailed notification that still gives the client a useful follow-up path.

## 14. Conformance Summary

### Network Activity Endpoint

- SHALL support the `network-activity` topic.
- SHALL accept subscriptions filtered to an endpoint-scoped patient context.
- SHALL deliver notification bundles using the FHIR R4 Subscriptions Backport format.
- SHALL include a `Parameters` focus resource with `activity-id`, `patient`, `activity-type`, and `observed-at`.
- SHALL NOT include inline clinical resources in the activity notification.
- SHALL NOT include source-scoped patient identifiers in the activity notification.
- SHALL generate `activity-id` and `activity-handle` as non-semantic values that do not encode source, patient, organization, endpoint, or resource information.
- SHOULD include an `activity-handle` when follow-up services can use it to reduce fan-out.
- MAY include source, endpoint, source-query, target-url, target-resource, feed-topic, resource-type, time-window, and feed hints.

### Client

- SHALL treat all source and resource hints as hints, not commands.
- SHALL treat `activity-handle` as opaque.
- SHALL be idempotent for duplicate notifications.
- SHOULD detect event gaps using `eventNumber`.
- SHOULD follow the most specific usable hint and fall back to rediscovery.
- SHOULD use source-level Patient Data Feed subscriptions when a source feed endpoint is available and authorized.

### Source Feed Endpoint

- If offered as a source feed endpoint, SHALL support the US Core Patient Data Feed topic for Encounter.
- MAY support Appointment when available, and SHALL document whether Appointment is supported.
- SHALL enforce source authorization independently of the network activity notification.

## 15. Out Of Scope

- The consent and patient preference model.
- Identity proofing and token choreography.
- The transport and query syntax of existing RLS or discovery services.
- Cross-network peer signaling.
- How networks internally observe activity.
- Whether a source is new to a particular client.
- Guaranteed delivery of every network-observed activity.
- Detailed Patient Data Feed conformance, except as a referenced source-level capability.

## 16. Open Questions

1. Should the topic URL live under a CMS namespace, an HL7 namespace, or a future implementation guide namespace?
2. Should `source-query` templates support only `{patient}` and `{activity-handle}`, or should a broader URI-template profile be allowed?
3. Should there be a standard network `$resolve-activity` operation, or should handle-scoped discovery remain network-defined in the MVP?
4. How much event retention should be expected for activity notification catch-up?
5. Should source hints use only FHIR `Organization`, or should they also allow FHIR `Endpoint` resources inline?

## References

- [US Core Patient Data Feed](https://build.fhir.org/ig/HL7/US-Core/patient-data-feed.html)
- [FHIR R4 Subscriptions Backport IG](https://build.fhir.org/ig/HL7/fhir-subscription-backport-ig/)
- [CMS Health Tech Ecosystem](https://www.cms.gov/health-technology-ecosystem)
