import type { NetworkActivitySignal, TargetResourceHint } from "../../../schema/network-activity";
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

type ActivityHintLevel = "opaque" | "source-hinted" | "query-hinted" | "resource-hinted" | "feed-hinted";

const ACTIVITY_WINDOW_START = "2026-04-29T15:00:00Z";

function hintLevelForSignal(signal: NetworkActivitySignal): ActivityHintLevel {
  if (signal.targetResource) return "resource-hinted";
  if (signal.source?.feedEndpoint) return "feed-hinted";
  if (signal.sourceQueries?.length || signal.source?.sourceEndpoint) return "query-hinted";
  if (signal.source?.organization) return "source-hinted";
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

    if (id === "resource-hinted") {
      this.setDisclosurePolicy("source-endpoint");
      this.injectNetworkEvent("mercy", "source-resource-detected", "confirmed", {
        reference: "Encounter/enc-mercy-1",
        type: "Encounter",
        url: "https://mercy-phoenix.example.org/fhir/Encounter/enc-mercy-1",
      });
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
    targetResource?: TargetResourceHint,
  ) {
    this.kernel.send({
      from: "simulation",
      to: "network",
      method: "POST",
      path: "/network/internal/events",
      headers: { "content-type": "application/json" },
      body: { sourceId, activityType, confidence, targetResource },
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
      this.state.app.decisions.unshift(`Follow ${action.code} for ${signal.activityId}`);
      this.kernel.trace({
        kind: "decision",
        actor: "client",
        summary: `Client follows ${action.code}`,
        details: { signal, action },
      });

      if (action.code === "read-source") {
        const source = this.sourceFromSignal(signal);
        if (!source || !action.resourceType || !action.resourceId) {
          this.traceDecision("No specific source resource available for read-source", { signal, action });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const response = this.kernel.send({
          from: "client",
          to: "source",
          method: "GET",
          path: `/sources/${source.id}/fhir/${action.resourceType}/${action.resourceId}`,
          headers: { authorization: `Bearer ${token.token}` },
          correlationId: signal.activityId,
          summary: action.url
            ? `Read hinted resource URL`
            : `Read hinted ${action.resourceType}/${action.resourceId}`,
        });
        this.learnSource(source, "resource hint");
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

      if (action.code === "query-source") {
        const source = this.sourceFromSignal(signal);
        if (!source || !action.sourceQuery) {
          this.traceDecision("No explicit source query available for query-source", { signal, action });
          continue;
        }
        const token = this.ensureSourceToken(source);
        const path = renderSourceQueryPath(source, action.sourceQuery, token.patient);
        const response = this.kernel.send({
          from: "client",
          to: "source",
          method: "GET",
          path,
          headers: { authorization: `Bearer ${token.token}` },
          correlationId: signal.activityId,
          summary: `Run hinted source query`,
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
          targetResource?: TargetResourceHint;
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
        const signal = this.buildSignal(source, eventNumber, handle, body.activityType, body.confidence, body.targetResource);
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
    eventNumber: number,
    handle: string,
    activityType: string,
    confidence: NetworkActivitySignal["confidence"],
    targetResource?: TargetResourceHint,
  ): NetworkActivitySignal {
    const effectivePolicy: DisclosurePolicy = source.sensitive ? "opaque" : this.state.network.disclosurePolicy;
    const requestedTarget = targetResource;
    const hintLevel = this.hintLevelFor(source, effectivePolicy, requestedTarget);
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
      signal.source = { organization: { identifiers: organization(source).identifier, name: source.name } };
    }
    if (hintLevel === "query-hinted" || hintLevel === "resource-hinted" || hintLevel === "feed-hinted") {
      signal.source = { ...(signal.source ?? {}), sourceEndpoint: source.endpoint };
    }
    if (hintLevel === "feed-hinted") {
      signal.source = { ...(signal.source ?? {}), feedEndpoint: source.feedEndpoint };
    }

    if (hintLevel === "resource-hinted" && requestedTarget) {
      signal.targetResource = {
        ...requestedTarget,
        url: requestedTarget.url ?? targetUrlFor(source, requestedTarget),
      };
      signal.resourceTypes = requestedTarget.type ? [requestedTarget.type] : undefined;
    } else if (hintLevel === "feed-hinted") {
      signal.feedTopic = PATIENT_DATA_FEED_TOPIC;
      signal.resourceTypes = ["Encounter", "Appointment"];
    } else if (hintLevel === "query-hinted") {
      signal.resourceTypes = ["Encounter"];
      signal.activityWindow = { start: ACTIVITY_WINDOW_START };
      signal.sourceQueries = [
        {
          urlTemplate: sourceQueryTemplate(source, "Encounter", ACTIVITY_WINDOW_START),
        },
      ];
    }

    return signal;
  }

  private hintLevelFor(
    source: SourceRecord,
    policy: DisclosurePolicy,
    targetResource?: TargetResourceHint,
  ): ActivityHintLevel {
    if (policy === "opaque") {
      return "opaque";
    }
    if (targetResource) {
      return "resource-hinted";
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
    if (signal.targetResource && signal.source?.sourceEndpoint) {
      const target = resourceFromReference(signal.targetResource.reference, signal.targetResource.type);
      if (target) {
        return { code: "read-source", ...target, url: signal.targetResource.url };
      }
    }
    if (signal.source?.feedEndpoint) {
      return { code: "subscribe-source" };
    }
    if (signal.source?.sourceEndpoint && signal.sourceQueries?.[0]?.urlTemplate) {
      return { code: "query-source", sourceQuery: signal.sourceQueries[0].urlTemplate };
    }
    if (signal.source?.organization && signal.handle) {
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

function resourceFromReference(reference: string, type?: string) {
  const parts = reference.split("/").filter(Boolean);
  const resourceId = parts[parts.length - 1];
  const resourceType = type ?? parts[parts.length - 2];
  if (!resourceType || !resourceId) {
    return undefined;
  }
  return { resourceType, resourceId };
}

function sourceQueryTemplate(source: SourceRecord, resourceType: "Encounter" | "Appointment", since: string) {
  return `${source.endpoint}/${resourceType}?patient={patient}&_lastUpdated=ge${encodeURIComponent(since)}`;
}

function targetUrlFor(source: SourceRecord, target: TargetResourceHint) {
  if (/^https?:\/\//.test(target.reference)) {
    return target.reference;
  }
  return `${source.endpoint.replace(/\/$/, "")}/${target.reference.replace(/^\//, "")}`;
}

function renderSourceQueryPath(source: SourceRecord, template: string, patient: string) {
  const rendered = template.replace(/\{patient\}/g, encodeURIComponent(patient));
  if (/^https?:\/\//.test(rendered)) {
    const renderedUrl = new URL(rendered);
    const endpointUrl = new URL(source.endpoint);
    const endpointPath = endpointUrl.pathname.replace(/\/$/, "");
    let sourceRelativePath = renderedUrl.pathname;
    if (endpointPath && sourceRelativePath.startsWith(endpointPath)) {
      sourceRelativePath = sourceRelativePath.slice(endpointPath.length);
    }
    sourceRelativePath = sourceRelativePath.replace(/^\//, "");
    return `/sources/${source.id}/fhir/${sourceRelativePath}${renderedUrl.search}`;
  }
  return `/sources/${source.id}/fhir/${rendered.replace(/^\//, "")}`;
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
