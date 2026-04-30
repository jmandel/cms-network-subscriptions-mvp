import type { NetworkActivitySignal } from "../../../schema/network-activity";
import {
  NETWORK_ACTIVITY_TOPIC,
  PATIENT_DATA_FEED_TOPIC,
  PATIENT_ID,
  createInitialState,
} from "./fixtures";
import {
  createNetworkSubscription,
  createSourceSubscription,
  networkActivityBundle,
  organization,
  patientDataFeedBundle,
  parseNetworkActivityBundle,
} from "./fhir";
import { SimKernel } from "./kernel";
import type {
  DisclosurePolicy,
  ScenarioId,
  SimRequest,
  SimResponse,
  SimulationState,
  Snapshot,
  SourceRecord,
  SuggestedActionView,
} from "./types";

function json(request: SimRequest, status: number, body: unknown): SimResponse {
  return {
    requestId: request.id,
    status,
    headers: { "content-type": "application/json" },
    body,
  };
}

function pathPart(path: string, index: number) {
  return path.split("/").filter(Boolean)[index];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function opaqueToken(prefix: string, eventNumber: number) {
  const mixed = Math.imul(eventNumber + 0x9e3779b9, 0x85ebca6b) >>> 0;
  return `${prefix}-${mixed.toString(36).padStart(7, "0")}`;
}

type ActivityHintLevel = "opaque" | "organization-hinted" | "search-hinted" | "read-hinted" | "subscription-hinted";

const ACTIVITY_WINDOW_START = "2026-04-29T15:00:00Z";

function hintLevelForSignal(signal: NetworkActivitySignal): ActivityHintLevel {
  if (signal.followUpRead?.length) return "read-hinted";
  if (signal.followUpSearch?.length) return "search-hinted";
  if (signal.followUpSubscribe?.length && signal.dataHolderEndpoint) return "subscription-hinted";
  if (signal.dataHolderOrganization) return "organization-hinted";
  return "opaque";
}

export class NetworkActivitySimulation {
  readonly state: SimulationState;
  private readonly kernel: SimKernel;

  constructor() {
    this.state = createInitialState();
    this.kernel = new SimKernel(this.state);
    this.registerRoutes();
  }

  snapshot(): Snapshot {
    return { state: clone(this.state) };
  }

  setDisclosurePolicy(policy: DisclosurePolicy) {
    this.state.network.disclosurePolicy = policy;
    this.kernel.trace({
      kind: "state-change",
      actor: "network",
      summary: `Network disclosure policy set to ${policy}`,
      details: { policy },
    });
  }

  setSourceFeedEnabled(sourceId: string, enabled: boolean) {
    this.state.sources[sourceId].feedEnabled = enabled;
    this.kernel.trace({
      kind: "state-change",
      actor: "data-holder",
      summary: `${this.state.sources[sourceId].name} feed ${enabled ? "enabled" : "disabled"}`,
      details: { sourceId, enabled },
    });
  }

  clearTrace() {
    this.state.trace.length = 0;
  }

  bootstrap() {
    if (this.state.app.networkSubscriptionId) {
      this.kernel.trace({
        kind: "decision",
        actor: "client",
        summary: "Bootstrap already complete",
        details: { subscriptionId: this.state.app.networkSubscriptionId },
      });
      return;
    }

    const token = this.kernel.send({
      from: "client",
      to: "network",
      method: "POST",
      path: "/network/token",
      headers: { "content-type": "application/json" },
      body: { client_id: "health-app", patient: PATIENT_ID },
      summary: "Authorize at network",
    });
    const tokenBody = token.body as { access_token: string; patient: string };
    this.state.app.networkToken = tokenBody.access_token;
    this.state.app.patientId = tokenBody.patient;

    const subscription = this.kernel.send({
      from: "client",
      to: "network",
      method: "POST",
      path: "/network/fhir/Subscription",
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/fhir+json",
      },
      body: createNetworkSubscription(),
      summary: "Create network activity subscription",
    });
    const subscriptionBody = subscription.body as { id: string };
    this.state.app.networkSubscriptionId = subscriptionBody.id;
  }

  runScenario(id: ScenarioId) {
    if (id === "bootstrap") {
      this.bootstrap();
      return;
    }

    this.bootstrap();

    if (id === "opaque-rls") {
      this.setDisclosurePolicy("opaque");
      this.injectNetworkEvent("mercy", "activity-detected", "probable");
      this.processPendingActions();
    }

    if (id === "subscription-hinted") {
      this.setDisclosurePolicy("follow-up-subscribe");
      this.injectNetworkEvent("valley", "care-relationship-detected", "confirmed");
      this.processPendingActions();
    }

    if (id === "known-data-holder") {
      this.setDisclosurePolicy("data-holder-endpoint");
      this.learnSource(this.state.sources.valley, "seeded app state");
      this.injectNetworkEvent("valley", "data-holder-activity-detected", "confirmed");
      this.processPendingActions();
    }

    if (id === "read-hinted") {
      this.setDisclosurePolicy("data-holder-endpoint");
      this.injectNetworkEvent("mercy", "data-holder-resource-detected", "confirmed", "https://network.example.org/fhir/data-holders/mercy/Encounter/enc-mercy-1");
      this.processPendingActions();
    }

    if (id === "patient-data-feed") {
      if (!this.state.app.feedSubscriptions.valley) {
        this.setDisclosurePolicy("follow-up-subscribe");
        this.injectNetworkEvent("valley", "care-relationship-detected", "confirmed");
        this.processPendingActions();
      }
      this.injectSourceEvent("valley", "Encounter", "enc-valley-1");
      this.processPendingReads();
    }

    if (id === "missed-activity") {
      this.setDisclosurePolicy("opaque");
      this.state.network.dropNextWebhook = true;
      this.injectNetworkEvent("valley", "activity-detected", "probable");
      this.processPendingActions();
      this.injectNetworkEvent("mercy", "activity-detected", "probable");
      this.processPendingActions();
    }

    if (id === "sensitive-data-holder") {
      this.setDisclosurePolicy("follow-up-subscribe");
      this.injectNetworkEvent("northside", "activity-detected", "possible");
      this.processPendingActions();
    }
  }

  injectNetworkEvent(
    sourceId: string,
    activityType = "activity-detected",
    confidence: NetworkActivitySignal["confidence"] = "confirmed",
    followUpRead?: string,
  ) {
    this.kernel.send({
      from: "simulation",
      to: "network",
      method: "POST",
      path: "/network/internal/events",
      headers: { "content-type": "application/json" },
      body: { sourceId, activityType, confidence, followUpRead },
      summary: `Simulate ${activityType} at ${this.state.sources[sourceId].name}`,
    });
  }

  injectSourceEvent(sourceId: string, resourceType: "Encounter" | "Appointment", id: string) {
    this.kernel.send({
      from: "simulation",
      to: "data-holder",
      method: "POST",
      path: `/data-holders/${sourceId}/internal/events`,
      headers: { "content-type": "application/json" },
      body: { resourceType, id },
      summary: `Simulate Patient Data Feed ${resourceType} at ${this.state.sources[sourceId].name}`,
    });
  }

  processPendingActions() {
    while (this.state.app.pendingActions.length > 0) {
      const pending = this.state.app.pendingActions.shift();
      if (!pending) {
        return;
      }
      const { signal, action } = pending;
      this.state.app.decisions.unshift(`Follow ${action.code} for ${signal.activityId}`);
      this.kernel.trace({
        kind: "decision",
        actor: "client",
        summary: `Client follows ${action.code}`,
        details: { signal, action },
      });

      if (action.code === "read-data-holder") {
        const source = this.sourceFromSignal(signal);
        if (!source || !action.resourceType || !action.resourceId) {
          this.traceDecision("No specific data-holder resource available for read-data-holder", { signal, action });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const response = this.kernel.send({
          from: "client",
          to: "data-holder",
          method: "GET",
          path: `/data-holders/${source.id}/fhir/${action.resourceType}/${action.resourceId}`,
          headers: { authorization: `Bearer ${token.token}` },
          correlationId: signal.activityId,
          summary: `Run follow-up-read`,
        });
        this.learnSource(source, "follow-up-read");
        this.kernel.trace({
          kind: "state-change",
          actor: "client",
          summary: `Client read hinted ${action.resourceType}/${action.resourceId}`,
          details: response.body,
          correlationId: signal.activityId,
        });
      }

      if (action.code === "rediscover") {
        const response = this.kernel.send({
          from: "client",
          to: "rls",
          method: "POST",
          path: "/network/rls/search",
          headers: { "content-type": "application/json" },
          body: {
            patient: signal.patient.id,
            activityHandle: signal.handle?.value,
          },
          correlationId: signal.activityId,
          summary: "Run RLS discovery",
        });
        this.learnSourcesFromResponse(response, "RLS");
      }

      if (action.code === "query-network") {
        const response = this.kernel.send({
          from: "client",
          to: "rls",
          method: "POST",
          path: "/network/fhir/$resolve-activity",
          headers: { "content-type": "application/fhir+json" },
          body: {
            resourceType: "Parameters",
            parameter: [{ name: "activity-handle", valueString: signal.handle?.value }],
          },
          correlationId: signal.activityId,
          summary: "Resolve activity at network",
        });
        this.learnSourcesFromResponse(response, "network query");
      }

      if (action.code === "search-data-holder") {
        const source = this.sourceFromSignal(signal);
        if (!source || !action.followUpSearch) {
          this.traceDecision("No explicit follow-up-search available", { signal, action });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const path = renderFollowUpPath(source, action.followUpSearch, token.patient, signal.handle?.value);
        const response = this.kernel.send({
          from: "client",
          to: "data-holder",
          method: "GET",
          path,
          headers: { authorization: `Bearer ${token.token}` },
          correlationId: signal.activityId,
          summary: `Run follow-up-search`,
        });
        this.learnSource(source, "follow-up-search");
        this.kernel.trace({
          kind: "state-change",
          actor: "client",
          summary: `Client received ${bundleCount(response.body)} data-holder resources`,
          details: response.body,
          correlationId: signal.activityId,
        });
      }

      if (action.code === "subscribe-data-holder") {
        const source = this.sourceFromSignal(signal);
        if (!source) {
          this.traceDecision("No data-holder FHIR endpoint available for subscribe-data-holder", { signal });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const response = this.kernel.send({
          from: "client",
          to: "data-holder",
          method: "POST",
          path: `/data-holders/${source.id}/fhir/Subscription`,
          headers: {
            authorization: `Bearer ${token.token}`,
            "content-type": "application/fhir+json",
          },
          body: createSourceSubscription(source, token.patient),
          correlationId: signal.activityId,
          summary: `Create ${source.name} Patient Data Feed subscription`,
        });
        const body = response.body as { id: string; status: "active" };
        this.state.app.feedSubscriptions[source.id] = {
          id: body.id,
          sourceId: source.id,
          topic: PATIENT_DATA_FEED_TOPIC,
          endpoint: source.endpoint,
          status: body.status,
        };
        this.learnSource(source, "follow-up-subscribe");
      }
    }
  }

  processPendingReads() {
    while (this.state.app.pendingReads.length > 0) {
      const read = this.state.app.pendingReads.shift();
      if (!read) {
        return;
      }
      const source = this.state.sources[read.sourceId];
      const token = this.ensureSourceToken(source);
      const response = this.kernel.send({
        from: "client",
        to: "data-holder",
        method: "GET",
        path: `/data-holders/${source.id}/fhir/${read.resourceType}/${read.id}`,
        headers: { authorization: `Bearer ${token.token}` },
        correlationId: read.correlationId,
        summary: `Read ${read.resourceType}/${read.id}`,
      });
      this.kernel.trace({
        kind: "state-change",
        actor: "client",
        summary: `Client read ${read.resourceType}/${read.id}`,
        details: response.body,
        correlationId: read.correlationId,
      });
    }
  }

  private registerRoutes() {
    this.kernel.register({
      actor: "network",
      method: "POST",
      pathPattern: "/network/token",
      handle: (request) =>
        json(request, 200, {
          access_token: "network-token-123",
          token_type: "bearer",
          expires_in: 3600,
          scope: "system/Subscription.crud",
          patient: PATIENT_ID,
        }),
    });

    this.kernel.register({
      actor: "network",
      method: "POST",
      pathPattern: "/network/fhir/Subscription",
      handle: (request, context) => {
        context.state.network.subscriptionId = "network-sub-1";
        context.state.network.subscriptionEndpoint = "/app/network-activity";
        context.trace({
          kind: "state-change",
          actor: "network",
          summary: "Network activity subscription active",
          details: request.body,
        });
        return json(request, 201, {
          ...(request.body as object),
          id: "network-sub-1",
          status: "active",
        });
      },
    });

    this.kernel.register({
      actor: "network",
      method: "GET",
      pathPattern: "/network/fhir/Subscription/:id",
      handle: (request) =>
        json(request, 200, {
          resourceType: "Subscription",
          id: pathPart(request.path, 2),
          status: "active",
        }),
    });

    this.kernel.register({
      actor: "network",
      method: "POST",
      pathPattern: "/network/internal/events",
      handle: (request, context) => {
        const body = request.body as {
          sourceId: string;
          activityType: string;
          confidence: NetworkActivitySignal["confidence"];
          followUpRead?: string;
        };
        const source = context.state.sources[body.sourceId];
        context.state.network.eventCounter += 1;
        const eventNumber = context.state.network.eventCounter;
        const handle = opaqueToken("ah", eventNumber);
        context.state.network.handles[handle] = {
          sourceId: source.id,
          patientId: PATIENT_ID,
          createdAt: new Date().toISOString(),
        };
        const signal = this.buildSignal(source, eventNumber, handle, body.activityType, body.confidence, body.followUpRead);
        const bundle = networkActivityBundle(signal, eventNumber, context.state.network.subscriptionId ?? "network-sub-1");

        if (context.state.network.dropNextWebhook) {
          context.state.network.dropNextWebhook = false;
          context.trace({
            kind: "error",
            actor: "network",
            summary: `Dropped webhook for event ${eventNumber}`,
            details: { eventNumber, signal },
          });
          return json(request, 202, { accepted: true, dropped: true, eventNumber });
        }

        context.send({
          from: "network",
          to: "client",
          method: "POST",
          path: "/app/network-activity",
          headers: { "content-type": "application/fhir+json" },
          body: bundle,
          kind: "webhook",
          correlationId: signal.activityId,
          summary: `Deliver network activity ${hintLevelForSignal(signal)}`,
        });
        return json(request, 202, { accepted: true, delivered: true, eventNumber });
      },
    });

    this.kernel.register({
      actor: "client",
      method: "POST",
      pathPattern: "/app/network-activity",
      handle: (request, context) => {
        const signal = parseNetworkActivityBundle(request.body);
        const status = (request.body as any)?.entry?.[0]?.resource;
        const eventNumber = Number(status?.notificationEvent?.[0]?.eventNumber ?? 0);
        if (eventNumber > context.state.app.lastNetworkEventNumber + 1) {
          context.trace({
            kind: "decision",
            actor: "client",
            summary: `Detected network event gap before ${eventNumber}`,
            details: {
              previous: context.state.app.lastNetworkEventNumber,
              received: eventNumber,
            },
          });
          context.state.app.pendingActions.push({
            signal: {
              topic: NETWORK_ACTIVITY_TOPIC,
              activityId: `recovery-${eventNumber}`,
              patient: { id: PATIENT_ID, scope: "network" },
              observedAt: new Date().toISOString(),
              activityType: "activity-detected",
            },
            action: {
              code: "rediscover",
            },
          });
        }
        context.state.app.lastNetworkEventNumber = Math.max(context.state.app.lastNetworkEventNumber, eventNumber);

        if (!signal) {
          return json(request, 400, { error: "Missing Parameters focus" });
        }
        if (context.state.app.seenActivityIds.includes(signal.activityId)) {
          context.trace({
            kind: "decision",
            actor: "client",
            summary: `Ignored duplicate ${signal.activityId}`,
            details: signal,
          });
          return json(request, 202, { accepted: true, duplicate: true });
        }
        context.state.app.seenActivityIds.push(signal.activityId);
        const action = this.chooseAction(signal);
        context.state.app.pendingActions.push({ signal, action });
        context.trace({
          kind: "decision",
          actor: "client",
          summary: `Queued ${action.code} for ${signal.activityId}`,
          details: { signal, action },
        });
        return json(request, 202, { accepted: true });
      },
    });

    this.kernel.register({
      actor: "rls",
      method: "POST",
      pathPattern: "/network/rls/search",
      handle: (request, context) => json(request, 200, this.resolveSources(request.body, context.state, "RLS")),
    });

    this.kernel.register({
      actor: "rls",
      method: "POST",
      pathPattern: "/network/fhir/$resolve-activity",
      handle: (request, context) => json(request, 200, this.resolveSources(request.body, context.state, "network-query")),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "POST",
      pathPattern: "/data-holders/:sourceId/token",
      handle: (request, context) => {
        const source = context.state.sources[pathPart(request.path, 1)];
        return json(request, 200, {
          access_token: `data-holder-token-${source.id}`,
          token_type: "bearer",
          expires_in: 3600,
          scope: "patient/Encounter.r patient/Appointment.r system/Subscription.crud",
          patient: source.patientId,
        });
      },
    });

    this.kernel.register({
      actor: "data-holder",
      method: "GET",
      pathPattern: "/data-holders/:sourceId/fhir/Encounter",
      handle: (request, context) => this.queryResources(request, context.state, "Encounter"),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "GET",
      pathPattern: "/data-holders/:sourceId/fhir/Appointment",
      handle: (request, context) => this.queryResources(request, context.state, "Appointment"),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "GET",
      pathPattern: "/data-holders/:sourceId/fhir/Encounter/:id",
      handle: (request, context) => this.readResource(request, context.state, "Encounter"),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "GET",
      pathPattern: "/data-holders/:sourceId/fhir/Appointment/:id",
      handle: (request, context) => this.readResource(request, context.state, "Appointment"),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "POST",
      pathPattern: "/data-holders/:sourceId/fhir/Subscription",
      handle: (request, context) => {
        const source = context.state.sources[pathPart(request.path, 1)];
        if (!source.feedEnabled) {
          return json(request, 400, { error: "Patient Data Feed not enabled", source: source.name });
        }
        return json(request, 201, {
          ...(request.body as object),
          id: `sub-${source.id}`,
          status: "active",
        });
      },
    });

    this.kernel.register({
      actor: "data-holder",
      method: "GET",
      pathPattern: "/data-holders/:sourceId/fhir/Subscription/:id",
      handle: (request) =>
        json(request, 200, {
          resourceType: "Subscription",
          id: pathPart(request.path, 4),
          status: "active",
        }),
    });

    this.kernel.register({
      actor: "data-holder",
      method: "POST",
      pathPattern: "/data-holders/:sourceId/internal/events",
      handle: (request, context) => {
        const source = context.state.sources[pathPart(request.path, 1)];
        const body = request.body as { resourceType: "Encounter" | "Appointment"; id: string };
        const eventNumber = Object.keys(context.state.app.feedSubscriptions).length + context.state.network.eventCounter + 1;
        const bundle = patientDataFeedBundle(source, eventNumber, body.resourceType, body.id);
        context.send({
          from: "data-holder",
          to: "client",
          method: "POST",
          path: `/app/patient-data-feed/${source.id}`,
          headers: { "content-type": "application/fhir+json" },
          body: bundle,
          kind: "webhook",
          correlationId: `source-${source.id}-${body.id}`,
          summary: `Deliver ${source.name} ${body.resourceType} notification`,
        });
        return json(request, 202, { accepted: true, delivered: true });
      },
    });

    this.kernel.register({
      actor: "client",
      method: "POST",
      pathPattern: "/app/patient-data-feed/:sourceId",
      handle: (request, context) => {
        const sourceId = pathPart(request.path, 2);
        const status = (request.body as any)?.entry?.[0]?.resource;
        const focus = status?.notificationEvent?.[0]?.focus;
        const referenceParts = String(focus?.reference ?? "").split("/");
        const id = referenceParts[referenceParts.length - 1];
        if (id && focus?.type) {
          context.state.app.pendingReads.push({
            sourceId,
            resourceType: focus.type,
            id,
            correlationId: request.correlationId ?? `source-${sourceId}-${id}`,
          });
          context.trace({
            kind: "decision",
            actor: "client",
            summary: `Queued read for ${focus.type}/${id}`,
            details: request.body,
          });
        }
        return json(request, 202, { accepted: true });
      },
    });
  }

  private buildSignal(
    source: SourceRecord,
    eventNumber: number,
    handle: string,
    activityType: string,
    confidence: NetworkActivitySignal["confidence"],
    followUpRead?: string,
  ): NetworkActivitySignal {
    const effectivePolicy: DisclosurePolicy = source.sensitive ? "opaque" : this.state.network.disclosurePolicy;
    const requestedRead = followUpRead;
    const hintLevel = this.hintLevelFor(source, effectivePolicy, requestedRead);
    const signal: NetworkActivitySignal = {
      topic: NETWORK_ACTIVITY_TOPIC,
      activityId: opaqueToken("act", eventNumber),
      patient: { id: PATIENT_ID, scope: "network" },
      observedAt: new Date().toISOString(),
      activityType,
      confidence,
      handle: {
        value: handle,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
    };

    if (hintLevel !== "opaque") {
      signal.dataHolderOrganization = { identifiers: organization(source).identifier, name: source.name };
    }
    if (hintLevel === "search-hinted" || hintLevel === "read-hinted" || hintLevel === "subscription-hinted") {
      signal.dataHolderEndpoint = source.endpoint;
    }
    if (hintLevel === "read-hinted" && requestedRead) {
      signal.followUpRead = [requestedRead];
      const target = resourceFromUrl(requestedRead);
      signal.resourceTypes = target?.resourceType ? [target.resourceType] : undefined;
    } else if (hintLevel === "subscription-hinted") {
      signal.followUpSubscribe = [PATIENT_DATA_FEED_TOPIC];
      signal.resourceTypes = ["Encounter", "Appointment"];
    } else if (hintLevel === "search-hinted") {
      signal.resourceTypes = ["Encounter"];
      signal.followUpSearch = [followUpSearchTemplate(source, "Encounter", ACTIVITY_WINDOW_START)];
    }

    return signal;
  }

  private hintLevelFor(
    source: SourceRecord,
    policy: DisclosurePolicy,
    followUpRead?: string,
  ): ActivityHintLevel {
    if (policy === "opaque") {
      return "opaque";
    }
    if (followUpRead) {
      return "read-hinted";
    }
    if (policy === "data-holder-organization") {
      return "organization-hinted";
    }
    if (policy === "data-holder-endpoint" || !source.feedEnabled) {
      return "search-hinted";
    }
    return "subscription-hinted";
  }

  private chooseAction(signal: NetworkActivitySignal): SuggestedActionView {
    if (signal.followUpRead?.[0] && signal.dataHolderEndpoint) {
      const target = resourceFromUrl(signal.followUpRead[0]);
      if (target) {
        return { code: "read-data-holder", ...target, url: signal.followUpRead[0] };
      }
    }
    if (signal.dataHolderEndpoint && signal.followUpSearch?.[0]) {
      return { code: "search-data-holder", followUpSearch: signal.followUpSearch[0] };
    }
    if (signal.followUpSubscribe?.[0] && signal.dataHolderEndpoint) {
      return { code: "subscribe-data-holder", followUpSubscribe: signal.followUpSubscribe[0] };
    }
    if (signal.dataHolderOrganization && signal.handle) {
      return { code: "query-network" };
    }
    return { code: "rediscover" };
  }

  private ensureSourceToken(source: SourceRecord) {
    const existing = this.state.app.sourceTokens[source.id];
    if (existing) {
      return existing;
    }
    const response = this.kernel.send({
      from: "client",
      to: "data-holder",
      method: "POST",
      path: `/data-holders/${source.id}/token`,
      headers: { "content-type": "application/json" },
      body: { client_id: "health-app", source: source.id },
      summary: `Authorize at ${source.name}`,
    });
    const body = response.body as { access_token: string; patient: string };
    const token = { token: body.access_token, patient: body.patient };
    this.state.app.sourceTokens[source.id] = token;
    return token;
  }

  private learnSource(source: SourceRecord, discoveredBy: string) {
    this.state.app.knownSources[source.id] = {
      id: source.id,
      name: source.name,
      endpoint: source.endpoint,
      discoveredBy,
    };
  }

  private learnSourcesFromResponse(response: SimResponse, discoveredBy: string) {
    const body = response.body as { dataHolders?: Array<{ id: string }> };
    for (const result of body.dataHolders ?? []) {
      const source = this.state.sources[result.id];
      if (source) {
        this.learnSource(source, discoveredBy);
      }
    }
  }

  private sourceFromSignal(signal: NetworkActivitySignal) {
    const endpoint = signal.dataHolderEndpoint;
    const source = Object.values(this.state.sources).find(
      (candidate) =>
        candidate.endpoint === endpoint ||
        candidate.name === signal.dataHolderOrganization?.name ||
        candidate.npi === signal.dataHolderOrganization?.identifiers?.[0]?.value,
    );
    if (source) {
      return source;
    }
    return undefined;
  }

  private resolveSources(body: unknown, state: SimulationState, mode: "RLS" | "network-query") {
    const handle = extractHandle(body);
    const mapping = handle ? state.network.handles[handle] : undefined;
    const candidates = mapping
      ? [state.sources[mapping.sourceId]]
      : Object.values(state.sources).filter((source) => !source.sensitive);
    const visible = candidates.filter(Boolean).filter((source) => {
      if (!source.sensitive) {
        return true;
      }
      return mode === "RLS" && state.network.disclosurePolicy !== "opaque";
    });
    return {
      mode,
      fanOut: mapping ? 1 : Object.values(state.sources).length,
      handleUsed: Boolean(mapping),
      dataHolders: visible.map((source) => ({
        id: source.id,
        dataHolderOrganization: organization(source),
        dataHolderEndpoint: source.endpoint,
        followUpSubscribe: source.feedEnabled ? PATIENT_DATA_FEED_TOPIC : undefined,
      })),
      withheld: candidates.length - visible.length,
    };
  }

  private queryResources(request: SimRequest, state: SimulationState, resourceType: "Encounter" | "Appointment") {
    const source = state.sources[pathPart(request.path, 1)];
    const patient = firstQueryValue(request.query.patient);
    const lastUpdated = firstQueryValue(request.query._lastUpdated);
    const resources = (state.resources[source.id]?.[resourceType] ?? []).filter((resource) =>
      matchesResourceQuery(resource, patient, lastUpdated),
    );
    return json(request, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: resources.length,
      entry: resources.map((resource) => ({ resource })),
    });
  }

  private readResource(request: SimRequest, state: SimulationState, resourceType: "Encounter" | "Appointment") {
    const source = state.sources[pathPart(request.path, 1)];
    const id = pathPart(request.path, 4);
    const resource = (state.resources[source.id]?.[resourceType] ?? []).find((item: any) => item.id === id);
    return resource ? json(request, 200, resource) : json(request, 404, { error: "Not found", id });
  }

  private traceDecision(summary: string, details: unknown) {
    this.kernel.trace({ kind: "decision", actor: "client", summary, details });
  }
}

function extractHandle(body: unknown) {
  const candidate = body as any;
  if (candidate?.activityHandle) {
    return String(candidate.activityHandle);
  }
  const parameter = candidate?.parameter?.find?.((item: any) => item.name === "activity-handle");
  return parameter?.valueString ? String(parameter.valueString) : undefined;
}

function resourceFromUrl(url: string) {
  const path = /^https?:\/\//.test(url) ? new URL(url).pathname : url.split("?")[0];
  const parts = path.split("/").filter(Boolean);
  const resourceId = parts[parts.length - 1];
  const resourceType = parts[parts.length - 2];
  if (!resourceType || !resourceId) {
    return undefined;
  }
  return { resourceType, resourceId };
}

function followUpSearchTemplate(source: SourceRecord, resourceType: "Encounter" | "Appointment", since: string) {
  return `${source.endpoint}/${resourceType}?patient={{patient}}&_lastUpdated=ge${encodeURIComponent(since)}&_activityHandle={{activity-handle}}`;
}

function renderFollowUpPath(source: SourceRecord, template: string, patient: string, activityHandle?: string) {
  const rendered = template
    .replace(/\{\{patient\}\}/g, encodeURIComponent(patient))
    .replace(/\{\{activity-handle\}\}/g, encodeURIComponent(activityHandle ?? ""));
  if (/^https?:\/\//.test(rendered)) {
    const renderedUrl = new URL(rendered);
    const endpointUrl = new URL(source.endpoint);
    const endpointPath = endpointUrl.pathname.replace(/\/$/, "");
    let sourceRelativePath = renderedUrl.pathname;
    if (endpointPath && sourceRelativePath.startsWith(endpointPath)) {
      sourceRelativePath = sourceRelativePath.slice(endpointPath.length);
    }
    sourceRelativePath = sourceRelativePath.replace(/^\//, "");
    return `/data-holders/${source.id}/fhir/${sourceRelativePath}${renderedUrl.search}`;
  }
  return `/data-holders/${source.id}/fhir/${rendered.replace(/^\//, "")}`;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function matchesResourceQuery(resource: unknown, patient?: string, lastUpdated?: string) {
  const item = resource as any;
  if (patient) {
    const subject = item.subject?.reference;
    const participants = item.participant?.map?.((participant: any) => participant.actor?.reference) ?? [];
    const references = [subject, ...participants].filter(Boolean);
    if (!references.some((reference: string) => reference === `Patient/${patient}` || reference.endsWith(`/${patient}`))) {
      return false;
    }
  }
  if (lastUpdated?.startsWith("ge")) {
    const threshold = lastUpdated.slice(2);
    if (!item.meta?.lastUpdated || String(item.meta.lastUpdated) < threshold) {
      return false;
    }
  }
  return true;
}

function bundleCount(body: unknown) {
  return Number((body as any)?.total ?? (body as any)?.entry?.length ?? 0);
}
