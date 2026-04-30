import type {
  ActivityConfidence,
  NetworkActivitySignal,
} from "../../../schema/network-activity";
import { NETWORK_ACTIVITY_TOPIC, PATIENT_DATA_FEED_TOPIC, PATIENT_ID } from "./fixtures";
import type { SourceRecord } from "./types";

export function organization(source: SourceRecord) {
  return {
    resourceType: "Organization",
    identifier: [
      {
        system: "http://hl7.org/fhir/sid/us-npi",
        value: source.npi,
      },
    ],
    name: source.name,
  };
}

export function createNetworkSubscription() {
  return {
    resourceType: "Subscription",
    status: "requested",
    reason: "Notify when patient-relevant network activity is observed",
    criteria: NETWORK_ACTIVITY_TOPIC,
    _criteria: {
      extension: [
        {
          url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
          valueString: `Parameters?patient=${PATIENT_ID}`,
        },
      ],
    },
    channel: {
      type: "rest-hook",
      endpoint: "/app/network-activity",
      payload: "application/fhir+json",
      _payload: {
        extension: [
          {
            url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
            valueCode: "full-resource",
          },
        ],
      },
    },
  };
}

export function createSourceSubscription(source: SourceRecord, patientId: string) {
  return {
    resourceType: "Subscription",
    status: "requested",
    reason: "Notify on encounter and appointment events",
    criteria: PATIENT_DATA_FEED_TOPIC,
    _criteria: {
      extension: [
        {
          url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-filter-criteria",
          valueString: `Encounter?patient=${patientId}`,
        },
      ],
    },
    channel: {
      type: "rest-hook",
      endpoint: `/app/source-feed/${source.id}`,
      payload: "application/fhir+json",
      _payload: {
        extension: [
          {
            url: "http://hl7.org/fhir/uv/subscriptions-backport/StructureDefinition/backport-payload-content",
            valueCode: "id-only",
          },
        ],
      },
    },
  };
}

export function activityParameters(signal: NetworkActivitySignal) {
  const params: unknown[] = [
    { name: "activity-id", valueString: signal.activityId },
    { name: "patient", valueString: signal.patient.id },
    { name: "activity-type", valueCode: signal.activityType },
    { name: "observed-at", valueInstant: signal.observedAt },
  ];

  if (signal.confidence) {
    params.push({ name: "confidence", valueCode: signal.confidence });
  }
  if (signal.handle) {
    params.push({ name: "activity-handle", valueString: signal.handle.value });
    if (signal.handle.expiresAt) {
      params.push({ name: "activity-handle-expires", valueInstant: signal.handle.expiresAt });
    }
  }
  if (signal.source?.organization) {
    params.push({
      name: "source-organization",
      resource: {
        resourceType: "Organization",
        identifier: signal.source.organization.identifiers,
        name: signal.source.organization.name,
      },
    });
  }
  if (signal.source?.sourceEndpoint) {
    params.push({ name: "source-endpoint", valueUrl: signal.source.sourceEndpoint });
  }
  if (signal.source?.feedEndpoint) {
    params.push({ name: "feed-endpoint", valueUrl: signal.source.feedEndpoint });
  }
  if (signal.feedTopic) {
    params.push({ name: "feed-topic", valueUrl: signal.feedTopic });
  }
  if (signal.targetResource) {
    params.push({
      name: "target-resource",
      valueReference: {
        reference: signal.targetResource.reference,
        type: signal.targetResource.type,
        display: signal.targetResource.display,
      },
    });
    if (signal.targetResource.url) {
      params.push({ name: "target-url", valueUrl: signal.targetResource.url });
    }
  }
  signal.sourceQueries?.forEach((query) => {
    params.push({ name: "source-query", valueString: query.urlTemplate });
  });
  signal.resourceTypes?.forEach((resourceType) => {
    params.push({ name: "resource-type", valueCode: resourceType });
  });
  if (signal.activityWindow?.start) {
    params.push({ name: "activity-window-start", valueInstant: signal.activityWindow.start });
  }
  if (signal.activityWindow?.end) {
    params.push({ name: "activity-window-end", valueInstant: signal.activityWindow.end });
  }

  return {
    resourceType: "Parameters",
    parameter: params,
  };
}

