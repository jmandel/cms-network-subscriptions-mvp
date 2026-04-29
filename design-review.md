# Design Review Notes

This note records an implementability critique of the initial standalone draft and the changes made in response.

## Critique

1. The first draft had the right separation between network control-plane signals and source data-plane feeds, but the action model was too implicit. A developer could see `query-source` or `subscribe-source` without knowing which parameters are required.
2. The draft said the network should avoid source-specific patient context, but that rule was buried in prose. It needed to become a design principle and conformance requirement.
3. The model treated every activity signal as equally strong. In practice, networks may passively observe hard events, inferred relationship changes, or weak hints. The spec needed a way to express that without exposing the evidence.
4. The opaque-handle idea was present, but the binding was not crisp enough for implementation. A simulation or reference client needs to know whether a handle is passed as a FHIR operation parameter, query parameter, body field, or header.
5. The examples showed useful cases, but the spec needed a more complete parameter vocabulary for suggested actions so examples are not the only source of truth.
6. The first branch did not yet describe how to demonstrate the idea. The protocol is easiest to understand when users can trigger high-level events, watch notifications arrive, and inspect the follow-up traffic.

## Adjustments Made

- Added `confidence` with `confirmed`, `probable`, and `possible` values.
- Promoted "no source-scoped patient context in the network signal" into the design principles and conformance summary.
- Added required and optional parameters for each suggested action.
- Added a defined part vocabulary for `suggested-action`.
- Clarified that source actions require source authorization before source-scoped patient context is available.
- Added [reference-implementation.md](reference-implementation.md) to define a browser-based simulation dashboard.

## Remaining Tension

The proposal still intentionally leaves some things loose:

- It does not pick one universal binding for `activity-handle`.
- It does not define the network query operation behind `query-network`.
- It does not require a network to reveal a source even when the network knows one.
- It does not define consent or patient preference infrastructure.

Those choices preserve the MVP shape. The reference implementation should make these tradeoffs visible by letting users switch network disclosure policies and compare the resulting traffic.
