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
      endpoint: "https://app.example.org/fhir/network-activity",
      payload: "application/fhir+json",
      header: ["X-Webhook-Secret: client-generated-secret"],
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
      endpoint: `/app/patient-data-feed/${source.id}`,
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
  if (signal.dataHolderOrganization) {
    params.push({
      name: "data-holder-organization",
      resource: {
        resourceType: "Organization",
        identifier: signal.dataHolderOrganization.identifiers,
        name: signal.dataHolderOrganization.name,
      },
    });
  }
  if (signal.dataHolderEndpoint) {
    params.push({ name: "data-holder-endpoint", valueUrl: signal.dataHolderEndpoint });
  }
  signal.followUpRead?.forEach((url) => {
    params.push({ name: "follow-up-read", valueString: url });
  });
  signal.followUpSearch?.forEach((url) => {
    params.push({ name: "follow-up-search", valueString: url });
  });
  if (signal.followUpDiscovery) {
    params.push({ name: "follow-up-discovery", valueString: signal.followUpDiscovery });
  }

  return {
    resourceType: "Parameters",
    parameter: params,
  };
}

export function networkActivityBundle(
  signal: NetworkActivitySignal,
  eventNumber: number,
  subscriptionId: string,
  content: "empty" | "full-resource" = "full-resource",
) {
  return networkActivityEventsBundle([{ signal, eventNumber }], subscriptionId, content);
}

export function networkActivityEventsBundle(
  events: Array<{ signal: NetworkActivitySignal; eventNumber: number }>,
  subscriptionId: string,
  content: "empty" | "full-resource" = "full-resource",
) {
  const latest = events[events.length - 1];
  return {
    resourceType: "Bundle",
    type: "subscription-notification",
    timestamp: latest?.signal.observedAt ?? new Date().toISOString(),
    entry: [
      {
        fullUrl: "urn:uuid:status-1",
        resource: {
          resourceType: "SubscriptionStatus",
          status: "active",
          type: "event-notification",
          eventsSinceSubscriptionStart: latest?.eventNumber ?? 0,
          notificationEvent: events.map(({ signal, eventNumber }) => ({
            eventNumber,
            timestamp: signal.observedAt,
            ...(content === "full-resource"
              ? { focus: { reference: `urn:uuid:activity-${eventNumber}`, type: "Parameters" } }
              : {}),
          })),
          subscription: { reference: `https://network.example.org/fhir/Subscription/${subscriptionId}` },
          topic: NETWORK_ACTIVITY_TOPIC,
        },
      },
      ...(content === "full-resource"
        ? events.map(({ signal, eventNumber }) => ({
            fullUrl: `urn:uuid:activity-${eventNumber}`,
            resource: activityParameters(signal),
          }))
        : []),
    ],
  };
}

export function patientDataFeedBundle(source: SourceRecord, eventNumber: number, resourceType: string, resourceId: string) {
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
          subscription: { reference: `${source.endpoint}/Subscription/sub-${source.id}` },
          topic: PATIENT_DATA_FEED_TOPIC,
        },
      },
    ],
  };
}

export function parseNetworkActivityBundle(bundle: any): NetworkActivitySignal | undefined {
  return parseNetworkActivityBundles(bundle)[0];
}

export function parseNetworkActivityBundles(bundle: any): NetworkActivitySignal[] {
  const paramsResources =
    bundle?.entry
      ?.filter((entry: any) => entry.resource?.resourceType === "Parameters")
      ?.map((entry: any) => entry.resource) ?? [];
  return paramsResources.flatMap((params: any) => {
    const signal = parseActivityParameters(params);
    return signal ? [signal] : [];
  });
}

function parseActivityParameters(params: any): NetworkActivitySignal | undefined {
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
  const dataHolderOrg = first("data-holder-organization")?.resource;
  const dataHolderEndpoint = first("data-holder-endpoint")?.valueUrl;
  const handle = first("activity-handle")?.valueString;
  const followUpRead = (values.get("follow-up-read") ?? []).map((item) => item.valueString);
  const followUpSearch = (values.get("follow-up-search") ?? []).map((item) => item.valueString);
  const followUpDiscovery = first("follow-up-discovery")?.valueString;

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
    dataHolderOrganization: dataHolderOrg
      ? {
          identifiers: dataHolderOrg.identifier ?? [],
          name: dataHolderOrg.name,
        }
      : undefined,
    dataHolderEndpoint,
    followUpRead,
    followUpSearch,
    followUpDiscovery,
  };
}
