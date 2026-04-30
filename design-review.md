# Design Review Notes

This note records an implementability critique of the initial standalone draft and the changes made in response.

## Critique

1. The first draft had the right separation between network control-plane signals and data-holder data-plane feeds, but it tried to encode too much workflow policy in the notification.
2. The draft said the network should avoid data-holder-specific patient context, but that rule was buried in prose. It needed to become a design principle and conformance requirement.
3. The model treated every activity signal as equally strong. In practice, networks may passively observe hard events, inferred relationship changes, or weak hints. The spec needed a way to express that without exposing the evidence.
4. The opaque-handle idea was present, but the binding was not crisp enough for implementation. The MVP now treats `activity-handle` as network/RLS narrowing state, passed only where the receiving workflow documents how to use it.
5. The examples showed useful cases, but the suggested-action and follow-up URL machinery was too much for the MVP.
6. The first branch did not yet describe how to demonstrate the idea. The protocol is easiest to understand when users can trigger high-level events, watch notifications arrive, and inspect the follow-up traffic.

## Adjustments Made

- Added `confidence` with `confirmed`, `probable`, and `possible` values.
- Promoted "no data-holder-specific patient context in the network signal" into the design principles and conformance summary.
- Removed `client-action` from the wire and made client behavior derive from the most specific useful hint.
- Replaced explicit follow-up instructions with repeatable `activity-type` tags plus optional data-holder organization and endpoint hints.
- Removed `resource-type` and follow-up URL templates from the MVP core so clients use ordinary discovery, `/metadata`, search, read, and Patient Data Feed subscription capabilities.
- Switched network activity delivery to full-resource webhooks that carry the NetworkActivitySignal `Parameters` resource inline.
- Clarified that data-holder hints require data-holder authorization before a data-holder-specific patient id is available.
- Added [reference-implementation.md](reference-implementation.md) to define a browser-based simulation dashboard.

## Remaining Tension

The proposal still intentionally leaves some things loose:

- It does not require a network to reveal a data holder even when the network knows one.
- It does not define consent or patient preference infrastructure.

Those choices preserve the MVP shape. The reference implementation should make these tradeoffs visible by letting users switch network disclosure policies and compare the resulting traffic.
