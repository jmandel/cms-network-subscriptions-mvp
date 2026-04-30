import type {
  RouteHandler,
  SendInput,
  SimContext,
  SimRequest,
  SimResponse,
  SimulationState,
  TraceEvent,
} from "./types";

function now(state: SimulationState) {
  return state.clock?.now ?? new Date().toISOString();
}

function id(prefix: string, count: number) {
  return `${prefix}-${String(count).padStart(4, "0")}`;
}

function parsePath(path: string) {
  const [pathname, queryString = ""] = path.split("?");
  const params = new URLSearchParams(queryString);
  const query: Record<string, string | string[]> = {};
  params.forEach((value, key) => {
    const existing = query[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing) {
      query[key] = [existing, value];
    } else {
      query[key] = value;
    }
  });
  return { pathname, query };
}

function matchPath(pattern: string, path: string) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) {
    return false;
  }
  return patternParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

export class SimKernel {
  private handlers: RouteHandler[] = [];
  private requestCount = 0;
  private traceCount = 0;

  constructor(private readonly state: SimulationState) {}

  register(handler: RouteHandler) {
    this.handlers.push(handler);
  }

  trace(event: Omit<TraceEvent, "id" | "at">) {
    this.traceCount += 1;
    this.state.trace.push({
      id: id("trace", this.traceCount),
      at: now(this.state),
      ...event,
    });
  }

  send = (input: SendInput): SimResponse => {
    this.requestCount += 1;
    const parsed = parsePath(input.path);
    const correlationId = input.correlationId ?? id("flow", this.requestCount);
    const request: SimRequest = {
      id: id("req", this.requestCount),
      from: input.from,
      to: input.to,
      method: input.method,
      url: `sim://${input.to}${input.path}`,
      path: parsed.pathname,
      query: parsed.query,
      headers: input.headers ?? {},
      body: input.body,
      correlationId,
    };

    this.trace({
      kind: input.kind ?? "request",
      actor: input.from,
      request,
      summary: input.summary ?? `${request.method} ${request.path}`,
      correlationId,
    });

    const handler = this.handlers.find(
      (candidate) =>
        candidate.actor === input.to &&
        candidate.method === input.method &&
        matchPath(candidate.pathPattern, request.path),
    );

    const context: SimContext = {
      send: this.send,
      trace: (event) => this.trace({ ...event, correlationId: event.correlationId ?? correlationId }),
      now: () => now(this.state),
      state: this.state,
    };

    const response = handler
      ? handler.handle(request, context)
      : {
          requestId: request.id,
          status: 404,
          headers: { "content-type": "application/json" },
          body: { error: "No route", method: request.method, path: request.path, actor: request.to },
        };

    this.trace({
      kind: response.status >= 400 ? "error" : "response",
      actor: input.to,
      request,
      response,
      summary: `${response.status} ${request.method} ${request.path}`,
      correlationId,
    });

    return response;
  };
}
