# CMS-Aligned Networks: Activity Notifications MVP

**FHIR Subscriptions Workgroup**
**Draft for discussion**

Reference simulator: <https://joshuamandel.com/cms-network-subscriptions-mvp/>

## 1. Purpose

CMS-Aligned Networks need a small way to tell authorized clients that something
patient-relevant happened somewhere in the network.

This proposal defines a network-level **Activity Notification**. The notification
is a wake-up signal. It does not carry clinical content. It may be completely
opaque, or it may include limited hints such as the data holder organization or a
FHIR endpoint where ordinary authorized follow-up can occur.

The goal is to reduce blind polling:

- if the network can only say "something happened," the client can run ordinary
  network discovery/RLS;
- if the network can identify a data holder, the client can prioritize that data
  holder;
- if the data holder supports the US Core Patient Data Feed, the client can
  subscribe there for ongoing encounter and appointment notifications.

This MVP is intended to complement, not replace, endpoint-level Patient Data
Feed subscriptions.

## 2. Roles

| Role | Meaning |
|---|---|
| Client | An authorized application that receives activity notifications. The initial audience is patient-facing apps, but the model is not app-category-specific. |
| Network Activity Endpoint | A FHIR endpoint operated by a CMS-Aligned Network where the client creates the network activity subscription. |
| Network Discovery/RLS | Existing network-specific discovery services that may help a client find relevant data holders. |
| Data Holder | An organization or system that holds patient data and participates in the network. A data-holder FHIR endpoint may be operated directly by the data holder or on its behalf by the network. |

## 3. Two MVP Capabilities

This proposal assumes two independent capabilities:

1. **Network Activity Notification**: one network-level subscription that wakes
   the client when the network observes patient-relevant activity.
2. **Endpoint Patient Data Feed**: a data-holder FHIR endpoint can support the
   US Core Patient Data Feed topic for detailed encounter and appointment
   notifications.

Together, these are powerful. The network tells the client where attention may
be needed; the data-holder endpoint remains the place where clinical data is
authorized, retrieved, and subscribed to.

## 4. Subscription

The Network Activity topic is:

```text
https://cms.gov/fhir/SubscriptionTopic/network-activity
```

The client creates an R4B Subscriptions Backport `Subscription` at the Network
Activity Endpoint.

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
    "header": ["X-Webhook-Secret: client-generated-secret"],
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

### Filters

| Filter | Cardinality | Meaning |
|---|---:|---|
| `patient` | SHALL | Network-scoped patient id returned during authorization at the Network Activity Endpoint. |
| `activity-type` | MAY | Token filter over activity type codings. Multiple comma-separated values are ORed. |

Examples:

```text
Parameters?patient=network-patient-123
Parameters?patient=network-patient-123&activity-type=visit-related
Parameters?patient=network-patient-123&activity-type=visit-related,document-related
Parameters?patient=network-patient-123&activity-type=https://cms.gov/fhir/CodeSystem/network-activity-type|visit-related
```

Bare activity-type codes in this specification refer to the CMS code system
`https://cms.gov/fhir/CodeSystem/network-activity-type`. Networks may document
additional codes using their own systems.

Future versions may define cohort-level filters such as
`Parameters?patient:in=Group/{id}` while retaining the same notification shape.

## 5. Notification Format

Notifications use the FHIR R4B Subscriptions Backport shape:

- the notification is a `Bundle`;
- `Bundle.type` is `history`;
- the first entry is a `SubscriptionStatus`;
- each activity event points to a `Parameters` resource included in the same
  bundle;
- the `Parameters` resource is the activity signal.
- bundle-local `urn:uuid:` values use valid UUIDs, and each
  `focus.reference` matches the `fullUrl` of the included `Parameters`.

The `Parameters` resource is not clinical content. It is a small set of hints
for follow-up.

### Activity Signal Parameters

| Parameter | Cardinality | Type | Meaning |
|---|---:|---|---|
| `activity-id` | 1..1 | `valueString` | Network-assigned event id. Opaque to the client. |
| `patient` | 1..1 | `valueString` | Patient id scoped to the endpoint where the subscription was created. |
| `activity-type` | 1..* | `valueCoding` | One or more activity tags. |
| `observed-at` | 1..1 | `valueInstant` | When the network observed the activity. |
| `confidence` | 0..1 | `valueCode` | `confirmed`, `probable`, or `possible`. |
| `activity-handle` | 0..1 | `valueString` | Opaque handle that a documented network discovery/RLS workflow may use to narrow follow-up. |
| `activity-handle-expires` | 0..1 | `valueInstant` | Optional expiration for the handle. |
| `data-holder-organization` | 0..1 | `resource` | FHIR `Organization` identifying the data holder, if policy allows disclosure. |
| `data-holder-endpoint` | 0..1 | `valueUrl` | Candidate FHIR base URL operated by or on behalf of the data holder. The client still verifies trust and authorizes there. |

