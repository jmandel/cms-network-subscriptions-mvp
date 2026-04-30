# CMS Aligned Networks: Network Activity Notifications

**CMS Interoperability Framework - Subscriptions Workgroup**

*Draft for Discussion*

## 1. Purpose

This specification defines a network-level notification capability. A CMS-Aligned
Network can notify an authorized client that patient-relevant activity may exist
and can include limited hints about useful follow-up.

The network activity notification is a hint. It is not clinical data, not proof
that retrievable data exists, and not authorization to retrieve data. Clinical
details come from follow-up at the network or at data-holder FHIR endpoints.

The main CMS use case is helping authorized apps learn that encounter or
appointment activity may exist for a patient without repeatedly polling every
possible endpoint. Network activity notifications reduce broad polling of
network discovery/RLS services. Patient Data Feed subscriptions reduce repeated
polling of data-holder FHIR REST APIs for new or changed Encounter and
Appointment resources.

| Pattern | Where it lives | What it does |
|---------|----------------|--------------|
| Network activity notification | CMS-Aligned Network | Reduces broad discovery/RLS polling by telling a client that patient-relevant activity may exist |
| Patient Data Feed | Data-holder FHIR endpoint | Reduces repeated provider FHIR API polling by notifying on Encounter and Appointment activity when supported by that endpoint |

The data-holder endpoint remains the place where the client obtains
authorization, discovers capabilities, and retrieves clinical details.

![Network activity notification overview](images/activity-overview.svg)

## 2. Actors

| Actor | Description |
|-------|-------------|
| Client | Application that wants patient-relevant activity signals. |
| Network Activity Endpoint | FHIR endpoint operated by a CMS-Aligned Network. The client subscribes here for activity notifications. |
| Discovery/RLS Service | Existing network service that helps the client find relevant data holders. This may be FHIR, XCPD/RLS, directory-based, or another network-defined flow. |
| Data-Holder FHIR Endpoint | FHIR endpoint operated by or on behalf of a data holder. The client may authorize, query, read, discover capabilities, and create Patient Data Feed subscriptions there. |

## 3. Topic And Subscription

This specification defines one network-level topic:

```text
https://cms.gov/fhir/SubscriptionTopic/network-activity
```

The topic URL is used for this draft. It may move to a future implementation
guide namespace if this work is formalized, but no alternate topic URL is
defined in this MVP.

The topic's focus resource is `Parameters`. REST-hook delivery uses the FHIR R4
Subscriptions Backport `full-resource` payload mode so the notification bundle
includes the activity `Parameters` resource inline.

The client authorizes at the Network Activity Endpoint. The token response
includes a Network Activity Endpoint-scoped patient context:

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
    "header": [
      "X-Webhook-Secret: client-generated-secret"
    ],
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

The `patient` filter uses the patient id returned by the Network Activity
Endpoint. It is not a cross-network patient identifier.

Network Activity Endpoints SHALL deliver REST-hook notifications only to
`https://` endpoints. Network Activity Endpoints SHALL support
`Subscription.channel.header` and SHALL include the configured headers when
delivering REST-hook notifications. Clients SHOULD use a high-entropy webhook
secret, correlation value, or equivalent receiver check.

This MVP requires patient-scoped subscriptions. A future version may define
cohort-scoped subscriptions, such as `Parameters?patient:in=Group/{id}`, for
clients authorized to receive activity signals for a panel of patients.

## 4. Activity Message

Each activity notification has:

- `activity-id` for deduplication
- `patient` for routing
- `activity-type`
- `observed-at`

Other fields are optional. Each activity `Parameters` resource describes one
patient activity signal for at most one data holder. If one FHIR notification
reports several activities, the notification Bundle can include multiple
`SubscriptionStatus.notificationEvent` entries, each with `focus` pointing to a
different included `Parameters` resource.

