# CMS Aligned Networks: Network Activity Notifications

Draft proposal for a minimal network-level activity notification capability.

Live simulator: <https://joshuamandel.com/cms-network-subscriptions-mvp/>

This branch is intentionally standalone. It explores a small control-plane MVP:

- Networks notify authorized clients that patient-relevant activity may exist.
- Network webhooks are empty wake-up signals; clients retrieve authoritative activity details with `$events`.
- Retrieved activity events may be fully opaque or may include optional data-holder and follow-up hints.
- Clinical detail is discovered and retrieved through follow-up paths such as RLS, network query, follow-up search/read, or Patient Data Feed subscriptions at data-holder FHIR endpoints.

Start with [index.md](index.md).

Run the browser simulator:

```sh
bun install
bun run dev
```

The GitHub Pages workflow builds the app with:

```sh
BASE_PATH=/cms-network-subscriptions-mvp/ bun run build
```

Additional working notes:

- [design-review.md](design-review.md) critiques the initial draft and records the adjustments made after an implementability pass.
- [reference-implementation.md](reference-implementation.md) lays out a browser-based simulation dashboard plan.
