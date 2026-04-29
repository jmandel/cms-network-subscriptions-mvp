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
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { NetworkActivitySimulation } from "./sim/simulation";
import type { AppPolicy, DisclosurePolicy, ScenarioId, Snapshot, TraceEvent } from "./sim/types";

const disclosureOptions: Array<{ value: DisclosurePolicy; label: string }> = [
  { value: "opaque", label: "Opaque" },
  { value: "source-org", label: "Org" },
  { value: "source-endpoint", label: "Source" },
  { value: "feed-endpoint", label: "Feed" },
];

const appPolicyOptions: Array<{ value: AppPolicy; label: string }> = [
  { value: "aggressive", label: "Aggressive" },
  { value: "conservative", label: "Conservative" },
];

const scenarios: Array<{ id: ScenarioId; label: string; icon: typeof Play }> = [
  { id: "bootstrap", label: "Bootstrap", icon: Play },
  { id: "opaque-rls", label: "Opaque RLS", icon: Search },
  { id: "feed-hinted", label: "Feed Hint", icon: Bell },
  { id: "known-source", label: "Known Source", icon: Server },
  { id: "source-feed", label: "Source Feed", icon: Radio },
  { id: "missed-activity", label: "Missed Event", icon: Eye },
  { id: "sensitive-source", label: "Sensitive Policy", icon: Shield },
];

const actorItems = [
  { id: "client", label: "Client App", icon: Activity },
  { id: "network", label: "Network Activity", icon: Network },
  { id: "rls", label: "RLS / Query", icon: Search },
  { id: "source", label: "Source Endpoint", icon: Database },
  { id: "source-feed", label: "Source Feed", icon: Radio },
];

