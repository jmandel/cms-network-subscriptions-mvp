export type FhirInstant = string;
export type Url = string;

export type ActivityType =
  | "activity-detected"
  | "care-relationship-detected"
  | "data-holder-activity-detected"
  | "data-holder-resource-detected"
  | (string & {});

export type ActivityConfidence = "confirmed" | "probable" | "possible";

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

export interface PatientContext {
  id: string;
  scope: "network" | "client";
  reference?: string;
}

export interface OpaqueActivityHandle {
  value: string;
  expiresAt?: FhirInstant;
}

export type UrlTemplate = string;

export interface OrganizationHint {
  identifiers: Identifier[];
  name?: string;
}

export interface Identifier {
  system: Url;
  value: string;
}
