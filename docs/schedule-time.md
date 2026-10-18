# Schedule time calculations

The feature package pins `@js-temporal/polyfill` 0.5.1 for IANA-zone calendar arithmetic and explicit daylight-saving disambiguation. The [upstream package manifest](https://github.com/js-temporal/temporal-polyfill/blob/v0.5.1/package.json) provides CommonJS/ESM exports, requires Node 12 or newer, and declares `jsbi` as its runtime dependency. The standalone lockfile owns both; the root workspace gains no dependency.

The [Temporal time-zone documentation](https://tc39.es/proposal-temporal/docs/timezone.html) distinguishes local calendar values from absolute instants and exposes explicit repeated/skipped-time choices. Compatibility tests load both module formats and verify a repeated-hour fixture. Domain fixtures will define Escalator's rotation, override and working-hour behavior; adding the library alone does not activate scheduling.

## Rotation and availability policy

Rotation anchors are local ISO calendar values plus an IANA zone. Each shift advances by calendar days, then converts its boundaries to absolute UTC instants. A daily shift can therefore last 23, 24, 25 or a fractional number of hours. Intervals include their start and exclude their end. The default `compatible` choice uses the first repeated handoff and moves a nonexistent handoff forward through the gap; a revision can explicitly choose `earlier` or `later`. Skipped whole dates advance the calendar rotation but create no zero-length assignment.

Approved overrides precede rotations. Overlapping approved overrides for different responders are rejected. Higher rotation priority wins; equal priority and equivalent overlapping overrides use ascending stable IDs. Draft overrides have no effect. Disabled schedules and uncovered time produce explicit gaps, not an implicit recipient. A revision cannot repeat a rotation/override ID or a member in one rotation.

Working hours are separate from on-call duty. Weekly windows support overnight spans; both occurrences of a repeated local working-hour window count as declared availability. An on-call primary is still selected outside working hours. Availability never proves somebody is awake.

Preview sweeps exact shift/override boundaries, includes gaps, and is bounded to 31 days and 2,000 boundaries. The effective preview interval may be shorter than its source rotation interval. The host schedule adapters/UI will persist revisions and previews in subsequent Phase 2 parts; no scheduling is activated by this domain-only change.

Fixtures include New York spring/fall transitions, Lord Howe's half-hour change, and Samoa's skipped date, consistent with the [IANA timezone source](https://data.iana.org/time-zones/tzdb-2024a/australasia). Tests also exercise override conflicts, finite rotations, deterministic priority, working hours and invalid configuration. Host ICU/timezone data must be available; future schedule calculations follow that data while persisted UTC deadlines remain absolute.

## Escalation policy snapshots

The default ladder targets primary at 0/2/7 minutes, peer at 12, and fallback at 17. Each page receives a copied, frozen policy revision; later edits cannot change its ladder. Step offsets are absolute durations from page creation, independent of local clock transitions.

Terminal behavior is required configuration: choose the fallback reminder interval/count and the recipients of a final operator notification. Exhaustion leaves the page open. After the bounded reminders and final notification there is no implicit acknowledgement or resolution.

On restart, the planner selects only the current overdue level and marks older pending levels skipped. Recorded intents prevent regression or duplicate dispatch, including after a clock adjustment. Acknowledgement/resolution cancels all remaining intents. The planner does not call providers: persistence will atomically save its decision and freeze each step's recipients before delivery retries in later Phase 2 parts.
