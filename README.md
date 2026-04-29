# CMS Aligned Networks: Network Activity Notifications

Draft proposal for a minimal network-level activity notification capability.

This branch is intentionally standalone. It explores a small control-plane MVP:

- Networks notify authorized clients that patient-relevant activity may exist.
- Notifications may be fully opaque or may include optional source and action hints.
- Clinical detail is discovered and retrieved through follow-up paths such as RLS, network query, source query, or source-level US Core Patient Data Feed subscriptions.

Start with [index.md](index.md).

Additional working notes:

- [design-review.md](design-review.md) critiques the initial draft and records the adjustments made after an implementability pass.
- [reference-implementation.md](reference-implementation.md) lays out a browser-based simulation dashboard plan.
