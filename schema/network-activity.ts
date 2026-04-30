export type FhirInstant = string;
export type Url = string;

export type ActivityType =
  | "activity-detected"
  | "care-relationship-detected"
  | "source-activity-detected"
  | "source-resource-detected"
  | "feed-available"
  | "capability-changed"
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
  source?: SourceHint;
  targetResource?: TargetResourceHint;
  sourceQueries?: SourceQueryHint[];
  feedTopic?: Url;
  activityWindow?: TimeWindow;
  resourceTypes?: FhirResourceType[];
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

export interface SourceHint {
  organization?: OrganizationHint;
  sourceEndpoint?: Url;
}

export interface TargetResourceHint {
  reference: string;
  type?: FhirResourceType;
  url?: Url;
  display?: string;
}

export interface SourceQueryHint {
  urlTemplate: string;
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