export function App() {
  const simRef = useRef(new NetworkActivitySimulation());
  const [snapshot, setSnapshot] = useState<Snapshot>(() => simRef.current.snapshot());
  const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
  const [inspectorMode, setInspectorMode] = useState<"pretty" | "raw">("pretty");

  const selectedTrace = useMemo(
    () =>
      snapshot.state.trace.find((event) => event.id === selectedTraceId) ??
      snapshot.state.trace[snapshot.state.trace.length - 1],
    [selectedTraceId, snapshot.state.trace],
  );

  function sync() {
    setSnapshot(simRef.current.snapshot());
  }

  function runScenario(id: ScenarioId) {
    simRef.current.runScenario(id);
    sync();
  }

  function reset() {
    simRef.current = new NetworkActivitySimulation();
    setSelectedTraceId(undefined);
    setSnapshot(simRef.current.snapshot());
  }

  function clearTrace() {
    simRef.current.clearTrace();
    setSelectedTraceId(undefined);
    sync();
  }

  function setDisclosure(value: DisclosurePolicy) {
    simRef.current.setDisclosurePolicy(value);
    sync();
  }

  function setAppPolicy(value: AppPolicy) {
    simRef.current.setAppPolicy(value);
    sync();
  }

  function setFeedEnabled(sourceId: string, enabled: boolean) {
    simRef.current.setSourceFeedEnabled(sourceId, enabled);
    sync();
  }

  const state = snapshot.state;

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

      <section className="workspace">
        <aside className="left-rail panel">
          <SectionTitle icon={Workflow} label="Scenarios" />
          <div className="scenario-grid">
            {scenarios.map((scenario) => {
              const Icon = scenario.icon;
              return (
                <button key={scenario.id} className="scenario-button" onClick={() => runScenario(scenario.id)}>
                  <Icon size={16} />
                  <span>{scenario.label}</span>
                </button>
              );
            })}
          </div>

          <SectionTitle icon={Shield} label="Policies" />
          <ControlGroup label="Network disclosure">
            <Segmented
              value={state.network.disclosurePolicy}
              options={disclosureOptions}
              onChange={(value) => setDisclosure(value as DisclosurePolicy)}
            />
          </ControlGroup>
          <ControlGroup label="Client behavior">
            <Segmented
              value={state.app.policy}
              options={appPolicyOptions}
              onChange={(value) => setAppPolicy(value as AppPolicy)}
            />
          </ControlGroup>

          <SectionTitle icon={Server} label="Sources" />
          <div className="source-list">
            {Object.values(state.sources).map((source) => (
              <label key={source.id} className="source-row">
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
        </aside>

        <section className="center-stack">
          <section className="panel actor-panel">
            <SectionTitle icon={Network} label="Actors" />
            <div className="actor-map">
              {actorItems.map((actor) => {
                const Icon = actor.icon;
                return (
                  <div className="actor-node" key={actor.id}>
                    <Icon size={20} />
                    <span>{actor.label}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel traffic-panel">
            <div className="panel-head">
              <SectionTitle icon={Send} label="Traffic" />
              <span className="counter">{state.trace.length} events</span>
            </div>
            <TrafficTable
              trace={state.trace}
              selectedTraceId={selectedTrace?.id}
              onSelect={(id) => setSelectedTraceId(id)}
            />
          </section>
        </section>

        <aside className="right-rail">
          <section className="panel inspector">
            <div className="panel-head">
              <SectionTitle icon={Eye} label="Inspector" />
              <Segmented
                value={inspectorMode}
                options={[
                  { value: "pretty", label: "Pretty" },
                  { value: "raw", label: "Raw" },
                ]}
                onChange={(value) => setInspectorMode(value as "pretty" | "raw")}
              />
            </div>
            <Inspector trace={selectedTrace} mode={inspectorMode} />
          </section>

          <section className="state-grid">
            <StatePanel title="App State" data={appStateView(state)} />
            <StatePanel title="Network State" data={networkStateView(state)} />
          </section>
        </aside>
      </section>
    </main>
  );
}

function TrafficTable({
  trace,
  selectedTraceId,
  onSelect,
}: {
  trace: TraceEvent[];
  selectedTraceId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="traffic-table-wrap">
      <table className="traffic-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Actor</th>
            <th>Message</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {trace.map((event) => (
            <tr
              key={event.id}
              className={event.id === selectedTraceId ? "selected" : ""}
              onClick={() => onSelect(event.id)}
            >
              <td>
                <span className={`kind kind-${event.kind}`}>{event.kind}</span>
              </td>
              <td>{actorLabel(event.actor)}</td>
              <td>
                <div className="traffic-summary">{event.summary}</div>
                {event.request && (
                  <div className="traffic-path">
                    {event.request.method} {event.request.path}
                  </div>
                )}
              </td>
              <td>{event.response?.status ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inspector({ trace, mode }: { trace?: TraceEvent; mode: "pretty" | "raw" }) {
  if (!trace) {
    return <div className="empty-state">No events</div>;
  }
  const payload =
    mode === "raw"
      ? trace
      : {
          summary: trace.summary,
          actor: trace.actor,
          request: trace.request
            ? {
                from: trace.request.from,
                to: trace.request.to,
                method: trace.request.method,
                path: trace.request.path,
                query: trace.request.query,
                headers: trace.request.headers,
                body: trace.request.body,
              }
            : undefined,
          response: trace.response
            ? {
                status: trace.response.status,
                headers: trace.response.headers,
                body: trace.response.body,
              }
            : undefined,
          details: trace.details,
        };
  return <pre className="json-view">{JSON.stringify(payload, null, 2)}</pre>;
}

function StatePanel({ title, data }: { title: string; data: unknown }) {
  return (
    <section className="panel state-panel">
      <h2>{title}</h2>
      <pre className="state-json">{JSON.stringify(data, null, 2)}</pre>
    </section>
  );
}

function SectionTitle({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <div className="section-title">
      <Icon size={16} />
      <span>{label}</span>
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: React.ReactNode }) {
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

function appStateView(state: Snapshot["state"]) {
  return {
    patient: state.app.patientId,
    networkSubscription: state.app.networkSubscriptionId ?? null,
    knownSources: Object.values(state.app.knownSources).map((source) => ({
      id: source.id,
      name: source.name,
      discoveredBy: source.discoveredBy,
    })),
    feedSubscriptions: Object.values(state.app.feedSubscriptions),
    sourceTokens: Object.keys(state.app.sourceTokens),
    lastNetworkEventNumber: state.app.lastNetworkEventNumber,
    seenActivityIds: state.app.seenActivityIds,
    recentDecisions: state.app.decisions.slice(0, 5),
  };
}

function networkStateView(state: Snapshot["state"]) {
  return {
    disclosurePolicy: state.network.disclosurePolicy,
    eventCounter: state.network.eventCounter,
    dropNextWebhook: state.network.dropNextWebhook,
    handles: Object.entries(state.network.handles).map(([handle, value]) => ({
      handle,
      sourceId: value.sourceId,
      createdAt: value.createdAt,
    })),
    sources: Object.values(state.sources).map((source) => ({
      id: source.id,
      feedEnabled: source.feedEnabled,
      sensitive: source.sensitive,
    })),
  };
}

function actorLabel(actor?: string) {
  return actorItems.find((item) => item.id === actor)?.label ?? actor ?? "";
}