The activity handle is not meaningful to clients. Clients pass it only to
network workflows that document support for it.

### Activity Type Codes

The activity type is a repeatable set of tags. Tags are not mutually exclusive.
For example, a single event can be both `activity-detected` and `visit-related`.

Suggested CMS codes:

FHIR `Coding.system` for these codes:
`https://cms.gov/fhir/CodeSystem/network-activity-type`

Bare codes in this section refer to that code system.

| Code | Meaning |
|---|---|
| `activity-detected` | Generic patient-relevant activity was observed. |
| `care-relationship-detected` | The network believes a data holder has become newly relevant for the patient. |
| `data-holder-activity-detected` | The network believes activity occurred at an identified data holder. |
| `visit-related` | The activity appears related to an encounter, appointment, admission, discharge, or transfer. |
| `diagnostic-related` | The activity appears related to labs, imaging, reports, or similar diagnostic data. |
| `document-related` | The activity appears related to a document or note. |
| `medication-related` | The activity appears related to medications or prescriptions. |

Networks may define additional activity type codings.

## 6. Follow-Up Model

The notification does not prescribe a single operation. It gives the client
enough information to choose ordinary follow-up:

- if no data holder is identified, the client can run network discovery/RLS;
- if an `activity-handle` is present, the client can pass it to discovery/RLS
  workflows that document support for it;
- if a data-holder organization or endpoint is present, the client can
  prioritize that data holder;
- if a data-holder endpoint is present, the client authorizes there, learns the
  endpoint-scoped patient id, and uses ordinary FHIR capabilities such as
  `/metadata`, search, read, or Patient Data Feed subscription creation.

The patient id returned by authorization is always scoped to the endpoint where
it is used. A network-scoped patient id is used at the Network Activity Endpoint.
A data-holder-scoped patient id is used at that data-holder endpoint.

## 7. Examples

### Opaque Activity

The network can wake the client without naming the data holder.

```json
{
  "resourceType": "Bundle",
  "type": "history",
  "timestamp": "2026-04-30T16:00:00Z",
  "entry": [
    {
      "fullUrl": "urn:uuid:4f0b3c2e-7d6a-4c6b-9b2a-8f1e3d9a2b70",
      "request": { "method": "GET", "url": "Subscription/network-sub-1/$status" },
      "response": { "status": "200" },
      "resource": {
        "resourceType": "SubscriptionStatus",
        "status": "active",
        "type": "event-notification",
        "eventsSinceSubscriptionStart": 1,
        "notificationEvent": [
          {
            "eventNumber": 1,
            "timestamp": "2026-04-30T16:00:00Z",
            "focus": {
              "reference": "urn:uuid:0a7f3c6d-8a24-4f5a-b9d2-13f7d3a6c91e",
              "type": "Parameters"
            }
          }
        ],
        "subscription": {
          "reference": "https://network.example.org/fhir/Subscription/network-sub-1"
        },
        "topic": "https://cms.gov/fhir/SubscriptionTopic/network-activity"
      }
    },
    {
      "fullUrl": "urn:uuid:0a7f3c6d-8a24-4f5a-b9d2-13f7d3a6c91e",
      "request": {
        "method": "GET",
        "url": "urn:uuid:0a7f3c6d-8a24-4f5a-b9d2-13f7d3a6c91e"
      },
      "response": { "status": "200" },
      "resource": {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "activity-id", "valueString": "act-1" },
          { "name": "patient", "valueString": "network-patient-123" },
          {
            "name": "activity-type",
            "valueCoding": {
              "system": "https://cms.gov/fhir/CodeSystem/network-activity-type",
              "code": "activity-detected"
            }
          },
          {
            "name": "activity-type",
            "valueCoding": {
              "system": "https://cms.gov/fhir/CodeSystem/network-activity-type",
              "code": "visit-related"
            }
          },
          { "name": "observed-at", "valueInstant": "2026-04-30T16:00:00Z" },
          { "name": "confidence", "valueCode": "probable" },
          { "name": "activity-handle", "valueString": "ah-9c3m1q8" },
          { "name": "activity-handle-expires", "valueInstant": "2026-04-30T16:15:00Z" }
        ]
      }
    }
  ]
}
```

