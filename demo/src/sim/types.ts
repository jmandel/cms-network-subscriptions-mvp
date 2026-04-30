import type { NetworkActivitySignal } from "../../../schema/network-activity";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ActorId =
  | "simulation"
  | "client"
  | "network"
  | "rls"
  | "data-holder";

export type TraceKind =
  | "request"
  | "response"
  | "webhook"
  | "state-change"
  | "decision"
  | "error";

export interface SimRequest {
  id: string;
  from: ActorId;
  to: ActorId;
  method: HttpMethod;
  url: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body?: unknown;
  correlationId?: string;
}

export interface SimResponse {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface TraceEvent {
  id: string;
  at: string;
  kind: TraceKind;
  actor?: ActorId;
  request?: SimRequest;
  response?: SimResponse;
  summary: string;
  details?: unknown;
  correlationId?: string;
}

export interface RouteHandler {
  actor: ActorId;
  method: HttpMethod;
  pathPattern: string;
  handle(request: SimRequest, context: SimContext): SimResponse;
}

export interface SimContext {
  send(input: SendInput): SimResponse;
  trace(event: Omit<TraceEvent, "id" | "at">): void;
  state: SimulationState;
}

export interface SendInput {
  from: ActorId;
  to: ActorId;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  correlationId?: string;
  kind?: TraceKind;
  summary?: string;
}

export type DisclosurePolicy =
  | "opaque"
  | "data-holder-organization"
  | "data-holder-endpoint";

export type ScenarioId =
  | "bootstrap"
  | "opaque-rls"
  | "endpoint-hinted"
  | "known-data-holder"
  | "read-hinted"
  | "patient-data-feed"
  | "missed-activity"
  | "sensitive-data-holder";

export interface SourceFixture {
  id: string;
  name: string;
  npi: string;
  kind: string;
  sensitive: boolean;
  supportsQuery: boolean;
  supportsFeed: boolean;
  endpoint: string;
  patientId: string;
}

export interface SourceRecord extends SourceFixture {
  feedEnabled: boolean;
}

export interface KnownSource {
  id: string;
  name: string;
  endpoint?: string;
  discoveredBy: string;
}

export interface FeedSubscription {
  id: string;
  sourceId: string;
  topic: string;
  endpoint: string;
  status: "requested" | "active" | "off";
}

export interface PendingAction {
  signal: NetworkActivitySignal;
  action: SuggestedActionView;
}

export interface PendingRead {
  sourceId: string;
  resourceType: "Encounter" | "Appointment";
  id: string;
  correlationId: string;
}

export interface SuggestedActionView {
  code: string;
  resourceType?: string;
  resourceId?: string;
  url?: string;
  followUpSearch?: string;
  followUpDiscovery?: string;
}

export interface SimulationState {
  app: {
    patientId: string;
    networkToken?: string;
    networkSubscriptionId?: string;
    knownSources: Record<string, KnownSource>;
    feedSubscriptions: Record<string, FeedSubscription>;
    sourceTokens: Record<string, { token: string; patient: string }>;
    lastNetworkEventNumber: number;
    seenActivityIds: string[];
    pendingActions: PendingAction[];
    pendingReads: PendingRead[];
    decisions: string[];
  };
  network: {
    disclosurePolicy: DisclosurePolicy;
    eventCounter: number;
    subscriptionEndpoint?: string;
    subscriptionId?: string;
    dropNextWebhook: boolean;
    handles: Record<string, { sourceId: string; patientId: string; createdAt: string }>;
    events: Record<number, { eventNumber: number; signal: NetworkActivitySignal; createdAt: string }>;
  };
  sources: Record<string, SourceRecord>;
  resources: Record<string, Record<string, unknown[]>>;
  trace: TraceEvent[];
}

export interface Snapshot {
  state: SimulationState;
  selectedTraceId?: string;
}
