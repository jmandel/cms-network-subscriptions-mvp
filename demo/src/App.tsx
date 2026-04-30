import {
  Activity,
  Bell,
  Database,
  Eye,
  Network,
  Play,
  Radio,
  RotateCcw,
  Search,
  Send,
  Server,
  Shield,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { NetworkActivitySignal } from "../../schema/network-activity";
import { parseNetworkActivityBundle } from "./sim/fhir";
import { NetworkActivitySimulation } from "./sim/simulation";
import type { DisclosurePolicy, ScenarioId, Snapshot, TraceEvent } from "./sim/types";

type InspectorMode = "summary" | "request" | "response" | "raw";

type TrafficItem =
  | {
      id: string;
      kind: "exchange";
      requestEvent: TraceEvent;
      responseEvent?: TraceEvent;
      childEvents: TraceEvent[];
    }
  | {
      id: string;
      kind: "event";
      event: TraceEvent;
    };

const disclosureOptions: Array<{ value: DisclosurePolicy; label: string }> = [
  { value: "opaque", label: "Opaque" },
  { value: "data-holder-organization", label: "Org" },
  { value: "data-holder-endpoint", label: "Endpoint" },
];

const scenarios: Array<{
  id: ScenarioId;
  label: string;
  short: string;
  lesson: string;
  steps: string[];
  icon: LucideIcon;
}> = [
  {
    id: "bootstrap",
    label: "Bootstrap",
    short: "Authorize and subscribe.",
    lesson: "The client creates one network-level activity subscription for the patient.",
    steps: ["Network token", "Network Subscription", "Active activity stream"],
    icon: Play,
  },
  {
    id: "opaque-rls",
    label: "Opaque Activity",
    short: "Signal, then RLS.",
    lesson: "A network can send an inline activity signal without naming the data holder; the client follows documented discovery with the opaque handle.",
    steps: ["Full-resource webhook", "Activity signal has no data holder", "RLS down-scopes fan-out"],
    icon: Search,
  },
  {
    id: "endpoint-hinted",
    label: "Endpoint Hint",
    short: "Use the hinted FHIR endpoint.",
    lesson: "When policy allows, the activity signal can disclose one data-holder FHIR endpoint. The client authorizes there and uses FHIR /metadata to discover Patient Data Feed support.",
    steps: ["Webhook includes FHIR endpoint", "Client checks /metadata", "Client creates Patient Data Feed subscription"],
    icon: Bell,
  },
  {
    id: "known-data-holder",
    label: "Known Data Holder",
    short: "Run a hinted query.",
    lesson: "If the activity signal includes a follow-up search URL, the client can run that search after data-holder authorization.",
    steps: ["Webhook includes follow-up-search", "Client authorizes at endpoint", "Client runs the hinted Encounter query"],
    icon: Server,
  },
  {
    id: "read-hinted",
    label: "Read Hint",
    short: "Read one hinted resource.",
    lesson: "If policy allows a specific follow-up read URL, the client can authorize at the data holder and read that resource directly.",
    steps: ["Webhook includes follow-up-read", "Client authorizes at endpoint", "Client reads that Encounter"],
    icon: Database,
  },
  {
    id: "patient-data-feed",
    label: "Patient Data Feed",
    short: "Ongoing EHR feed.",
    lesson: "Network activity helps discover the data holder; the data-holder FHIR endpoint handles ongoing Patient Data Feed notifications.",
    steps: ["Create Patient Data Feed subscription", "FHIR endpoint emits Encounter notification", "Client reads the referenced Encounter"],
    icon: Radio,
  },
  {
    id: "missed-activity",
    label: "Missed Event",
    short: "Detect a gap.",
    lesson: "Standard Subscription event numbers let the client notice missed webhooks and fall back to discovery plus targeted source queries.",
    steps: ["First webhook is dropped", "Next event number has a gap", "Client runs recovery discovery"],
    icon: Eye,
  },
  {
    id: "sensitive-data-holder",
    label: "Sensitive Policy",
    short: "Opaque by policy.",
    lesson: "Sensitive data holders can force opaque activity events while still permitting handle-scoped follow-up.",
    steps: ["Network withholds data-holder detail", "Webhook carries only opaque hints", "Policy limits what comes back"],
    icon: Shield,
  },
];

const actorItems = [
  { id: "client", label: "Client App", icon: Activity },
  { id: "network", label: "Network Activity", icon: Network },
  { id: "rls", label: "RLS / Query", icon: Search },
  { id: "data-holder", label: "Data Holder FHIR", icon: Database },
];

const actorLabels: Record<string, string> = {
  client: "Client App",
  network: "Network Activity",
  rls: "RLS / Query",
  "data-holder": "Data Holder FHIR",
  simulation: "Simulation",
};

export function App() {
  const simRef = useRef(new NetworkActivitySimulation());
  const [snapshot, setSnapshot] = useState<Snapshot>(() => simRef.current.snapshot());
  const [selectedTrafficId, setSelectedTrafficId] = useState<string | undefined>();
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("summary");
  const [activeScenarioId, setActiveScenarioId] = useState<ScenarioId>("bootstrap");

  const trafficItems = useMemo(() => buildTrafficItems(snapshot.state.trace), [snapshot.state.trace]);
  const selectedTraffic = useMemo(
    () =>
      trafficItems.find((item) => item.id === selectedTrafficId) ??
      trafficItems[trafficItems.length - 1],
    [selectedTrafficId, trafficItems],
  );

  function sync() {
    setSnapshot(simRef.current.snapshot());
  }

  function runScenario(id: ScenarioId) {
    simRef.current = new NetworkActivitySimulation();
    setActiveScenarioId(id);
    simRef.current.runScenario(id);
    setSelectedTrafficId(undefined);
    sync();
  }

  function reset() {
    simRef.current = new NetworkActivitySimulation();
    setSelectedTrafficId(undefined);
    setActiveScenarioId("bootstrap");
    setSnapshot(simRef.current.snapshot());
  }

  function clearTrace() {
    simRef.current.clearTrace();
    setSelectedTrafficId(undefined);
    sync();
  }

  function setDisclosure(value: DisclosurePolicy) {
    simRef.current.setDisclosurePolicy(value);
    sync();
  }

  function setFeedEnabled(sourceId: string, enabled: boolean) {
    simRef.current.setSourceFeedEnabled(sourceId, enabled);
    sync();
  }

  const state = snapshot.state;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0]!;

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <h1>Network Activity Simulator</h1>
          <div className="subhead">FHIR Subscriptions Workgroup reference implementation</div>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={clearTrace} title="Clear trace">
            <Trash2 size={17} />
            <span>Clear</span>
          </button>
          <button className="icon-button secondary" onClick={reset} title="Reset simulation">
            <RotateCcw size={17} />
            <span>Reset</span>
          </button>
        </div>
      </section>

      <section className="panel control-panel">
        <div className="control-row scenario-row">
          <SectionTitle icon={Workflow} label="Scenarios" />
          <div className="scenario-strip">
            {scenarios.map((scenario) => {
              const Icon = scenario.icon;
              return (
                <button
                  key={scenario.id}
                  className={`scenario-button ${scenario.id === activeScenarioId ? "selected" : ""}`}
                  onClick={() => runScenario(scenario.id)}
                >
                  <Icon size={15} />
                  <strong>{scenario.label}</strong>
                </button>
              );
            })}
          </div>
        </div>

        <details className="advanced-setup">
          <summary>
            <Shield size={15} />
            <span>Advanced setup</span>
          </summary>
          <div className="setup-grid">
            <ControlGroup label="Network disclosure">
              <Segmented
                value={state.network.disclosurePolicy}
                options={disclosureOptions}
                onChange={(value) => setDisclosure(value as DisclosurePolicy)}
              />
            </ControlGroup>
            <ControlGroup label="Patient Data Feed support">
              <div className="source-chips">
                {Object.values(state.sources).map((source) => (
                  <label key={source.id} className="source-chip">
                    <input
                      type="checkbox"
                      checked={source.feedEnabled}
                      disabled={!source.supportsFeed}
                      onChange={(event) => setFeedEnabled(source.id, event.currentTarget.checked)}
                    />
                    <span>
                      <strong>{source.name}</strong>
                      <small>{source.kind}</small>
                    </span>
                  </label>
                ))}
              </div>
            </ControlGroup>
          </div>
        </details>
      </section>

      <section className="workspace">
        <section className="center-stack">
          <section className="panel guide-panel">
            <div className="panel-head">
              <SectionTitle icon={Network} label="Current Flow" />
              <button className="small-action" type="button" onClick={() => runScenario(activeScenario.id)}>
                Run again
              </button>
            </div>
            <div className="guide-layout">
              <div className="guide-copy">
                <h2>{activeScenario.label}</h2>
                <p>{activeScenario.lesson}</p>
                <div className="step-strip">
                  {activeScenario.steps.map((step, index) => (
                    <span key={step}>
                      <b>{index + 1}</b>
                      {step}
                    </span>
                  ))}
                </div>
              </div>
              <div className="actor-strip" aria-label="Actors">
                {actorItems.map((actor) => {
                  const Icon = actor.icon;
                  return (
                    <span key={actor.id}>
                      <Icon size={15} />
                      {actor.label}
                    </span>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="panel traffic-panel">
            <div className="panel-head">
              <SectionTitle icon={Send} label="Traffic" />
              <span className="counter">{trafficItems.length} rows / {state.trace.length} events</span>
            </div>
            <div className="traffic-workbench">
              <TrafficList
                items={trafficItems}
                selectedTrafficId={selectedTraffic?.id}
                onSelect={(id) => setSelectedTrafficId(id)}
              />
            </div>
          </section>
        </section>

        <aside className="right-rail">
          <section className="panel inspector">
            <div className="panel-head">
              <SectionTitle icon={Eye} label="Inspector" />
              <Segmented
                value={inspectorMode}
                options={[
                  { value: "summary", label: "Summary" },
                  { value: "request", label: "Request" },
                  { value: "response", label: "Response" },
                  { value: "raw", label: "Raw" },
                ]}
                onChange={(value) => setInspectorMode(value as InspectorMode)}
              />
            </div>
            <div className="inspector-body">
              <Inspector item={selectedTraffic} mode={inspectorMode} />
            </div>
          </section>

          <section className="state-grid">
            <AppStatePanel state={state} />
            <NetworkStatePanel state={state} />
          </section>
        </aside>
      </section>

      <footer className="app-footer">
        <span>
          Draft reference implementation for the CMS-Aligned Network activity notifications MVP.
        </span>
        <a
          href="https://github.com/jmandel/cms-network-subscriptions-mvp/blob/main/index.md"
          target="_blank"
          rel="noreferrer"
        >
          Read the spec draft on GitHub
        </a>
      </footer>
    </main>
  );
}

function TrafficList({
  items,
  selectedTrafficId,
  onSelect,
}: {
  items: TrafficItem[];
  selectedTrafficId?: string;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return <div className="empty-state">Run a scenario to see the simulated HTTP traffic.</div>;
  }
  return (
    <div className="traffic-list">
      {items.map((item, index) => (
        <div key={item.id} className="traffic-item">
          <button
            className={`trace-row ${item.id === selectedTrafficId ? "selected" : ""}`}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            <span className="trace-index">{index + 1}</span>
            <span className={`kind kind-${trafficItemKind(item)}`}>{trafficItemKind(item)}</span>
            <span className="trace-main">
              <strong>{trafficItemSummary(item)}</strong>
              <small>{trafficItemSubhead(item)}</small>
            </span>
            <span className="trace-status">{trafficItemStatus(item)}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

function HttpCard({
  title,
  badge,
  lines,
  body,
}: {
  title: string;
  badge: string;
  lines: Array<[string, ReactNode]>;
  body?: unknown;
}) {
  return (
    <section className="http-card">
      <div className="http-card__top">
        <h3>{title}</h3>
        <span>{badge}</span>
      </div>
      <KeyValues items={lines} />
      {body === undefined ? (
        <div className="no-body">No body</div>
      ) : (
        <pre className="inline-json">{formatBody(body)}</pre>
      )}
    </section>
  );
}

function TraceEventCard({ title, event }: { title: string; event: TraceEvent }) {
  return (
    <section className="http-card">
      <div className="http-card__top">
        <h3>{title}</h3>
        <span>{event.kind}</span>
      </div>
      <KeyValues
        items={[
          ["actor", actorLabel(event.actor)],
          ["summary", event.summary],
          ["correlation", event.correlationId ?? "none"],
        ]}
      />
      {event.details === undefined ? <div className="no-body">No details</div> : <pre className="inline-json">{formatBody(event.details)}</pre>}
    </section>
  );
}

function Inspector({ item, mode }: { item?: TrafficItem; mode: InspectorMode }) {
  if (!item) {
    return <div className="empty-state">No events</div>;
  }
  if (mode === "raw") {
    return <pre className="json-view">{JSON.stringify(rawTrafficItem(item), null, 2)}</pre>;
  }
  if (mode === "request") {
    if (item.kind === "event") {
      return <TraceEventCard title="Event" event={item.event} />;
    }
    return (
      <HttpCard
        title="Request"
        badge={item.requestEvent.request?.method ?? "request"}
        lines={requestLines(item.requestEvent)}
        body={item.requestEvent.request?.body}
      />
    );
  }
  if (mode === "response") {
    if (item.kind === "event") {
      return <TraceEventCard title="Event" event={item.event} />;
    }
    return (
      <HttpCard
        title="Response"
        badge={item.responseEvent?.response?.status ? String(item.responseEvent.response.status) : "..."}
        lines={responseLines(item.responseEvent)}
        body={item.responseEvent?.response?.body}
      />
    );
  }

  const signal = networkSignalFromItem(item);
  const action = actionFromItem(item);
  const facts = trafficItemFacts(item);
  const payloadFacts = payloadSummary(item, signal);
  const childEvents = item.kind === "exchange" ? item.childEvents : [];

  return (
    <div className="inspector-pretty">
      <section className="summary-card">
        <div className="summary-card__top">
          <span className={`kind kind-${trafficItemKind(item)}`}>{trafficItemKind(item)}</span>
          <strong>{trafficItemSummary(item)}</strong>
        </div>
        <KeyValues items={facts} />
      </section>

      {childEvents.length > 0 ? <NestedEvents events={childEvents} /> : null}
      {signal ? <SignalCard signal={signal} /> : null}
      {action ? <ActionCard action={action} /> : null}
      {payloadFacts.length > 0 ? (
        <section className="summary-card">
          <h3>Payload</h3>
          <KeyValues items={payloadFacts} />
        </section>
      ) : null}
    </div>
  );
}

function NestedEvents({ events }: { events: TraceEvent[] }) {
  return (
    <section className="summary-card">
      <h3>During This Exchange</h3>
      <div className="nested-events">
        {events.map((event) => (
          <span key={event.id}>
            <b className={`kind kind-${event.kind}`}>{event.kind}</b>
            {event.summary}
          </span>
        ))}
      </div>
    </section>
  );
}

function SignalCard({ signal }: { signal: NonNullable<ReturnType<typeof networkSignalFromTrace>> }) {
  return (
    <section className="summary-card">
      <h3>Activity Signal</h3>
      <KeyValues
        items={[
          ["activity", signal.activityType],
          ["hint", hintLevelFromSignal(signal)],
          ["confidence", signal.confidence ?? "not supplied"],
          ["patient", signal.patient.id],
          ["handle", signal.handle?.value ?? "none"],
          ["data holder", signal.dataHolderOrganization?.name ?? "not disclosed"],
          ["FHIR endpoint", signal.dataHolderEndpoint ?? "not disclosed"],
          ["follow-up read", signal.followUpRead?.[0] ?? "not supplied"],
          ["follow-up search", signal.followUpSearch?.[0] ?? "not supplied"],
          ["follow-up discovery", signal.followUpDiscovery ?? "not supplied"],
        ]}
      />
    </section>
  );
}

function ActionCard({ action }: { action: NonNullable<ReturnType<typeof actionFromTrace>> }) {
  return (
    <section className="summary-card">
      <h3>Client Action</h3>
      <KeyValues
        items={[
          ["action", action.code],
          ["resource", action.resourceType && action.resourceId ? `${action.resourceType}/${action.resourceId}` : "none"],
          ["url", action.url ?? "none"],
          ["follow-up search", action.followUpSearch ?? "none"],
          ["follow-up discovery", action.followUpDiscovery ?? "none"],
        ]}
      />
    </section>
  );
}

function AppStatePanel({ state }: { state: Snapshot["state"] }) {
  const knownSources = Object.values(state.app.knownSources);
  const feedSubscriptions = Object.values(state.app.feedSubscriptions);
  return (
    <section className="panel state-panel">
      <h2>App State</h2>
      <KeyValues
        items={[
          ["patient", state.app.patientId],
          ["network sub", state.app.networkSubscriptionId ?? "none"],
          ["last event", String(state.app.lastNetworkEventNumber)],
          ["known data holders", String(knownSources.length)],
          ["data feed subs", String(feedSubscriptions.length)],
        ]}
      />
      <MiniList
        empty="No known data holders"
        items={knownSources.map((source) => `${source.name} (${source.discoveredBy})`)}
      />
      <MiniList
        empty="No Patient Data Feed subscriptions"
        items={feedSubscriptions.map((subscription) => `${state.sources[subscription.sourceId]?.name ?? subscription.sourceId}: ${subscription.status}`)}
      />
    </section>
  );
}

function NetworkStatePanel({ state }: { state: Snapshot["state"] }) {
  const handles = Object.keys(state.network.handles);
  return (
    <section className="panel state-panel">
      <h2>Network State</h2>
      <KeyValues
        items={[
          ["disclosure", state.network.disclosurePolicy],
          ["event count", String(state.network.eventCounter)],
          ["handles", String(handles.length)],
          ["drop next", state.network.dropNextWebhook ? "yes" : "no"],
        ]}
      />
      <div className="source-health">
        {Object.values(state.sources).map((source) => (
          <span key={source.id} className={source.feedEnabled ? "on" : "off"}>
            {source.name}
          </span>
        ))}
      </div>
    </section>
  );
}

function MiniList({ items, empty }: { items: string[]; empty: string }) {
  return (
    <div className="mini-list">
      {items.length === 0 ? <span>{empty}</span> : items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

function KeyValues({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="key-values">
      {items.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="section-title">
      <Icon size={16} />
      <span>{label}</span>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="control-group">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function actorLabel(actor?: string) {
  return actor ? actorLabels[actor] ?? actor : "";
}

function buildTrafficItems(trace: TraceEvent[]): TrafficItem[] {
  const items: TrafficItem[] = [];
  const byRequestId = new Map<string, Extract<TrafficItem, { kind: "exchange" }>>();
  const openRequestIds: string[] = [];

  for (const event of trace) {
    if (event.request && !event.response) {
      const item: Extract<TrafficItem, { kind: "exchange" }> = {
        id: event.request.id,
        kind: "exchange",
        requestEvent: event,
        childEvents: [],
      };
      items.push(item);
      byRequestId.set(event.request.id, item);
      openRequestIds.push(event.request.id);
      continue;
    }

    if (event.request && event.response) {
      const item = byRequestId.get(event.request.id);
      if (item) {
        item.responseEvent = event;
        const openIndex = openRequestIds.lastIndexOf(event.request.id);
        if (openIndex >= 0) {
          openRequestIds.splice(openIndex, 1);
        }
      } else {
        items.push({
          id: event.id,
          kind: "event",
          event,
        });
      }
      continue;
    }

    const activeRequestId = openRequestIds[openRequestIds.length - 1];
    const activeItem = activeRequestId ? byRequestId.get(activeRequestId) : undefined;
    if (activeItem) {
      activeItem.childEvents.push(event);
    } else {
      items.push({
        id: event.id,
        kind: "event",
        event,
      });
    }
  }

  return items;
}

function trafficItemKind(item: TrafficItem) {
  if (item.kind === "event") return item.event.kind;
  if (item.requestEvent.kind === "webhook") return "webhook";
  if (item.responseEvent?.kind === "error") return "error";
  return "exchange";
}

function trafficItemSummary(item: TrafficItem) {
  if (item.kind === "event") return item.event.summary;
  return item.requestEvent.summary;
}

function trafficItemSubhead(item: TrafficItem) {
  if (item.kind === "event") return flowLabel(item.event);
  const request = item.requestEvent.request;
  return `${actorLabel(request?.from)} -> ${actorLabel(request?.to)} · ${request?.method} ${request?.path}`;
}

function trafficItemStatus(item: TrafficItem) {
  if (item.kind === "event") return "";
  const status = item.responseEvent?.response?.status;
  return status ? String(status) : "...";
}

function requestLines(event: TraceEvent): Array<[string, ReactNode]> {
  const request = event.request;
  return [
    ["flow", request ? `${actorLabel(request.from)} -> ${actorLabel(request.to)}` : "none"],
    ["url", request ? `${request.method} ${requestDisplayPath(request)}` : "none"],
    ["headers", compactRecord(request?.headers)],
    ["query", compactRecord(request?.query)],
    ["correlation", event.correlationId ?? request?.correlationId ?? "none"],
  ];
}

function responseLines(event?: TraceEvent): Array<[string, ReactNode]> {
  const response = event?.response;
  return [
    ["status", response?.status ? String(response.status) : "pending"],
    ["headers", compactRecord(response?.headers)],
    ["correlation", event?.correlationId ?? event?.request?.correlationId ?? "none"],
  ];
}

function requestDisplayPath(request: NonNullable<TraceEvent["request"]>) {
  return request.url.replace(/^sim:\/\/[^/]+/, "");
}

function formatBody(body: unknown) {
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function trafficItemEvents(item: TrafficItem): TraceEvent[] {
  return item.kind === "event"
    ? [item.event]
    : [
        item.requestEvent,
        ...item.childEvents,
        ...(item.responseEvent ? [item.responseEvent] : []),
      ];
}

function rawTrafficItem(item: TrafficItem) {
  if (item.kind === "event") return item.event;
  return {
    kind: "exchange",
    summary: trafficItemSummary(item),
    request: item.requestEvent,
    eventsDuringExchange: item.childEvents,
    response: item.responseEvent,
  };
}

function flowLabel(event: TraceEvent) {
  if (event.request) {
    return `${actorLabel(event.request.from)} -> ${actorLabel(event.request.to)}`;
  }
  return actorLabel(event.actor);
}

function trafficItemFacts(item: TrafficItem): Array<[string, ReactNode]> {
  if (item.kind === "event") {
    return [
      ["flow", flowLabel(item.event)],
      ["http", item.event.request ? `${item.event.request.method} ${item.event.request.path}` : "none"],
      ["status", item.event.response?.status ? String(item.event.response.status) : "none"],
      ["correlation", item.event.correlationId ?? item.event.request?.correlationId ?? "none"],
    ];
  }
  const request = item.requestEvent.request;
  return [
    ["flow", `${actorLabel(request?.from)} -> ${actorLabel(request?.to)}`],
    ["http", request ? `${request.method} ${request.path}` : "none"],
    ["status", trafficItemStatus(item)],
    ["correlation", item.requestEvent.correlationId ?? request?.correlationId ?? "none"],
  ];
}

function networkSignalFromItem(item: TrafficItem): NetworkActivitySignal | undefined {
  for (const event of trafficItemEvents(item)) {
    const signal = networkSignalFromTrace(event);
    if (signal) return signal;
  }
  return undefined;
}

function networkSignalFromTrace(event: TraceEvent): NetworkActivitySignal | undefined {
  const fromDetails = (event.details as any)?.signal;
  if (fromDetails?.activityId) {
    return fromDetails as NetworkActivitySignal;
  }
  return parseNetworkActivityBundle(event.response?.body) ?? parseNetworkActivityBundle(event.request?.body);
}

function actionFromItem(item: TrafficItem) {
  for (const event of trafficItemEvents(item)) {
    const action = actionFromTrace(event);
    if (action) return action;
  }
  return null;
}

function actionFromTrace(event: TraceEvent) {
  const action = (event.details as any)?.action;
  return action?.code
    ? action as {
        code: string;
        resourceType?: string;
        resourceId?: string;
        url?: string;
        followUpSearch?: string;
        followUpDiscovery?: string;
      }
    : null;
}

function hintLevelFromSignal(signal: NetworkActivitySignal) {
  if (signal.followUpRead?.length) return "read hinted";
  if (signal.followUpSearch?.length) return "search hinted";
  if (signal.dataHolderEndpoint) return "endpoint hinted";
  if (signal.dataHolderOrganization) return "organization hinted";
  if (signal.followUpDiscovery) return "discovery hinted";
  return "opaque";
}

function payloadSummary(item: TrafficItem, signal: ReturnType<typeof networkSignalFromItem>): Array<[string, ReactNode]> {
  if (signal) {
    return [
      ["FHIR focus", "Parameters"],
      ["topic", signal.topic],
      ["follow-up read", signal.followUpRead?.[0] ?? "not supplied"],
      ["follow-up search", signal.followUpSearch?.[0] ?? "not supplied"],
      ["follow-up discovery", signal.followUpDiscovery ?? "not supplied"],
    ];
  }

  const event = item.kind === "event" ? item.event : item.responseEvent ?? item.requestEvent;
  const payload = event.response?.body ?? event.request?.body ?? event.details;
  const body = payload as any;
  if (!body || typeof body !== "object") return [];

  if (body.access_token) {
    return [
      ["token", body.access_token],
      ["patient", body.patient ?? "none"],
      ["scope", body.scope ?? "none"],
    ];
  }
  if (body.resourceType === "Subscription") {
    return [
      ["resource", "Subscription"],
      ["topic", body.criteria ?? "none"],
      ["filter", body._criteria?.extension?.[0]?.valueString ?? "none"],
      ["channel", body.channel?.endpoint ?? "none"],
    ];
  }
  if (body.dataHolders) {
    return [
      ["mode", body.mode ?? "discovery"],
      ["fan out", String(body.fanOut ?? "unknown")],
      ["handle used", body.handleUsed ? "yes" : "no"],
      ["data holders", body.dataHolders.map((source: any) => source.dataHolderOrganization?.name ?? source.id).join(", ") || "none"],
      ["withheld", String(body.withheld ?? 0)],
    ];
  }
  if (body.resourceType === "Bundle") {
    const status = body.entry?.[0]?.resource;
    const focus = status?.notificationEvent?.[0]?.focus;
    return [
      ["bundle", body.type ?? "Bundle"],
      ["topic", status?.topic ?? "none"],
      ["event", String(status?.notificationEvent?.[0]?.eventNumber ?? "none")],
      ["focus", focus?.reference ?? "none"],
    ];
  }
  if (body.resourceType === "Encounter" || body.resourceType === "Appointment") {
    return [
      ["resource", `${body.resourceType}/${body.id}`],
      ["status", body.status ?? "none"],
      ["data holder", body.serviceProvider?.display ?? "none"],
      ["last updated", body.meta?.lastUpdated ?? "none"],
    ];
  }
  if (body.error) {
    return [["error", body.error]];
  }
  return [];
}

function compactRecord(value: Record<string, string | string[]> | undefined) {
  if (!value || Object.keys(value).length === 0) return "none";
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(", ") : item}`)
    .join("; ");
}