The client can call documented network discovery/RLS and include
`activity-handle` if that workflow supports it.

### Data Holder Identified

The network may disclose the data holder and a candidate FHIR endpoint.

```json
{
  "resourceType": "Parameters",
  "parameter": [
    { "name": "activity-id", "valueString": "act-2" },
    { "name": "patient", "valueString": "network-patient-123" },
    {
      "name": "activity-type",
      "valueCoding": {
        "system": "https://cms.gov/fhir/CodeSystem/network-activity-type",
        "code": "care-relationship-detected"
      }
    },
    {
      "name": "activity-type",
      "valueCoding": {
        "system": "https://cms.gov/fhir/CodeSystem/network-activity-type",
        "code": "visit-related"
      }
    },
    { "name": "observed-at", "valueInstant": "2026-04-30T17:05:00Z" },
    { "name": "confidence", "valueCode": "confirmed" },
    { "name": "activity-handle", "valueString": "ah-q8v1n6r" },
    {
      "name": "data-holder-organization",
      "resource": {
        "resourceType": "Organization",
        "identifier": [
          { "system": "http://hl7.org/fhir/sid/us-npi", "value": "1234567890" }
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
```

The client verifies the endpoint, authorizes there, and uses the data-holder
patient id returned during authorization for follow-up at that endpoint.

## 8. Delivery and Recovery

Webhook delivery is best effort. Clients should be idempotent and use the
standard subscription event number to notice gaps.

For this MVP, networks SHALL retain activity events for at least 24 hours.
Clients that detect a missed event may use the Subscriptions Backport event
recovery mechanisms if supported. If recovery is not available, the client can
fall back to ordinary network discovery and query connected data-holder
endpoints where it has authorization.

Webhook endpoints SHALL use HTTPS. Networks SHALL echo configured
`Subscription.channel.header` values when delivering notifications. Clients
SHOULD use an unpredictable receiver secret header and reject webhook requests
that do not include it.

## 9. Authorization and Consent

This proposal assumes authorization has already been established before a client
receives a network-scoped access token. That authorization might come from an
authorization-code flow, a permission-ticket flow, or another network-approved
flow.

Activity notifications do not grant data-holder access. Each follow-up request
is authorized at the endpoint receiving that request.

## 10. Conformance Summary

Network Activity Endpoints:

- SHALL support the Network Activity topic.
- SHALL require `patient` filtering.
- MAY support `activity-type` filtering.
- SHALL deliver full-resource R4B Backport notifications as `Bundle.type =
  history`.
- SHALL include `SubscriptionStatus` as the first bundle entry.
- SHALL include one `Parameters` activity signal per event focus.
- SHALL use valid UUIDs in bundle-local `urn:uuid:` fullUrls.
- SHALL include `activity-id`, `patient`, at least one `activity-type`, and
  `observed-at` in every activity signal.
- SHALL treat `activity-id` and `activity-handle` as opaque client-facing values.
- MAY include confidence, activity handle, data-holder organization, and
  data-holder endpoint hints.
- SHALL retain activity events for at least 24 hours.

Clients:

- SHALL treat the activity signal as a hint, not clinical content.
- SHALL treat `activity-id` and `activity-handle` as opaque.
- SHALL pass `activity-handle` only to documented network workflows that support
  it.
- SHALL verify trust and authorize before using a data-holder endpoint.
- SHOULD use event numbers to detect missed notifications.
- SHOULD prefer the most specific useful hint available, while falling back to
  ordinary discovery when needed.

Data-holder FHIR endpoints:

- MAY support the US Core Patient Data Feed topic.
- SHOULD advertise Patient Data Feed support in FHIR `/metadata`.
- SHALL independently authorize reads, searches, and subscriptions.

## References

- [FHIR R4B Subscriptions Backport IG](http://hl7.org/fhir/uv/subscriptions-backport/)
- [US Core Patient Data Feed](https://build.fhir.org/ig/HL7/US-Core/patient-data-feed.html)
- [CMS Health Tech Ecosystem](https://www.cms.gov/health-technology-ecosystem)
