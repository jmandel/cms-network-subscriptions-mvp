export type FhirInstant = string;
export type Url = string;

export const CMS_ACTIVITY_TYPE_SYSTEM = "https://cms.gov/fhir/CodeSystem/network-activity-type";

export type CmsActivityTypeCode =
  | "activity-detected"
  | "care-relationship-detected"
  | "data-holder-activity-detected"
  | "visit-related"
  | "diagnostic-related"
  | "document-related"
  | "medication-related"
  | (string & {});

export type ActivityConfidence = "confirmed" | "probable" | "possible";

export interface Coding {
  system?: Url;
  code: CmsActivityTypeCode;
  display?: string;
}

export interface NetworkActivitySignal {
  topic: Url;
  activityId: string;
  patient: PatientContext;
  observedAt: FhirInstant;
  activityType: Coding[];
  confidence?: ActivityConfidence;
  activityHandle?: OpaqueActivityHandle;
  dataHolderOrganization?: OrganizationHint;
  dataHolderEndpoint?: Url;
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

export interface OrganizationHint {
  identifiers: Identifier[];
  name?: string;
}

export interface Identifier {
  system: Url;
  value: string;
}