export function networkActivityBundle(signal: NetworkActivitySignal, eventNumber: number, subscriptionId: string) {
  return {
    resourceType: "Bundle",
    type: "subscription-notification",
    timestamp: signal.observedAt,
    entry: [
      {
        fullUrl: "urn:uuid:status-1",
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          eventsSinceSubscriptionStart: eventNumber,
          notificationEvent: [
            {
              eventNumber,
              timestamp: signal.observedAt,
              focus: { reference: "urn:uuid:activity-1", type: "Parameters" },
            },
          ],
          subscription: { reference: `https://network.example.org/fhir/Subscription/${subscriptionId}` },
          topic: NETWORK_ACTIVITY_TOPIC,
        },
      },
      {
        fullUrl: "urn:uuid:activity-1",
        resource: activityParameters(signal),
      },
    ],
  };
}

export function sourceFeedBundle(source: SourceRecord, eventNumber: number, resourceType: string, resourceId: string) {
  return {
    resourceType: "Bundle",
    type: "subscription-notification",
    timestamp: new Date().toISOString(),
    entry: [
      {
        fullUrl: "urn:uuid:source-status-1",
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          eventsSinceSubscriptionStart: eventNumber,
          notificationEvent: [
            {
              eventNumber,
              timestamp: new Date().toISOString(),
              focus: {
                reference: `${source.endpoint}/${resourceType}/${resourceId}`,
                type: resourceType,
              },
            },
          ],
          subscription: { reference: `${source.feedEndpoint}/Subscription/sub-${source.id}` },
          topic: PATIENT_DATA_FEED_TOPIC,
        },
      },
    ],
  };
}

export function parseNetworkActivityBundle(bundle: any): NetworkActivitySignal | undefined {
  const params = bundle?.entry?.find((entry: any) => entry.resource?.resourceType === "Parameters")?.resource;
  if (!params?.parameter) {
    return undefined;
  }

  const values = new Map<string, any[]>();
  for (const parameter of params.parameter) {
    const entries = values.get(parameter.name) ?? [];
    entries.push(parameter);
    values.set(parameter.name, entries);
  }

  const first = (name: string) => values.get(name)?.[0];
  const sourceOrg = first("source-organization")?.resource;
  const sourceEndpoint = first("source-endpoint")?.valueUrl;
  const feedEndpoint = first("feed-endpoint")?.valueUrl;
  const feedTopic = first("feed-topic")?.valueUrl;
  const targetResource = first("target-resource")?.valueReference;
  const targetUrl = first("target-url")?.valueUrl;
  const start = first("activity-window-start")?.valueInstant;
  const end = first("activity-window-end")?.valueInstant;
  const handle = first("activity-handle")?.valueString;
  const sourceQueries = (values.get("source-query") ?? []).map((item) => ({
    urlTemplate: item.valueString,
  }));

  return {
    topic: NETWORK_ACTIVITY_TOPIC,
    activityId: first("activity-id")?.valueString,
    patient: { id: first("patient")?.valueString, scope: "network" },
    observedAt: first("observed-at")?.valueInstant,
    activityType: first("activity-type")?.valueCode,
    confidence: first("confidence")?.valueCode as ActivityConfidence | undefined,
    handle: handle
      ? {
          value: handle,
          expiresAt: first("activity-handle-expires")?.valueInstant,
        }
      : undefined,
    source:
      sourceOrg || sourceEndpoint || feedEndpoint
        ? {
            organization: sourceOrg
              ? {
                  identifiers: sourceOrg.identifier ?? [],
                  name: sourceOrg.name,
                }
              : undefined,
            sourceEndpoint,
            feedEndpoint,
          }
        : undefined,
    targetResource: targetResource
      ? {
          reference: targetResource.reference,
          type: targetResource.type,
          url: targetUrl,
          display: targetResource.display,
        }
      : undefined,
    sourceQueries,
    feedTopic,
    activityWindow: start || end ? { start, end } : undefined,
    resourceTypes: (values.get("resource-type") ?? []).map((item) => item.valueCode),
  };
}
