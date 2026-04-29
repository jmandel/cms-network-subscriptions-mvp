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
  parseNetworkActivityBundle,
  sourceFeedBundle,
} from "./fhir";
import { SimKernel } from "./kernel";
import type {
  AppPolicy,
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

  setAppPolicy(policy: AppPolicy) {
    this.state.app.policy = policy;
    this.kernel.trace({
      kind: "state-change",
      actor: "client",
      summary: `Client policy set to ${policy}`,
      details: { policy },
    });
  }

  setSourceFeedEnabled(sourceId: string, enabled: boolean) {
    this.state.sources[sourceId].feedEnabled = enabled;
    this.kernel.trace({
      kind: "state-change",
      actor: "source-feed",
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

    if (id === "feed-hinted") {
      this.setDisclosurePolicy("feed-endpoint");
      this.injectNetworkEvent("valley", "care-relationship-detected", "confirmed");
      this.processPendingActions();
    }

    if (id === "known-source") {
      this.setDisclosurePolicy("source-endpoint");
      this.learnSource(this.state.sources.valley, "seeded app state");
      this.injectNetworkEvent("valley", "source-activity-detected", "confirmed");
      this.processPendingActions();
    }

    if (id === "source-feed") {
      if (!this.state.app.feedSubscriptions.valley) {
        this.setDisclosurePolicy("feed-endpoint");
        this.injectNetworkEvent("valley", "feed-available", "confirmed");
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

    if (id === "sensitive-source") {
      this.setDisclosurePolicy("feed-endpoint");
      this.injectNetworkEvent("northside", "activity-detected", "possible");
      this.processPendingActions();
    }
  }

  injectNetworkEvent(
    sourceId: string,
    activityType = "activity-detected",
    confidence: NetworkActivitySignal["confidence"] = "confirmed",
  ) {
    this.kernel.send({
      from: "simulation",
      to: "network",
      method: "POST",
      path: "/network/internal/events",
      headers: { "content-type": "application/json" },
      body: { sourceId, activityType, confidence },
      summary: `Simulate ${activityType} at ${this.state.sources[sourceId].name}`,
    });
  }

  injectSourceEvent(sourceId: string, resourceType: "Encounter" | "Appointment", id: string) {
    this.kernel.send({
      from: "simulation",
      to: "source-feed",
      method: "POST",
      path: `/sources/${sourceId}/internal/events`,
      headers: { "content-type": "application/json" },
      body: { resourceType, id },
      summary: `Simulate source feed ${resourceType} at ${this.state.sources[sourceId].name}`,
    });
  }

  processPendingActions() {
    while (this.state.app.pendingActions.length > 0) {
      const pending = this.state.app.pendingActions.shift();
      if (!pending) {
        return;
      }
      const { signal, action } = pending;
      this.state.app.decisions.unshift(`Take ${action.code} for ${signal.activityId}`);
      this.kernel.trace({
        kind: "decision",
        actor: "client",
        summary: `Client takes ${action.code}`,
        details: { signal, action },
      });

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
            discoveryHint: action.params.discoveryHint,
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
            parameter: [{ name: action.params.handleParameter ?? "activity-handle", valueString: signal.handle?.value }],
          },
          correlationId: signal.activityId,
          summary: "Resolve activity at network",
        });
        this.learnSourcesFromResponse(response, "network query");
      }

      if (action.code === "query-source") {
        const source = this.sourceFromSignal(signal);
        if (!source) {
          this.traceDecision("No source endpoint available for query-source", { signal });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const since = String(action.params.since ?? signal.activityWindow?.start ?? "2026-04-29T00:00:00Z");
        const response = this.kernel.send({
          from: "client",
          to: "source",
          method: "GET",
          path: `/sources/${source.id}/fhir/Encounter?patient=${token.patient}&_lastUpdated=${encodeURIComponent(since)}`,
          headers: { authorization: `Bearer ${token.token}` },
          correlationId: signal.activityId,
          summary: `Query ${source.name} Encounters`,
        });
        this.learnSource(source, "source query");
        this.kernel.trace({
          kind: "state-change",
          actor: "client",
          summary: `Client received ${bundleCount(response.body)} source resources`,
          details: response.body,
          correlationId: signal.activityId,
        });
      }

      if (action.code === "subscribe-source") {
        const source = this.sourceFromSignal(signal);
        if (!source) {
          this.traceDecision("No feed endpoint available for subscribe-source", { signal });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const response = this.kernel.send({
          from: "client",
          to: "source-feed",
          method: "POST",
          path: `/sources/${source.id}/fhir/Subscription`,
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
          endpoint: source.feedEndpoint,
          status: body.status,
        };
        this.learnSource(source, "feed subscription");
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
        to: "source",
        method: "GET",
        path: `/sources/${source.id}/fhir/${read.resourceType}/${read.id}`,
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
        };
        const source = context.state.sources[body.sourceId];
        context.state.network.eventCounter += 1;
        const eventNumber = context.state.network.eventCounter;
        const handle = `handle-${String(eventNumber).padStart(3, "0")}-${source.id}`;
        context.state.network.handles[handle] = {
          sourceId: source.id,
          patientId: PATIENT_ID,
          createdAt: new Date().toISOString(),
        };
        const signal = this.buildSignal(source, handle, body.activityType, body.confidence);
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
          summary: `Deliver network activity ${signal.detailLevel}`,
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
              detailLevel: "opaque",
              suggestedActions: [],
            },
            action: {
              code: "rediscover",
              rank: 1,
              target: {},
              params: {},
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
      actor: "source",
      method: "POST",
      pathPattern: "/sources/:sourceId/token",
      handle: (request, context) => {
        const source = context.state.sources[pathPart(request.path, 1)];
        return json(request, 200, {
          access_token: `source-token-${source.id}`,
          token_type: "bearer",
          expires_in: 3600,
          scope: "patient/Encounter.r patient/Appointment.r system/Subscription.crud",
          patient: source.patientId,
        });
      },
    });

    this.kernel.register({
      actor: "source",
      method: "GET",
      pathPattern: "/sources/:sourceId/fhir/Encounter",
      handle: (request, context) => this.queryResources(request, context.state, "Encounter"),
    });

    this.kernel.register({
      actor: "source",
      method: "GET",
      pathPattern: "/sources/:sourceId/fhir/Appointment",
      handle: (request, context) => this.queryResources(request, context.state, "Appointment"),
    });

    this.kernel.register({
      actor: "source",
      method: "GET",
      pathPattern: "/sources/:sourceId/fhir/Encounter/:id",
      handle: (request, context) => this.readResource(request, context.state, "Encounter"),
    });

    this.kernel.register({
      actor: "source",
      method: "GET",
      pathPattern: "/sources/:sourceId/fhir/Appointment/:id",
      handle: (request, context) => this.readResource(request, context.state, "Appointment"),
    });

    this.kernel.register({
      actor: "source-feed",
      method: "POST",
      pathPattern: "/sources/:sourceId/fhir/Subscription",
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
      actor: "source-feed",
      method: "GET",
      pathPattern: "/sources/:sourceId/fhir/Subscription/:id",
      handle: (request) =>
        json(request, 200, {
          resourceType: "Subscription",
          id: pathPart(request.path, 4),
          status: "active",
        }),
    });

    this.kernel.register({
      actor: "source-feed",
      method: "POST",
      pathPattern: "/sources/:sourceId/internal/events",
      handle: (request, context) => {
        const source = context.state.sources[pathPart(request.path, 1)];
        const body = request.body as { resourceType: "Encounter" | "Appointment"; id: string };
        const eventNumber = Object.keys(context.state.app.feedSubscriptions).length + context.state.network.eventCounter + 1;
        const bundle = sourceFeedBundle(source, eventNumber, body.resourceType, body.id);
        context.send({
          from: "source-feed",
          to: "client",
          method: "POST",
          path: `/app/source-feed/${source.id}`,
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
      pathPattern: "/app/source-feed/:sourceId",
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
    handle: string,
    activityType: string,
    confidence: NetworkActivitySignal["confidence"],
  ): NetworkActivitySignal {
    const effectivePolicy: DisclosurePolicy = source.sensitive ? "opaque" : this.state.network.disclosurePolicy;
    const detailLevel = this.detailLevelFor(source, effectivePolicy);
    const signal: NetworkActivitySignal = {
      topic: NETWORK_ACTIVITY_TOPIC,
      activityId: `act-${String(this.state.network.eventCounter).padStart(4, "0")}-${source.id}`,
      patient: { id: PATIENT_ID, scope: "network" },
      observedAt: new Date().toISOString(),
      activityType,
      detailLevel,
      confidence,
      handle: {
        value: handle,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      },
      resourceTypes: ["Encounter", "Appointment"],
      activityWindow: { start: "2026-04-29T15:00:00Z" },
      suggestedActions: [],
    };

    if (detailLevel !== "opaque") {
      signal.source = { organization: { identifiers: organization(source).identifier, name: source.name } };
    }
    if (detailLevel === "query-hinted" || detailLevel === "feed-hinted") {
      signal.source = { ...(signal.source ?? {}), sourceEndpoint: source.endpoint };
    }
    if (detailLevel === "feed-hinted") {
      signal.source = { ...(signal.source ?? {}), feedEndpoint: source.feedEndpoint };
    }

    if (detailLevel === "feed-hinted") {
      signal.suggestedActions.push({
        code: "subscribe-source",
        rank: 1,
        target: { feedEndpoint: source.feedEndpoint },
        params: {
          topic: PATIENT_DATA_FEED_TOPIC,
          resourceTypes: ["Encounter", "Appointment"],
          activityHandle: handle,
          handleParameter: "activity-handle",
        },
      });
    } else if (detailLevel === "query-hinted") {
      signal.suggestedActions.push({
        code: "query-source",
        rank: 1,
        target: { sourceEndpoint: source.endpoint },
        params: {
          resourceTypes: ["Encounter"],
          since: "2026-04-29T15:00:00Z",
          activityHandle: handle,
          handleParameter: "activity-handle",
        },
      });
    } else if (detailLevel === "source-hinted") {
      signal.suggestedActions.push({
        code: "query-network",
        rank: 1,
        target: { networkEndpoint: "https://network.example.org/fhir/$resolve-activity" },
        params: { activityHandle: handle, handleParameter: "activity-handle" },
      });
    } else {
      signal.suggestedActions.push({
        code: source.sensitive ? "query-network" : "rediscover",
        rank: 1,
        target: source.sensitive
          ? { networkEndpoint: "https://network.example.org/fhir/$resolve-activity" }
          : { networkEndpoint: "https://network.example.org/rls/search" },
        params: { activityHandle: handle, handleParameter: "activity-handle" },
      });
    }

    return signal;
  }

  private detailLevelFor(source: SourceRecord, policy: DisclosurePolicy): NetworkActivitySignal["detailLevel"] {
    if (policy === "opaque") {
      return "opaque";
    }
    if (policy === "source-org") {
      return "source-hinted";
    }
    if (policy === "source-endpoint" || !source.feedEnabled) {
      return "query-hinted";
    }
    return "feed-hinted";
  }

  private chooseAction(signal: NetworkActivitySignal): SuggestedActionView {
    const actions = (signal.suggestedActions as unknown as SuggestedActionView[]).sort(
      (a, b) => (a.rank ?? 1) - (b.rank ?? 1),
    );
    const fallback = actions[0] ?? { code: "rediscover", rank: 1, target: {}, params: {} };
    const source = this.sourceFromSignal(signal);
    if (
      this.state.app.policy === "conservative" &&
      source &&
      !this.state.app.knownSources[source.id] &&
      ["query-source", "subscribe-source"].includes(fallback.code)
    ) {
      return {
        code: "rediscover",
        rank: 1,
        target: { networkEndpoint: "https://network.example.org/rls/search" },
        params: { activityHandle: signal.handle?.value ?? "", handleParameter: "activity-handle" },
      };
    }
    return fallback;
  }

  private ensureSourceToken(source: SourceRecord) {
    const existing = this.state.app.sourceTokens[source.id];
    if (existing) {
      return existing;
    }
    const response = this.kernel.send({
      from: "client",
      to: "source",
      method: "POST",
      path: `/sources/${source.id}/token`,
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
      feedEndpoint: source.feedEndpoint,
      discoveredBy,
    };
  }

  private learnSourcesFromResponse(response: SimResponse, discoveredBy: string) {
    const body = response.body as { sources?: Array<{ id: string }> };
    for (const result of body.sources ?? []) {
      const source = this.state.sources[result.id];
      if (source) {
        this.learnSource(source, discoveredBy);
      }
    }
  }

  private sourceFromSignal(signal: NetworkActivitySignal) {
    const endpoint = signal.source?.feedEndpoint ?? signal.source?.sourceEndpoint;
    const source = Object.values(this.state.sources).find(
      (candidate) =>
        candidate.endpoint === endpoint ||
        candidate.feedEndpoint === endpoint ||
        candidate.name === signal.source?.organization?.name ||
        candidate.npi === signal.source?.organization?.identifiers?.[0]?.value,
    );
    if (source) {
      return source;
    }
    const handle = signal.handle?.value;
    return handle ? this.state.sources[this.state.network.handles[handle]?.sourceId] : undefined;
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
      sources: visible.map((source) => ({
        id: source.id,
        organization: organization(source),
        sourceEndpoint: source.endpoint,
        feedEndpoint: source.feedEnabled ? source.feedEndpoint : undefined,
      })),
      withheld: candidates.length - visible.length,
    };
  }

  private queryResources(request: SimRequest, state: SimulationState, resourceType: "Encounter" | "Appointment") {
    const source = state.sources[pathPart(request.path, 1)];
    const resources = state.resources[source.id]?.[resourceType] ?? [];
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

function bundleCount(body: unknown) {
  return Number((body as any)?.total ?? (body as any)?.entry?.length ?? 0);
}
