export type FhirInstant = string;
export type Url = string;

export type DetailLevel =
  | "opaque"
  | "source-hinted"
  | "query-hinted"
  | "feed-hinted";

export type ActivityType =
  | "activity-detected"
  | "care-relationship-detected"
  | "source-activity-detected"
  | "feed-available"
  | "capability-changed"
  | (string & {});

export type ActivityConfidence = "confirmed" | "probable" | "possible";

export type ClientActionCode =
  | "rediscover"
  | "query-network"
  | "query-source"
  | "subscribe-source";

export interface NetworkActivitySignal {
  topic: Url;
  activityId: string;
  patient: PatientContext;
  observedAt: FhirInstant;
  activityType: ActivityType;
  detailLevel: DetailLevel;
  confidence?: ActivityConfidence;
  handle?: OpaqueActivityHandle;
  source?: SourceHint;
  activityWindow?: TimeWindow;
  resourceTypes?: FhirResourceType[];
  suggestedActions: SuggestedAction[];
  extensions?: Record<string, unknown>;
}

export interface PatientContext {
  id: string;
  scope: "network" | "client";
  reference?: string;
}

export interface OpaqueActivityHandle {
  value: string;
  expiresAt?: FhirInstant;
  passAs?: HandleBinding[];
}

export interface HandleBinding {
  method: "header" | "query-param" | "body-parameter" | "token-request-parameter";
  name: string;
  appliesTo?: ClientActionCode[];
}

export interface SourceHint {
  organization?: OrganizationHint;
  sourceEndpoint?: Url;
  feedEndpoint?: Url;
}

export interface OrganizationHint {
  identifiers: Identifier[];
  name?: string;
}

export interface Identifier {
  system: Url;
  value: string;
}

export interface TimeWindow {
  start?: FhirInstant;
  end?: FhirInstant;
}

export type FhirResourceType =
  | "Encounter"
  | "Appointment"
  | "Patient"
  | "Location"
  | "Organization"
  | (string & {});

export interface SuggestedAction {
  code: ClientActionCode;
  rank?: number;
  target?: ActionTarget;
  params?: ActionParameters;
}

export interface ActionTarget {
  networkEndpoint?: Url;
  sourceEndpoint?: Url;
  feedEndpoint?: Url;
  organization?: OrganizationHint;
}

export interface ActionParameters {
  activityHandle?: string;
  handleParameter?: string;
  discoveryHint?: string;
  resourceTypes?: FhirResourceType[];
  since?: FhirInstant;
  until?: FhirInstant;
  topic?: Url;
  queryTemplate?: string;
  extensions?: Record<string, unknown>;
}
