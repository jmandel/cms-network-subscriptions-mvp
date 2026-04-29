import type {
  ActivityConfidence,
  DetailLevel,
  NetworkActivitySignal,
  SuggestedAction,
} from "../../../schema/network-activity";
import { NETWORK_ACTIVITY_TOPIC, PATIENT_DATA_FEED_TOPIC, PATIENT_ID } from "./fixtures";
import type { SourceRecord, SuggestedActionView } from "./types";

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
    { name: "detail-level", valueCode: signal.detailLevel },
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
  signal.resourceTypes?.forEach((resourceType) => {
    params.push({ name: "resource-type", valueCode: resourceType });
  });
  if (signal.activityWindow?.start) {
    params.push({ name: "activity-window-start", valueInstant: signal.activityWindow.start });
  }
  if (signal.activityWindow?.end) {
    params.push({ name: "activity-window-end", valueInstant: signal.activityWindow.end });
  }
  signal.suggestedActions.forEach((action) => {
    const part: unknown[] = [
      { name: "code", valueCode: action.code },
      { name: "rank", valueInteger: action.rank ?? 1 },
    ];
    Object.entries(action.target ?? {}).forEach(([key, value]) => {
      if (typeof value === "string") {
        part.push({ name: kebab(key), valueUrl: value });
      }
    });
    if (action.target?.organization) {
      part.push({
        name: "source-organization",
        resource: {
          resourceType: "Organization",
          identifier: action.target.organization.identifiers,
          name: action.target.organization.name,
        },
      });
    }
    Object.entries(action.params ?? {}).forEach(([key, value]) => {
      const name = kebab(key);
      if (Array.isArray(value)) {
        value.forEach((item) => part.push({ name, valueCode: item }));
      } else if (typeof value === "string") {
        if (name.endsWith("endpoint") || name === "topic") {
          part.push({ name, valueUrl: value });
        } else if (name === "since" || name === "until") {
          part.push({ name, valueInstant: value });
        } else {
          part.push({ name, valueString: value });
        }
      }
    });
    params.push({ name: "suggested-action", part });
  });

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
  const actions = (values.get("suggested-action") ?? []).map(parseAction);
  const sourceOrg = first("source-organization")?.resource;
  const sourceEndpoint = first("source-endpoint")?.valueUrl;
  const feedEndpoint = first("feed-endpoint")?.valueUrl;
  const start = first("activity-window-start")?.valueInstant;
  const end = first("activity-window-end")?.valueInstant;
  const handle = first("activity-handle")?.valueString;

  return {
    topic: NETWORK_ACTIVITY_TOPIC,
    activityId: first("activity-id")?.valueString,
    patient: { id: first("patient")?.valueString, scope: "network" },
    observedAt: first("observed-at")?.valueInstant,
    activityType: first("activity-type")?.valueCode,
    detailLevel: first("detail-level")?.valueCode as DetailLevel,
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
    activityWindow: start || end ? { start, end } : undefined,
    resourceTypes: (values.get("resource-type") ?? []).map((item) => item.valueCode),
    suggestedActions: actions as SuggestedAction[],
  };
}

export function parseAction(parameter: any): SuggestedActionView {
  const target: Record<string, string> = {};
  const params: Record<string, string | string[]> = {};
  let code = "rediscover";
  let rank = 1;
  for (const part of parameter.part ?? []) {
    const value = part.valueCode ?? part.valueString ?? part.valueUrl ?? part.valueInstant ?? part.valueInteger;
    if (part.name === "code") {
      code = String(value);
    } else if (part.name === "rank") {
      rank = Number(value);
    } else if (part.name.includes("endpoint")) {
      target[camel(part.name)] = String(value);
    } else if (part.name === "topic") {
      params.topic = String(value);
    } else if (part.name === "resource-type") {
      const existing = params.resourceTypes;
      params.resourceTypes = Array.isArray(existing) ? [...existing, String(value)] : [String(value)];
    } else {
      params[camel(part.name)] = String(value);
    }
  }
  return { code, rank, target, params };
}

function kebab(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function camel(value: string) {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