### 4.1 Logical Model

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
  followUpDiscovery?: string;
  extensions?: Record<string, unknown>;
}
```

### 4.2 Parameters Mapping

| Parameter | Cardinality | Type | Meaning |
|-----------|-------------|------|---------|
| `activity-id` | 1..1 | `valueString` | Stable id for deduplication. |
| `patient` | 1..1 | `valueString` | Network Activity Endpoint-scoped patient context associated with the subscription. |
| `activity-type` | 1..1 | `valueCode` | Broad type of signal. Minimum value is `activity-detected`. |
| `observed-at` | 1..1 | `valueInstant` | When the network observed the activity. |
| `confidence` | 0..1 | `valueCode` | `confirmed`, `probable`, or `possible`. |
| `activity-handle` | 0..1 | `valueString` | Opaque handle that a documented network discovery/RLS workflow may use to narrow follow-up. |
| `activity-handle-expires` | 0..1 | `valueInstant` | Optional expiration for the handle. |
| `data-holder-organization` | 0..1 | `resource` | Minimal FHIR `Organization` identifying the data holder, usually by NPI, CCN, or network identifier. |
| `data-holder-endpoint` | 0..1 | `valueUrl` | Data-holder FHIR base URL where the client may authorize, discover capabilities, read, search, or create subscriptions. |
| `follow-up-read` | 0..* | `valueString` | Absolute or templated GET URL for a specific data-holder FHIR resource. |
| `follow-up-search` | 0..* | `valueString` | Absolute or templated data-holder FHIR search URL. |
| `follow-up-discovery` | 0..1 | `valueString` | Network-defined discovery/RLS follow-up hint. The value is meaningful only as documented by the network. |

### 4.3 Activity Types

| Code | Meaning |
|------|---------|
| `activity-detected` | Generic signal. Something patient-relevant may have changed, but the network is not disclosing more. |
| `care-relationship-detected` | The network believes a data holder may now hold data for the patient. The client decides whether the data holder is new or already known. |
| `data-holder-activity-detected` | The network believes an identified data holder has new or changed patient-relevant activity. |
| `data-holder-resource-detected` | The network can point to a specific data-holder resource for targeted follow-up. |

Activity types describe the network signal. They do not describe Encounter or
Appointment lifecycle states. A network activity notification does not say that
an appointment was booked or an encounter was completed; it only tells the client
that follow-up may be useful.

### 4.4 Confidence

| Code | Meaning |
|------|---------|
| `confirmed` | The network observed a concrete event, state change, or data-holder assertion. |
| `probable` | The network has strong reason to suggest follow-up, but retrievable data is not guaranteed. |
| `possible` | The signal is weak or intentionally conservative. Empty follow-up results should be expected. |

If omitted, clients treat confidence as unknown.

## 5. Client Follow-Up

The client follows the most specific usable hint it supports:

1. If `follow-up-read` is present, authorize at the data holder and run the first usable GET URL.
2. Else if `follow-up-search` is present, authorize at the data holder and run the first usable GET search URL.
3. Else if `follow-up-discovery` is present, run the network's documented discovery/RLS workflow.
4. Else run ordinary discovery/RLS.

If the client cannot use a hint, it falls back to ordinary discovery/RLS.

Data-holder hints do not carry a data-holder-specific patient id. If the client
does not already have an authorized data-holder context, it authorizes at the
data-holder endpoint first and uses the patient context returned by that data
holder.

The meaning of `{{patient}}` is scoped to the endpoint where the follow-up is
performed:

- for data-holder follow-up, `{{patient}}` is the data-holder-specific patient id
  returned during authorization at that data holder;
- for network discovery follow-up, `{{patient}}` is the Network Activity
  Endpoint-scoped patient id associated with the subscription token.

Clients SHALL NOT reuse a patient id from one endpoint at another endpoint.

`follow-up-read` and `follow-up-search` are GET URL templates. The MVP defines
one URL template variable:

| Variable | Meaning |
|----------|---------|
| `{{patient}}` | Endpoint-scoped patient id for the endpoint receiving the follow-up request. |

Clients URL-encode substituted values.

If `follow-up-read` or `follow-up-search` is relative, it is resolved relative to
`data-holder-endpoint`. If no `data-holder-endpoint` is present, the follow-up
URL SHALL be absolute.

`activity-handle` is not a follow-up URL variable in this MVP. Clients pass
`activity-handle` only when a documented network discovery/RLS workflow or
network-defined operation says how to pass it. If the client does not know how
to pass the handle, it performs the follow-up without it.

If `data-holder-endpoint` is present, the client may use FHIR `/metadata`
discovery at that endpoint to determine whether Patient Data Feed or other
capabilities are supported. The network activity signal does not carry
data-holder capability metadata.

## 6. Examples

### 6.1 Opaque Activity

The network discloses no data-holder detail. The client should run discovery/RLS.

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

### 6.2 Data Holder Identified

The network identifies a data holder and endpoint. The client can authorize at
that endpoint, use FHIR `/metadata` discovery, and decide whether to query or
create a Patient Data Feed subscription.

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-04-29T16:10:05Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 43,
        "notificationEvent": [
          {
            "eventNumber": 43,
            "timestamp": "2026-04-29T16:10:00Z",
            "focus": {
              "reference": "urn:uuid:activity-43",
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
      "fullUrl": "urn:uuid:activity-43",
      "resource": {
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
          }
        ]
      }
    }
  ]
}
```

### 6.3 Search A Data Holder

The network identifies a data holder and provides an explicit search follow-up.
The search URL is relative to `data-holder-endpoint`.

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-04-29T16:25:05Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 44,
        "notificationEvent": [
          {
            "eventNumber": 44,
            "timestamp": "2026-04-29T16:25:00Z",
            "focus": {
              "reference": "urn:uuid:activity-44",
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
      "fullUrl": "urn:uuid:activity-44",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "activity-id", "valueString": "act-h2n5s8d" },
          { "name": "patient", "valueString": "network-patient-123" },
          { "name": "activity-type", "valueCode": "data-holder-activity-detected" },
          { "name": "observed-at", "valueInstant": "2026-04-29T16:25:00Z" },
          { "name": "confidence", "valueCode": "confirmed" },
          {
            "name": "data-holder-endpoint",
            "valueUrl": "https://valley-clinic.example.org/fhir"
          },
          {
            "name": "follow-up-search",
            "valueString": "Encounter?patient={{patient}}&_lastUpdated=ge2026-04-29T15%3A00%3A00Z"
          }
        ]
      }
    }
  ]
}
```

After authorization at Valley Clinic returns `patient=data-holder-patient-valley`,
the client runs:

```http
GET https://valley-clinic.example.org/fhir/Encounter?patient=data-holder-patient-valley&_lastUpdated=ge2026-04-29T15%3A00%3A00Z
Authorization: Bearer {data_holder_access_token}
```

### 6.4 Read A Specific Resource

The network identifies a data-holder endpoint and a specific read follow-up. The
read URL is relative to `data-holder-endpoint`.

```json
{
  "resourceType": "Bundle",
  "type": "subscription-notification",
  "timestamp": "2026-04-29T16:28:05Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:status-1",
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 45,
        "notificationEvent": [
          {
            "eventNumber": 45,
            "timestamp": "2026-04-29T16:28:00Z",
            "focus": {
              "reference": "urn:uuid:activity-45",
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
      "fullUrl": "urn:uuid:activity-45",
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "activity-id", "valueString": "act-m7q4n2v" },
          { "name": "patient", "valueString": "network-patient-123" },
          { "name": "activity-type", "valueCode": "data-holder-resource-detected" },
          { "name": "observed-at", "valueInstant": "2026-04-29T16:28:00Z" },
          { "name": "confidence", "valueCode": "confirmed" },
          {
            "name": "data-holder-endpoint",
            "valueUrl": "https://hospital.example.org/fhir"
          },
          {
            "name": "follow-up-read",
            "valueString": "Encounter/enc-123"
          }
        ]
      }
    }
  ]
}
```

## 7. Delivery

REST-hook delivery is best effort. Servers MAY retry failed delivery. Clients
SHOULD be idempotent and SHOULD deduplicate activity notifications by
`activity-id`.

`eventNumber` and heartbeat notifications can help a client detect possible
missed notifications. This MVP does not require durable notification retrieval.
If a client suspects it missed notifications, it SHOULD run ordinary
discovery/RLS recovery for the relevant patient. It SHOULD then query connected
data-holder endpoints where it does not already have an active Patient Data Feed
subscription.

A future version may define `$events` support for authenticated notification
retrieval and structured catch-up.

## 8. Security And Privacy

The network sends activity notifications only when policy authorizes the client
to receive that kind of signal.

Even an opaque activity notification may reveal sensitive information because it
says something may have happened. Optional data-holder hints may reveal more,
especially if an organization or endpoint implies a sensitive service.

A network activity notification is not a credential, not an access token, and
not an authorization decision. Each follow-up request is authorized by the
endpoint that receives it.

Networks should choose the least detailed notification that still gives the
client a useful follow-up path.

## 9. Conformance Summary

### Network Activity Endpoint

- SHALL support the `network-activity` topic.
- SHALL accept subscriptions filtered to an endpoint-scoped patient context.
- SHALL deliver notification bundles only to `https://` REST-hook endpoints.
- SHALL deliver notification bundles using the FHIR R4 Subscriptions Backport format with `full-resource` payload content.
- SHALL include a `Parameters` focus resource with `activity-id`, `patient`, `activity-type`, and `observed-at`.
- SHALL make each `SubscriptionStatus.notificationEvent.focus` reference an included `Parameters` resource.
- SHALL support `Subscription.channel.header` and include configured headers in REST-hook deliveries.
- SHALL NOT include inline clinical resources in the activity notification.
- SHALL NOT include data-holder-specific patient identifiers in the activity notification.
- SHALL treat `activity-id` and `activity-handle` as opaque client-facing values.
- SHOULD include an `activity-handle` when documented network discovery/RLS services can use it to reduce fan-out.
- MAY include data-holder organization, data-holder endpoint, follow-up-read, follow-up-search, and follow-up-discovery hints.

### Client

- SHALL treat network activity notifications as hints, not commands.
- SHALL NOT treat network activity notifications as clinical data, proof that retrievable clinical data exists, or authorization.
- SHALL treat `activity-handle` as opaque.
- SHALL be idempotent for duplicate notifications.
- SHALL pass `activity-handle` only when a documented discovery/RLS contract or network-defined operation defines how to pass it.
- SHOULD use a high-entropy shared secret or equivalent receiver check through `Subscription.channel.header`.
- SHOULD detect event gaps using `eventNumber`.
- SHOULD run recovery discovery/RLS when it suspects missed notifications.
- SHOULD follow the most specific usable hint and fall back to discovery/RLS.
- MAY use FHIR `/metadata` discovery at a disclosed data-holder endpoint to determine whether Patient Data Feed is supported.

### Data-Holder FHIR Endpoint

- If accepting Patient Data Feed subscriptions, SHOULD advertise support through FHIR `/metadata` discovery.
- SHALL authorize reads, searches, and Patient Data Feed subscription creates according to its own policy.

## 10. Future Design Space

- Cohort-scoped subscription filters, such as `Parameters?patient:in=Group/{id}`.
- `$events` retrieval for authenticated notification pull and structured catch-up.
- Signed or encrypted REST-hook payload profiles if deployments need message-level protection beyond transport and receiver checks.

## References

- [US Core Patient Data Feed](https://build.fhir.org/ig/HL7/US-Core/patient-data-feed.html)
- [FHIR R4 Subscriptions Backport IG](https://build.fhir.org/ig/HL7/fhir-subscription-backport-ig/)
- [CMS Health Tech Ecosystem](https://www.cms.gov/health-technology-ecosystem)
