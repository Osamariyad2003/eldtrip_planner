# ELD Trip Planner — Architecture

Oct 7, 2026 · Companion to `ELD Trip Planner — Software Requirements Specification.md` (v1.0) and `README.md`.

> **Source of truth.** The SRS in this repository is the contract. The project-description
> placeholder in the request was empty, so every requirement reference below (`FR-…`, `BR-…`,
> `NFR-…`, `AC-…`, `API-…`, `INT-…`) points at that document. Where this architecture departs
> from the SRS, it is called out explicitly under §12 and §13 rather than silently assumed.
>
> **This is not a greenfield design.** The system is built and deployed. The backend is already
> close to Clean Architecture — the HOS domain is a genuinely pure, framework-free core. So this
> document describes the **target** architecture as a small delta from what exists, names the
> real boundary violations with file and line references, and says which abstractions are worth
> adding and which would be ceremony.

---

## 1. Architecture overview

Two deployable units, one shared contract, and one rule that matters more than any other:
**the HOS rulebook is a pure function and nothing may make it otherwise.**

```
┌─────────────────────────────── Browser (Vercel) ───────────────────────────────┐
│  Presentation      AppShell · TripForm · TripMap · LogSheet · DirectionsView   │
│       ↓            (render only — no rules, no fetch)                          │
│  Application       usePlanTrip · useLogPdfExport · useLiveStatus · useToast    │
│       ↓            (workflow, state transitions, error→field mapping)          │
│  Client domain     form validation mirror · duty-status vocabulary             │
│       ↓                                                                        │
│  Infrastructure    apiClient (fetch) · localStorage history · jsPDF/svg2pdf   │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │  HTTPS / JSON, §8.1 contract
┌───────────────────────────────────▼──── Django service (Render) ──────────────┐
│  Presentation      views · request serializers · response presenters ·        │
│       ↓            DRF exception handler · throttle · request-log middleware  │
│  Application       PlanTripUseCase · SuggestPlacesUseCase · ReportHealth      │
│       ↓            depends on PORTS only                                      │
│  Domain (pure)     hos/engine · hos/logbuilder · hos/geometry ·               │
│                    HosConfig · DutyEvent · DailyLog · trip policies           │
│       ↑ implements ports                                                       │
│  Infrastructure    PeliasGeocoder · NominatimGeocoder · CachingGeocoder ·     │
│                    OrsRouter · OsrmRouter · TimezoneFinderResolver · cache    │
└───────────────────────────────┬───────────────────────────────────────────────┘
                                │ INT-01..04
                  OpenRouteService · Nominatim · OSRM · timezonefinder
```

**Why the domain sits where it does.** `OBJ-1` is zero HOS rule violations, verified by a 500-case
property suite (`AC-03`) and an exact reference-schedule fixture (`AC-01`). That is only
achievable if the rulebook can be executed millions of times with no clock, no socket and no
database. `NFR-REL-01` (byte-identical output for identical input) and `NFR-PERF-02` (engine +
log builder ≤ 200 ms) are the same requirement wearing different hats. Everything else in the
architecture exists to keep that core clean.

---

## 2. Architecture decisions and justification

### ADR-1 — Modular layered architecture, not folder-per-layer Clean Architecture

**Decision.** Keep four *named, enforced* layers inside one Django app, expressed as packages
(`domain/`, `application/`, `infrastructure/`, `presentation/`) rather than four top-level
projects with interfaces for every collaborator.

**Why.** The prompt's own §9 rule — "Clean Architecture does not mean creating hundreds of
interfaces" — decides this. The system has **no persisted domain data** (SRS §7: "The system
stores no trip data"). There are no aggregates to load, no ORM entities, no transactions, no
repositories. The only persisted thing is a provider-response cache. Introducing
`ITripRepository`, `TripEntity` and a unit of work for a stateless request/response pipeline
would be pure overhead against `CON-03` (≤ 16 working hours) and would add no testability that
ports on the two real I/O boundaries do not already give.

**Consequence.** The boundary is enforced by an import rule (§13), not by package distance.

### ADR-2 — The domain is pure and framework-free; this is non-negotiable

**Decision.** No module under `planner/domain/` may import Django, DRF, `requests`,
`timezonefinder`, or anything in `infrastructure/` or `presentation/`.

**Status.** Already true. `hos/engine.py`, `hos/logbuilder.py`, `hos/geometry.py`,
`hos/config.py` and `hos/types.py` import only stdlib. This is the strongest property the
codebase has and it is why `AC-01`–`AC-05` are cheap to test.

**Enforcement.** Add a lint-enforced import ban (§10) so it cannot regress silently.

### ADR-3 — Two ports, three decorators, no more

**Decision.** The application layer depends on exactly four abstractions:

| Port | Why it earns its existence |
| --- | --- |
| `Geocoder` | Two real implementations (`INT-01`: Pelias primary, Nominatim fallback) + caching + fallback composition. Must be fakeable for `AC-08` and `NFR-REL-02`. |
| `Router` | Two real implementations (`INT-02`: ORS `driving-hgv`, OSRM car) with provider reported in the response (`FR-RTE-02`). |
| `TimezoneResolver` | One implementation, but `timezonefinder` costs ~100 MB of polygon data to import; tests and the engine must not pay for it (`INT-04`). |
| `Clock` | `BR-PLN-07`'s default start time is "next full hour" — a dependency on *now*. Without a port, the default-start-time rule is untestable without freezing global time. |

Everything else is a direct call. No `ILogger`, no `ICacheService`, no `IConfigProvider` —
Django's own cache and logging abstractions already are the seam, and wrapping them would be
the "abstraction for its own sake" the brief forbids.

**Why ports at all, given ADR-1 keeps things small?** Because today `planning.py` calls
`geocoding.geocode()`, `routing.route_trip()` and `timezones.zone_for()` as module-level
functions. The plan use case therefore **cannot be tested without patching modules**, which
violates the brief's testability requirement ("use cases can be tested without the real
database / external services can be mocked"). Ports convert monkeypatching into constructor
injection.

### ADR-4 — Composition over conditionals for provider fallback

**Decision.** Express `FR-GEO-01..03` and `FR-RTE-02` fallback as composed objects, not as
nested `try/except` inside one function:

```
CachingGeocoder( FallbackGeocoder([ PeliasGeocoder, RateLimitedGeocoder(NominatimGeocoder) ]) )
FallbackRouter([ OrsHgvRouter, OsrmCarRouter ])
```

**Why.** Today `providers/geocoding.py:82-140` repeats the same
`try ORS / except → try Nominatim / except → raise` ladder three times across `_suggest_uncached`,
`geocode` and `reverse`, and `providers/routing.py:88-127` nests it two deep. Adding a third
provider means editing every one of those branches — an Open/Closed violation. Composition
makes a new provider a new class plus one list entry, and makes the caching policy
(`FR-GEO-04`, ≥ 24 h TTL) testable in isolation from any provider.

### ADR-5 — Business rules currently living in adapters move into the domain

Three SRS business rules are implemented inside infrastructure today:

| Rule | Lives in now | Moves to |
| --- | --- | --- |
| `FR-RTE-05` 5,000-mile trip limit | `providers/routing.py:28` `MAX_TRIP_MILES` | `domain/policies.py` (checked by the use case) |
| `FR-INP-06` 0.5-mile same-place test | `providers/routing.py:_same_point` | `domain/policies.py` |
| `BR-PLN-07` defaults + BOL hash | `planning.py:_header`, `_bol`, `_start_time` | `domain/defaults.py` |

**Why it matters.** `FR-RTE-05` is a *product* rule, not a routing-provider fact. Leaving it in
the ORS adapter means the OSRM fallback path and any future provider each have to remember it,
and the rule cannot be unit-tested without an HTTP double.

### ADR-6 — Response shaping is presentation, not orchestration

**Decision.** The `_event_dict` / `_stop_dict` / `_log_dict` / `_summary` family moves out of
`planning.py` into `presentation/presenters/`.

**Why.** Those functions encode `API-04` — "distances in miles to 1 decimal; hours to 2
decimals" — which is a wire-format rule belonging to the HTTP boundary. Keeping them in the
use case is what makes `planning.py` 306 lines with three jobs (§4, PLAN-01).

### ADR-7 — The frontend gets a real application layer

**Decision.** `App.tsx` becomes a shell. The plan workflow, PDF export, toast lifecycle and
server-error→field mapping become named hooks under `src/app/`.

**Why.** `App.tsx` is 557 lines holding eleven `useState` calls, the whole submit workflow, the
error-mapping function, the PDF export orchestration (including a `document.querySelectorAll`
DOM scrape and a tab switch), the toast timer, and eight inline SVG icon components. It is the
one God class in the repository. Splitting it is the single highest-value structural change on
the client, and it is what makes `NFR-PERF-05` (log tab switch ≤ 100 ms) tunable, because
re-render scope stops being "everything".

### ADR-8 — The mock authentication gate must be removed or made real

**Decision.** `src/lib/auth.ts` as it stands does not ship.

**Why.** SRS §3 is unambiguous: "The system has no authentication. All public endpoints are
equal for every visitor." The current code contradicts that, and does so unsafely:

- a hardcoded bearer-looking token (`'samsara_jwt_token_88492049182'`) is compiled into the
  public bundle (`auth.ts:21`);
- `submit()` refuses to plan unless `isAuthenticated` (`App.tsx:60-64`), but the Django endpoints
  are `AllowAny` with no authentication classes (`config/settings.py:88-94`), so the gate blocks
  only the honest user — `curl` is unaffected;
- it presents a security property the system does not have, in an app labelled
  "v1.0.0 ENTERPRISE".

Two acceptable resolutions, in preference order: **(a)** delete the gate and the modal, keeping
the dispatcher identity as a *display-only* profile that pre-fills `FR-INP-03` log-detail
fields; **(b)** amend the SRS to add a real role model and implement server-side enforcement
(token issuance, verification middleware, `CORS_ALLOW_CREDENTIALS`, per-user rate limits). What
cannot stand is a client-side-only gate described as auth. §11 treats this as the top security
finding.

---

## 3. Layer responsibilities

### Domain — `backend/planner/domain/`

Owns every rule in SRS §6. Knows nothing about HTTP, JSON, Django, providers or time zones
beyond a `tzinfo` object handed to it.

- **Entities / records** — `DutyEvent` (ordered, contiguous, 15-minute-aligned), `DailyLog`,
  `LogSegment`, `Remark`, `Bracket`, `Recap`.
- **Value objects** — `HosConfig` (frozen, self-validating; `BR-CFG`), `LegGeometry`
  (polyline queryable by distance travelled), `EngineLeg` (carries `speed_mph` per `BR-PLN-08`),
  `Place`, `DutyStatus` / `EventKind` constants.
- **Domain services** — `schedule()` (`FR-HOS-01..08`), `build_daily_logs()` (`FR-LOG-01..09`),
  `trip_policies` (`FR-RTE-05`, `FR-INP-06`), `defaults` (`BR-PLN-07`).
- **Domain exceptions** — `ScheduleError` (`FR-HOS-08`), `LogInvalid` (`FR-LOG-04`),
  `TripTooLong`, `RouteNotFound` — all plain exceptions carrying a stable `code`, **no HTTP
  status**.

Forbidden here: `import django`, `import rest_framework`, `import requests`,
`import timezonefinder`, `datetime.now()` (the `Clock` port supplies it).

### Application — `backend/planner/application/`

One class per use case. Orchestrates ports and the domain; owns no rules and no wire format.

- `PlanTripUseCase.execute(command) -> TripPlan` — the `WF-1` step-6 workflow.
- `SuggestPlacesUseCase.execute(query) -> list[Place]` — `API-02`.
- `ReportHealthUseCase.execute() -> HealthStatus` — `API-03`, key *presence* only.
- Port protocols (`Geocoder`, `Router`, `TimezoneResolver`, `Clock`) and the command/result
  DTOs that cross the boundary.
- Application exceptions: `ProviderUnavailable`, `ProviderRateLimited` — again, no HTTP status.

### Infrastructure — `backend/planner/infrastructure/`

Implements the ports. May import anything.

- `geocoding/` — `PeliasGeocoder`, `NominatimGeocoder`, `CachingGeocoder` (decorator,
  `FR-GEO-04`), `FallbackGeocoder` (composite), `state_codes.py` (reference data).
- `routing/` — `OrsHgvRouter`, `OsrmCarRouter`, `FallbackRouter`, GeoJSON/OSRM response parsers.
- `http/` — the shared retry/timeout client (`INT-05`: 10 s timeout, ≤ 1 retry) and provider-call
  timing hooks (`NFR-OBS-01`).
- `timezones/TimezoneFinderResolver` (`INT-04`), `clock/SystemClock`,
  `cache/DjangoCacheStore`.
- `container.py` — the one place that wires concrete implementations into use cases, reading
  `settings`. Nothing else in the codebase constructs an adapter.

### Presentation — `backend/planner/presentation/`

Thin. Parses, delegates, formats, maps errors onto HTTP.

- `views.py` — three functions, each ≤ 10 lines: validate → call use case → present.
- `serializers/` — request validation only (`NFR-SEC-03`: every §4 rule re-checked server-side).
- `presenters/` — domain objects → `API-01`/`API-02` JSON with `API-04` rounding.
- `error_handler.py` — the **only** module that knows HTTP status codes; maps each domain /
  application exception onto a §10 row.
- `throttling.py` (`API-05`), `middleware.py` (`NFR-OBS-01/02`), `urls.py` (`ERR-02`).

### Frontend layers

| Layer | Directory | Holds |
| --- | --- | --- |
| Presentation | `src/components/`, `src/ui/` | Render + local UI state only. `LogSheet` draws an SVG from a `DailyLog` and computes nothing else. |
| Application | `src/app/` | `usePlanTrip`, `useLogPdfExport`, `useToast`, `useTripHistory`, `useLiveStatus` — workflows and state machines. |
| Client domain | `src/domain/` | `form.ts` validation mirror, `vocab.ts` status/stop vocabulary, `liveStatus` phase logic. Pure, unit-testable, no React. |
| Infrastructure | `src/infrastructure/` | `apiClient.ts` (fetch, 90 s timeout, `ApiError`), `historyStore.ts` (localStorage), `pdfExporter.ts` (jsPDF/svg2pdf, lazy-loaded per `NFR-PERF-04`). |

The client validation in `src/domain/form.ts` is a deliberate, documented **duplicate** of the
server rules — `NFR-SEC-03` requires server-side validation regardless, and the client copy
exists only to report problems before a request. It is the one place DRY is knowingly broken,
and the file says so.

---

## 4. Module breakdown

### Backend

#### `domain/hos` — HOS scheduling engine

- **Layer** Domain · **Requirements** `FR-HOS-01..08`, `BR-HOS-01..06`, `BR-PLN-01..05`, `BR-PLN-08`
- **Files** `engine.py` (the chunking loop), `types.py`, `config.py`, `geometry.py`
- **Dependencies** stdlib only
- **Interactions** called by `PlanTripUseCase`; its `DutyEvent` output is the input to the log builder
- **Design note** The loop's shape is the design: each chunk is `min()` of six allowances —
  drive time, 14-hour window, time to the next break, cycle hours, miles to fuel, miles left in
  the leg — so a chunk always ends at the first limit reached (`FR-HOS-02`), and *which*
  allowance bound it selects the stop to insert by `BR-PLN-04` precedence. This is the one place
  in the system where cyclomatic density is justified, and it is covered to ≥ 90 % by CI gate.
- **Change needed** None structurally. `_Engine` is cohesive and correctly private.

#### `domain/hos/logbuilder.py` — daily log builder

- **Layer** Domain · **Requirements** `FR-LOG-01..09`, `BR-LOG-01..03`
- **Dependencies** `hos/types`, `hos/config`
- **Interactions** consumes `DutyEvent[]` + a resolved header dict; produces `DailyLog[]`
- **Change needed** Absorb `planning.py:_fill_day_endpoints`. Setting each sheet's From/To from
  the day's first and last driving event is `FR-LOG-09`, a log rule — it currently runs in the
  orchestration layer and mutates `DailyLog.header` *after* the builder has validated the day
  (`planning.py:303-306`). Post-hoc mutation of a validated aggregate from an outer layer is
  the subtlest boundary violation in the backend.

#### `domain/policies.py`, `domain/defaults.py` — *new*

- **Layer** Domain · **Requirements** `FR-RTE-05`, `FR-INP-06`, `BR-PLN-07`
- **Holds** `exceeds_max_trip_distance()`, `is_same_place()`, `resolve_log_header()`,
  `default_start_time(clock, zone)`, `shipping_document_for()`
- **Why separate from `hos/`** These are trip-planning rules, not duty-status rules; keeping
  them out of `hos/` preserves the engine's single responsibility.

#### `application/plan_trip.py` — `PlanTripUseCase`

- **Layer** Application · **Requirements** `WF-1` step 6, `API-01`
- **Dependencies** `Geocoder`, `Router`, `TimezoneResolver`, `Clock`, `HosConfig`, domain services
- **Interactions** the only module that knows the full pipeline:
  resolve locations → resolve time zone → route → check distance policy → schedule →
  label events → build logs → assemble `TripPlan`
- **Change needed** Extracted from today's `planning.py`, which also owns defaults and wire
  format. Target ≤ 120 lines with each step a named private method.

#### `infrastructure/geocoding` — geocoding adapters

- **Layer** Infrastructure · **Requirements** `FR-GEO-01..04`, `INT-01`
- **Change needed** `providers/geocoding.py` is 317 lines with five responsibilities: two
  provider protocols, a caching policy, fallback orchestration, a 1 req/s client-side throttle
  with module-global mutable state, and a 51-entry US state-code table. Split per ADR-4.
- **Known risk** `_nominatim_last_call` is a *per-process* global (`geocoding.py:36-38`).
  `NFR-SCL-01` requires a stateless backend that scales horizontally; with N gunicorn workers
  the effective Nominatim rate is N req/s, breaching `INT-01`'s usage policy. The throttle must
  move to the shared cache (same mechanism as `throttling.py`) or be accepted and documented
  with a single-worker deployment constraint.

#### `infrastructure/routing` — routing adapters

- **Layer** Infrastructure · **Requirements** `FR-RTE-01..04`, `INT-02`
- **Change needed** Extract `MAX_TRIP_MILES` and `_same_point` to `domain/policies.py` (ADR-5).
  Move `combined_geometry()`'s `simplify(..., 2000)` call (`FR-RTE-04`) to the presenter — the
  2,000-point cap is a response-payload budget, not a routing fact. Drop the
  function-local `from ..hos.geometry import haversine_mi` inside `_same_point`
  (`routing.py:271`), a circular-import workaround that disappears once the policy moves.

#### `presentation/` — HTTP boundary

- **Layer** Presentation · **Requirements** `API-01..06`, §10, `ERR-02`, `NFR-OBS-01/02`
- **Change needed** Two items. First, `enforce_rate_limit(request)` is called imperatively as the
  first line of each view (`views.py:20, 29`) but **not** in `health` — a new endpoint silently
  ships unthrottled. Declare it as a DRF throttle class on the view instead, so the default is
  "limited" (`API-05`). Second, the client-supplied `X-Request-ID` is adopted verbatim
  (`middleware.py:18` → `request_context.begin`) and echoed into both the structured log and
  the response header; see §11.

### Frontend

#### `app/usePlanTrip.ts` — *new*, extracted from `App.tsx`

- **Layer** Application · **Requirements** `FR-INP-05`, `WF-1`, `WF-4`, §10 UI behaviour
- **Holds** validate → guard in-flight → call `apiClient.planTrip` → on success set plan, clear
  selection, record history → on `ApiError` map `fields` to inputs or raise a toast → manage the
  `COLD_START_NOTICE_MS` slow-server notice (`FR-UI-08`)
- **Dependencies** `apiClient`, `domain/form`, `historyStore`
- **Testable** with a fake `apiClient`; no network, no DOM.

#### `app/useLogPdfExport.ts` — *new*

- **Layer** Application · **Requirements** `FR-EXP-01`
- **Change needed** The current implementation (`App.tsx:117-143`) switches the active tab, waits
  two animation frames, then scrapes `document.querySelectorAll('svg.log-sheet')` and sorts by a
  `data-day-index` attribute. Export therefore depends on which tab is open and on a CSS class
  surviving refactors — a presentation→infrastructure coupling that fails silently. Target:
  `LogView` registers each sheet's `SVGSVGElement` ref in a context; the hook reads the registry
  and never touches `document`.

#### `components/LogSheet.tsx` — the drawn FMCSA sheet

- **Layer** Presentation · **Requirements** `FR-UI-01..05`, `NFR-ACC-02`, `AC-06`
- **Assessment** 781 lines, but correctly so: it is one cohesive SVG renderer built from small
  named sub-components (`Masthead`, `HourAxis`, `Grid`, `TotalsColumn`, `Brackets`,
  `RemarkTicks`, `RemarksPanel`, `DetailPanels`, `InspectionStrip`) over module-level geometry
  constants. It computes no business values — it reads `DailyLog` and draws. **No change.**
  This is the right shape for a drawing component and should not be split for line count alone.

#### `lib/apiAdapter.ts` — **delete**

- **Requirements** none
- **Why** It defines a 60-line parallel `ContractPlanResponse` type system, computes it on every
  plan via `adaptTripPlanToContract`, and the sole caller discards it:
  `const { plan: resultPlan } = await planTripContract(candidate)` (`App.tsx:69`) — the
  `contract` half is never read. It also hardcodes `'Alex Vance'`, `'Spotter Logistics Corp.'`,
  `'Dallas, TX'` as log-detail defaults, duplicating `BR-PLN-07` which the backend already owns
  and contradicting its values. This is a dead abstraction plus a DRY violation on a business
  rule. `App` should call `apiClient.planTrip` directly. If an external "telematics contract"
  consumer genuinely exists, the adapter belongs behind its own entry point with its own test,
  not on the hot path of the UI.

#### `lib/auth.ts`, `components/AuthModal.tsx` — remove or make real

See ADR-8 and §11. Blocking item before any release that claims the "Enterprise" framing.

#### `components/TripSummaryPanel.tsx` — **unreferenced**

`TripSummaryPanel` and `AssumptionsPanel` are exported and imported by nothing. The consequence
is lost requirement coverage, not just dead code — see §12, UI-01/UI-02.

---

## 5. Complete project structure

Only `(new)` and `(moved)` entries differ from the repository today.

```
eldtrip_planner/
├── ELD Trip Planner — Software Requirements Specification.md
├── README.md
├── render.yaml                                  DEP-04
├── docs/ARCHITECTURE.md                         (new) this document
├── .github/workflows/ci.yml                     DEP-02, NFR-MNT-01/02
│
├── backend/
│   ├── manage.py
│   ├── requirements.txt · requirements-dev.txt  DEP-03
│   ├── ruff.toml · pytest.ini
│   ├── .env.example                             DEP-01
│   ├── config/
│   │   ├── settings.py                          NFR-SEC-01..05, DEP-01
│   │   ├── settings_test.py                     CI: providers mocked, no keys
│   │   ├── urls.py · wsgi.py
│   └── planner/
│       ├── apps.py
│       ├── domain/                              (moved from planner/hos/)
│       │   ├── __init__.py                       the domain's public surface
│       │   ├── config.py                         HosConfig — BR-CFG
│       │   ├── types.py                          DutyEvent, EngineLeg, statuses, kinds
│       │   ├── geometry.py                       LegGeometry, haversine, simplify
│       │   ├── engine.py                         schedule() — FR-HOS-01..08
│       │   ├── logbuilder.py                     build_daily_logs() — FR-LOG-01..09
│       │   ├── policies.py                      (new) FR-RTE-05, FR-INP-06
│       │   ├── defaults.py                      (new) BR-PLN-07 defaults, BOL hash
│       │   └── errors.py                        (new) ScheduleError, LogInvalid,
│       │                                              TripTooLong, RouteNotFound
│       ├── application/                         (new)
│       │   ├── ports.py                          Geocoder, Router,
│       │   │                                     TimezoneResolver, Clock
│       │   ├── dto.py                            PlanTripCommand, TripPlan, Place
│       │   ├── errors.py                         ProviderUnavailable,
│       │   │                                     ProviderRateLimited
│       │   ├── plan_trip.py                      PlanTripUseCase — WF-1 step 6
│       │   ├── suggest_places.py                 SuggestPlacesUseCase — API-02
│       │   └── report_health.py                  ReportHealthUseCase — API-03
│       ├── infrastructure/                      (moved from planner/providers/)
│       │   ├── container.py                     (new) the only wiring point
│       │   ├── http/client.py                    retry + timeout — INT-05
│       │   ├── geocoding/
│       │   │   ├── pelias.py                     PeliasGeocoder — INT-01 primary
│       │   │   ├── nominatim.py                  NominatimGeocoder — INT-01 fallback
│       │   │   ├── caching.py                   (new) CachingGeocoder — FR-GEO-04
│       │   │   ├── fallback.py                  (new) FallbackGeocoder
│       │   │   └── state_codes.py               (new) reference data
│       │   ├── routing/
│       │   │   ├── ors_hgv.py                    OrsHgvRouter — INT-02 primary
│       │   │   ├── osrm_car.py                   OsrmCarRouter — FR-RTE-02
│       │   │   └── fallback.py                  (new) FallbackRouter
│       │   ├── timezones.py                      TimezoneFinderResolver — INT-04
│       │   └── clock.py                         (new) SystemClock
│       ├── presentation/                        (moved from planner/*.py)
│       │   ├── urls.py                           API-01..03, ERR-02
│       │   ├── views.py                          thin — validate, delegate, present
│       │   ├── serializers.py                    request validation — NFR-SEC-03
│       │   ├── presenters.py                    (new) domain → JSON, API-04
│       │   ├── error_handler.py                  the only HTTP-status mapper — §10
│       │   ├── throttling.py                     API-05
│       │   ├── middleware.py                     NFR-OBS-01/02
│       │   ├── request_context.py                request id, provider timing
│       │   └── logging_config.py                 structured JSON logs
│       └── tests/
│           ├── domain/      test_engine · test_logbuilder · test_invariants ·
│           │                test_adversarial · test_geometry · test_policies
│           ├── application/ test_plan_trip        (new) fake ports, no network
│           ├── infrastructure/ test_geocoding · test_routing · test_caching
│           └── api/         test_api · test_errors · test_throttling
│
└── frontend/
    ├── index.html · vite.config.ts · vercel.json
    ├── public/            spotter_logo.jpg, status GIFs, favicon
    ├── scripts/render-sheet.tsx    offline SVG render for AC-06 review
    └── src/
        ├── main.tsx
        ├── index.css
        ├── App.tsx                        (shrinks to a shell, ~80 lines)
        ├── app/                           (new) application layer
        │   ├── usePlanTrip.ts              WF-1, WF-4, FR-INP-05
        │   ├── useLogPdfExport.ts          FR-EXP-01
        │   ├── useTripHistory.ts           browser-only recents
        │   ├── useLiveStatus.ts           (moved) follow-the-plan clock
        │   └── useToast.ts                 §10 toast lifecycle
        ├── domain/                        (moved from src/lib/)
        │   ├── types.ts                    the §7.1 / §8.1 contract types
        │   ├── form.ts                     client validation mirror — §4.1
        │   └── vocab.ts                    status + stop vocabulary, formatters
        ├── infrastructure/
        │   ├── apiClient.ts               (moved from lib/api.ts)
        │   ├── historyStore.ts            (moved from lib/history.ts)
        │   └── pdfExporter.ts             (moved from lib/pdf.ts)
        ├── layout/                        (new) extracted from App.tsx
        │   ├── AppShell.tsx                top bar, tabs, footer — FR-UI-09
        │   └── Workspace.tsx               3-pane split, empty + skeleton states
        ├── ui/icons.tsx                   (new) the eight inline SVG icons
        └── components/
            ├── TripForm.tsx                FR-INP-01..05
            ├── LocationField.tsx           FR-GEO-01, 300 ms debounce
            ├── TripMap.tsx                 FR-MAP-01..03
            ├── StopTimeline.tsx            FR-MAP-04, FR-MAP-06
            ├── DirectionsView.tsx          FR-MAP-05
            ├── LogView.tsx                 FR-UI-06, sheet ref registry
            ├── LogSheet.tsx                FR-UI-01..05, NFR-ACC-02
            ├── TripSummaryPanel.tsx        FR-MAP-06 + FR-UI-07 — must be mounted
            ├── NoticeList.tsx             (new) renders plan.notices — see §12
            ├── LiveStatusCard.tsx · DriverStatusChip.tsx
            └── HistoryMenu.tsx
```

---

## 6. Dependency flow

```
presentation ──→ application ──→ domain
     │                │              ▲
     │                └── ports ─────┤
     └──────────────────────────────┐│
                                    ││
infrastructure ──→ application.ports┘│  (implements)
infrastructure ──→ domain ───────────┘  (constructs domain types)
```

Permitted imports, exhaustively:

| From | May import |
| --- | --- |
| `domain` | stdlib only |
| `application` | `domain`, `application` |
| `infrastructure` | `application.ports`, `application.errors`, `domain`, Django, `requests`, libraries |
| `presentation` | `application`, `domain.errors`, Django, DRF |
| `infrastructure.container` | everything (the composition root) |

**The one violation in the backend today.** `planner/providers/geocoding.py:24` and
`planner/providers/routing.py:17` import `from ..errors import NotFound, ProviderUnavailable,
RateLimited, RouteNotFound` — and `planner/errors.py` imports `rest_framework.status`,
`rest_framework.response` and `django.http`. So an infrastructure adapter reaches *outward* into
the presentation layer and, in raising `RateLimited`, decides the HTTP status code 429 from
inside an HTTP-client wrapper.

**Fix.** Adapters raise `application.errors.ProviderRateLimited` / `ProviderUnavailable` and
`domain.errors.RouteNotFound` — none of which know about HTTP. `presentation/error_handler.py`
holds the single mapping table:

| Exception | Code | HTTP | §10 row |
| --- | --- | --- | --- |
| `serializers.ValidationError` | `validation_error` | 400 | inline field messages |
| `PlaceNotFound` | `not_found` | 400 | inline under that field |
| `RouteNotFound` | `route_not_found` | 422 | toast naming the leg |
| `TripTooLong` | `trip_too_long` | 422 | toast with the limit |
| `ProviderRateLimited` / throttle | `rate_limited` | 429 | retry-in-a-minute toast |
| `ProviderUnavailable` | `provider_unavailable` | 503 | toast + Retry |
| `ScheduleError` | `schedule_failed` | 500 | generic toast + request id |
| `LogInvalid` | `log_invalid` | 500 | generic toast + request id |
| anything else | `internal_error` | 500 | generic toast, stack trace logged only |

One table, one layer, `NFR-REL-02` satisfied by construction: no provider failure can escape as
an unhandled 500 because the adapters can only raise from a closed set.

---

## 7. Key interfaces and abstractions

```python
# application/ports.py  — the entire abstraction surface of the backend.

class Geocoder(Protocol):
    def suggest(self, query: str) -> list[Place]: ...          # FR-GEO-01
    def geocode(self, label: str) -> Place: ...                # FR-GEO-02
    def reverse(self, lat: float, lng: float) -> str: ...      # FR-GEO-03

class Router(Protocol):
    def route(self, waypoints: Sequence[Waypoint]) -> RouteResult: ...   # FR-RTE-01..03

class TimezoneResolver(Protocol):
    def zone_for(self, lat: float, lng: float) -> ZoneResolution: ...    # BR-PLN-06, INT-04

class Clock(Protocol):
    def now(self, zone: ZoneInfo) -> datetime: ...             # BR-PLN-07
```

```python
# application/plan_trip.py
class PlanTripUseCase:
    def __init__(self, geocoder: Geocoder, router: Router,
                 timezones: TimezoneResolver, clock: Clock,
                 config: HosConfig = DEFAULT_CONFIG) -> None: ...

    def execute(self, command: PlanTripCommand) -> TripPlan: ...
```

```python
# domain — pure functions, unchanged in signature from today.
def schedule(legs: list[EngineLeg], cycle_used_hr: float,
             start: datetime, config: HosConfig) -> list[DutyEvent]: ...

def build_daily_logs(events: list[DutyEvent], header: LogHeader,
                     cycle_used_hr: float, config: HosConfig) -> list[DailyLog]: ...
```

`HosConfig` (frozen dataclass, validating in `__post_init__`) is the abstraction that makes
`FR-HOS-07` real: tests construct `HosConfig(pre_trip_min=0)` to reproduce the `AC-01` fixture
exactly, and the Operator changes a limit in one module and redeploys (§6.4). It is the only
configuration object the domain accepts, which is why no HOS constant appears as a literal
anywhere else in the backend.

On the client, the one abstraction worth naming:

```ts
export interface PlannerApi {
  planTrip(form: TripFormState): Promise<TripPlan>      // API-01
  geocode(query: string, signal?: AbortSignal): Promise<Place[]>  // API-02
}
```

`usePlanTrip(api: PlannerApi)` then tests against an in-memory fake, with no MSW and no network.

---

## 8. Data flow for important use cases

### UC-1 · Plan a trip — `POST /api/trips/plan/` (`WF-1`, `API-01`)

```
Browser  TripForm.onSubmit
   └─ usePlanTrip: domain/form.validate → inline errors, or
        apiClient.planTrip ─────────────────────────────────────────┐
                                                                    ▼
presentation.views.plan
   ├─ throttle (API-05) ─── over limit ──→ 429 rate_limited
   ├─ TripRequestSerializer (NFR-SEC-03) ── invalid ──→ 400 validation_error + fields
   └─ container.plan_trip_use_case().execute(command)
         │
         │  application.PlanTripUseCase
         ├─ 1. Geocoder.geocode ×3, or reverse() for supplied coords   FR-GEO-02/03
         │       └─ CachingGeocoder hit → no provider call             FR-GEO-04
         │       └─ miss → Pelias → on failure Nominatim → else 503    INT-01
         ├─ 2. TimezoneResolver.zone_for(current)                      BR-PLN-06
         │       └─ unresolved → America/Chicago + notice              INT-04
         ├─ 3. Router.route([current, pickup, dropoff])                FR-RTE-01
         │       └─ ORS driving-hgv → on failure OSRM car + notice     FR-RTE-02
         │       └─ unroutable leg → RouteNotFound                     FR-RTE-01
         ├─ 4. domain.policies.exceeds_max_trip_distance → TripTooLong FR-RTE-05
         ├─ 5. domain.defaults.default_start_time(clock, zone)         BR-PLN-07
         ├─ 6. domain.engine.schedule(legs, cycle, start, config)      FR-HOS-01..08
         │       └── PURE. no I/O. deterministic.                      NFR-REL-01
         ├─ 7. label events: endpoints known, interpolated stops
         │       reverse-geocoded (cached, 3-dp key)                   FR-GEO-03
         ├─ 8. domain.defaults.resolve_log_header(command, places)     BR-PLN-07, FR-LOG-09
         ├─ 9. domain.logbuilder.build_daily_logs(...)                 FR-LOG-01..09
         │       └── asserts every day totals 24.00 → LogInvalid       BR-LOG-01
         └─ returns TripPlan (domain + application types, no JSON)
   └─ presenters.trip_plan(plan) → {summary, route, stops, events,
                                    daily_logs, notices, assumptions}  API-04
   └─ middleware: X-Request-ID header + one structured INFO log        NFR-OBS-01/02
                                                                        │
Browser  usePlanTrip ◄──────────────────────────────────────────────────┘
   ├─ setPlan → TripMap, StopTimeline, LogView, NoticeList, AssumptionsPanel
   └─ historyStore.remember(form, summary)
```

Note what step 6 is **not** doing: no clock read, no socket, no cache. Every input it needs was
resolved in steps 1–5. That is the whole point of the layering.

### UC-2 · Location autocomplete — `GET /api/geocode/?q=` (`FR-GEO-01`)

```
LocationField keystroke → 300 ms debounce → AbortController cancels in-flight
  → apiClient.geocode → throttle → GeocodeQuerySerializer (3–200 chars)
  → SuggestPlacesUseCase → CachingGeocoder (hit: ≤ 100 ms, NFR-PERF-03)
      miss → Pelias autocomplete, boundary.country=US, size=5
           → on failure Nominatim (1 req/s, identifying User-Agent)
           → both fail → 503 "Search unavailable, try again"
  → [{label, lat, lng}] ≤ 5 → suggestion list; empty → "No US matches"
```

### UC-3 · PDF export (`FR-EXP-01`)

```
AppShell "Export PDF" → useLogPdfExport
  ├─ sheetRegistry.all() — refs registered by LogView on mount
  │     (replaces today's tab-switch + two-frame wait + DOM querySelectorAll)
  ├─ lazy import jsPDF + svg2pdf.js            NFR-PERF-04: out of initial bundle
  ├─ per day: clone sheet, inline computed paint/font styles, draw to a
  │           US-Letter landscape page (vector, selectable text)      AC-09
  └─ failure → toast "PDF export failed"; Print stays available
```

Export reads only a `DailyLog[]`-derived DOM the presentation layer owns. It performs no
calculation, so an export bug can never be an HOS bug.

---

## 9. Clean Code rules applied

**Meaningful naming.** Names state the rule, not the mechanism: `drive_since_break`,
`miles_since_fuel`, `window_start`, `cap_window`, `_take_restart()`, `exceeds_max_trip_distance`,
`build_daily_logs`. The renames this architecture introduces all move in that direction:
`planning.py` → `plan_trip.py` / `PlanTripUseCase`; `providers/` → `infrastructure/` with
`PeliasGeocoder` and `OsrmCarRouter` naming the actual provider and profile instead of a generic
`geocoding` / `routing`. No `data`, `obj`, `manager`, `helper`, `process()` or `doStuff()`
survives anywhere in the target tree.

**Single responsibility.** The three splits in this document are all SRP:
`planning.py` (orchestration + defaults + wire format → three modules);
`geocoding.py` (five jobs → five classes);
`App.tsx` (shell + five workflows + icons → shell + `src/app/` hooks + `ui/icons`).
Conversely, `LogSheet.tsx` at 781 lines and `_Engine` at 348 are **left alone**: each has one
reason to change, and splitting them would scatter a single cohesive algorithm.

**Small functions.** The target keeps domain functions to one decision each —
`_floor_step`, `_ceil_step`, `_prorated_miles`, `_brackets`, `_totals`, `_segments_for_day`,
`is_same_place`. The engine's `_drive_leg` loop stays longer than the rest by design; its six
`cap_*` locals are named precisely so the `min()` reads as the rule it implements.

**SOLID, where it pays.**
- *SRP* — as above.
- *OCP* — a third geocoder or router becomes a new class plus a list entry in `container.py`
  (ADR-4), replacing three hand-rolled `try/except` ladders. Throttling as a declared DRF class
  rather than a remembered first line in each view means a new endpoint is limited by default.
- *LSP* — every `Geocoder` returns `Place` objects and raises only from the closed
  `{PlaceNotFound, ProviderRateLimited, ProviderUnavailable}` set, so `FallbackGeocoder` can
  substitute any of them without the use case knowing which ran.
- *ISP* — `Geocoder` is three methods used together; `Clock` is one. Neither forces a fake to
  implement anything the caller does not use. No god-interface.
- *DIP* — `PlanTripUseCase` names only `application.ports` protocols; `container.py` is the sole
  module that mentions `requests`, ORS URLs or `timezonefinder`.

**DRY, with one honest exception.** HOS constants exist once, in `HosConfig`. BR-PLN-07 defaults
exist once, in `domain/defaults.py` — which is exactly why `apiAdapter.ts`'s hardcoded
`'Alex Vance'` / `'Spotter Logistics Corp.'` must go. The deliberate duplicate is
`src/domain/form.ts` mirroring the server's §4.1 rules, required by `NFR-SEC-03` and documented
in the file's own header.

**Error handling.** A closed exception set per layer, no HTTP status below the presentation
layer, one §10 body shape, `message` shown to users and stack traces logged only. `LOGR-03`'s
sanitisation (coordinates to 2 dp, free text stripped) belongs to the logging adapter, never to
a caller.

**Validation, separated by kind.** Input shape → DRF serializers (`NFR-SEC-03`). Business rules
→ `HosConfig.__post_init__`, `domain/policies`, and the engine's own precondition checks
(`schedule()` rejects a non-tz-aware start, a non-15-minute start, a wrong leg count, an
out-of-range cycle). Invariants → `build_daily_logs` raising `LogInvalid` when a day does not
total 24.00 (`BR-LOG-01`). Security → throttle, CORS, host allowlist in settings. Four kinds,
four places.

**No overengineering.** No repository, no entity base class, no CQRS bus, no DI framework, no
mapper library. Four ports (§7), three decorators (ADR-4), one container. Each exists because a
named test or a named requirement needs it.

---

## 10. Testing strategy

The existing suite is the project's strongest asset — 2,039 test lines against ~2,400 production
lines, with a CI gate at ≥ 90 % on engine and log builder and ≥ 75 % overall (`NFR-MNT-01`).
The strategy below preserves it and closes the one real gap.

| Level | Target | Dependencies | Verifies |
| --- | --- | --- | --- |
| Domain unit | `engine`, `logbuilder`, `geometry`, `policies`, `defaults` | none | `AC-01` exact reference schedule; `AC-02` restart at cycle 65 and 70; `AC-04` single-sheet 150 mi trip; `AC-05` reference day remarks and brackets |
| Domain property | `engine` + `logbuilder` together, Hypothesis | none | `AC-03`: 500 trips, 50–3,000 mi, cycle 0–70 — no `BR-HOS-01..04` or `BR-PLN-01` breach, every day totals 24.00, segments contiguous, day miles sum to route miles ± 0.5 |
| Domain determinism | `schedule()` | none | `NFR-REL-01` byte-identical output |
| Domain benchmark | `schedule()` + `build_daily_logs()` | none | `NFR-PERF-02` ≤ 200 ms for a 3,000 mi trip |
| **Application** | `PlanTripUseCase` | **fake ports** | the `WF-1` pipeline, notice emission, `FR-RTE-05`, provider-failure mapping (`NFR-REL-02`) — **the current gap** |
| Infrastructure | each adapter, decorator, composite | mocked HTTP | `INT-05` timeout + single retry; `FR-GEO-04` cache TTL and key normalisation; `FR-RTE-02` fallback selection and reported provider |
| API | `views` via DRF test client | mocked HTTP | `API-01..06`, every §10 code and status, `AC-08` invalid inputs, `ERR-02`, `X-Request-ID` |
| Client domain | `form`, `vocab`, `liveStatus` | none | §4.1 messages, status vocabulary, live-phase transitions |
| Client application | `usePlanTrip`, `useLogPdfExport` | fake `PlannerApi` | `WF-4` stale-input flow, field-error mapping, cold-start notice |
| Client visual | `LogSheet` via `scripts/render-sheet.tsx` → SVG | none | `AC-06` geometry: stepped line ≤ 1 px error, flags non-overlapping, totals present |

**Why the application-level gap exists today and how ports close it.** `planning.py` calls
`geocoding.geocode()`, `routing.route_trip()` and `timezones.zone_for()` as module functions, so
the only way to test the pipeline is to patch modules — which couples the test to the import
graph and means `test_api.py` is currently carrying load that belongs one layer down. With
constructor injection, `test_plan_trip.py` instantiates the use case with a `FakeGeocoder`,
`StubRouter`, `FixedClock` and `FixedTimezoneResolver`, and asserts on `TripPlan` directly — no
HTTP layer, no JSON, no patching. Those fakes also make provider-failure paths (`NFR-REL-02`)
trivial to enumerate, where today each needs a mocked `requests` call.

**Outstanding per the README's own deviation list.** The `AC-06` Playwright screenshot pass is
still not implemented; the offline SVG renderer covers geometry but not a visual diff. That is a
known, documented gap, not an architectural one.

**Boundary enforcement as a test.** Add an import-linter contract (or a ruff
`flake8-tidy-imports` ban) to CI asserting the §6 table: `domain` imports stdlib only;
`application` never imports `infrastructure` or `presentation`; only `container.py` imports
concrete adapters. Without this, ADR-2 degrades the first time someone needs "just one" Django
import in the engine.

---

## 11. Security considerations

**What is already right.** Provider keys are read from the environment only and used
server-side; `/api/health/` reports key *presence* as a boolean, never a value (`FR-SYS-02`,
`AC-10`). `.gitignore` commits `.env.example` and excludes every `.env*`. Production settings
enable `SECURE_SSL_REDIRECT`, HSTS with preload, `nosniff` and `X_FRAME_OPTIONS=DENY` when
`DEBUG=False`, and CI runs `manage.py check --deploy`. CORS is an explicit allowlist with
`CORS_ALLOW_CREDENTIALS = False` (`API-06`). CSRF middleware is absent and `settings.py`
documents *why* — no cookies, no session, no ambient credential for a cross-site request to ride
on — which is the correct reasoning for a stateless unauthenticated API, and it will stop being
correct the moment ADR-8(b) introduces real auth. Rate limiting digests the client-controlled IP
string before using it as a cache key. Every input is re-validated server-side (`NFR-SEC-03`).

**Findings, in priority order.**

1. **Mock authentication shipped to the browser (ADR-8).** A hardcoded token in the public
   bundle, gating a workflow whose backend is `AllowAny`. It grants nothing and protects nothing,
   while implying a security property the system lacks. Remove it, or implement server-side
   enforcement and amend SRS §3. *Blocking.*

2. **`FR-UI-09` disclaimer replaced by a compliance claim.** The footer must read
   "Planning tool — projected logs, not an FMCSA-registered ELD". It currently reads
   "FMCSA 49 CFR Part 395 compliant schedule generator" (`App.tsx:355-357`). The SRS
   consistency review raised exactly this as finding #13 ("risk of the output being mistaken for
   a compliant ELD"), and the current copy asserts the opposite of the required text. This is a
   liability exposure, not a copy nit. *Blocking.*

3. **Client-controlled `X-Request-ID` adopted verbatim.** `middleware.py:18` passes the inbound
   header straight to `request_context.begin()`, which stores it unvalidated; it is then written
   into every structured log line and echoed in the response header. An attacker can inject
   newlines and forged JSON fragments into the log stream (log forging) or send a megabyte-long
   id. Fix: accept only `^[A-Za-z0-9._-]{1,64}$`, otherwise generate a fresh id.

4. **Rate-limit bypass via `X-Forwarded-For`.** `throttling.py:_client_ip` trusts the first
   entry of a client-supplied header, so `API-05`'s per-IP limit is defeated by rotating the
   header value unless the hosting proxy overwrites it. Fix: take the rightmost untrusted hop, or
   read a host-guaranteed header, and document the deployment assumption.

5. **`SECRET_KEY` falls back silently.** `settings.py:28` defaults to
   `"dev-only-insecure-key-change-me"`. If the production environment variable is ever missing,
   the service boots with a known key instead of failing. Fix: raise when `DEBUG=False` and no
   key is set. (`manage.py check --deploy` warns, but CI supplies a key, so the warning never
   fires on the real deployment path.)

6. **Security counters share a namespace with the data cache.** Rate-limit keys and geocode
   results both live in the `provider_cache` table under `MAX_ENTRIES=10_000, CULL_FREQUENCY=4`.
   A request flood can cull cached geocodes — a self-inflicted cost amplifier against `INT-01`
   quotas — and conversely cache churn can evict a live rate-limit window. Fix: a separate cache
   alias for counters.

7. **Trip inputs persisted to disk, against SRS §7.3.** `history.ts` writes the full
   `TripFormState` — including driver, carrier and shipper free text — to `localStorage`, while
   §7.3 states this data is retained "in browser memory until replan or page close" and "never
   written to disk". The feature is reasonable and the module documents its own reasoning; the
   *SRS* needs amending, or the stored shape needs reducing to the non-personal route summary.
   Either way, the deviation must be written down, not left implicit.

**Logging.** `LOGR-01..05` are structurally satisfied: one INFO line per API request with
request id, endpoint, status, duration and per-provider timings; provider errors and fallbacks
at WARNING; 500s at ERROR with a stack trace. Confirm `LOGR-03`'s sanitisation is actually
applied — coordinates rounded to 2 dp and free-text fields stripped before any request payload
reaches a log record — and that `LOGR-04` holds, i.e. no API key, full body or client IP ever
enters a log line.

---

## 12. Potential architectural risks

**Highest-severity first.** Items UI-01 and UI-02 are the ones that cost requirement coverage
today.

| # | Risk | Evidence | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| UI-01 | **`FR-UI-07` Assumptions panel is not rendered.** `TripSummaryPanel.tsx` exports `TripSummaryPanel` and `AssumptionsPanel`; nothing imports either. | zero references repo-wide | A named functional requirement ships unimplemented; the user never sees the `BR-PLN-02/03/06` assumptions the engine relied on. | Mount `AssumptionsPanel` from `plan.assumptions` (the backend already computes it in `_assumptions`) and either mount `TripSummaryPanel` or confirm `StopTimeline` covers all ten `FR-MAP-06` figures. |
| UI-02 | **`plan.notices[]` is never displayed.** The backend emits three notices — car-routing fallback (`FR-RTE-02`), "All locations are the same place" (`FR-INP-06`), time-zone fallback (`INT-04`) — and the client discards every one. | `notices` appears only in `types.ts:136` | Users read truck-profile times that were computed from a *car* profile, with no warning. `FR-RTE-02`'s specified UI behaviour is silently absent. | Add `NoticeList.tsx` and render it above the workspace whenever `plan.notices.length > 0`. |
| ARCH-01 | **Infrastructure → presentation import.** Provider adapters import DRF-coupled `ApiError` subclasses and therefore choose HTTP status codes. | `providers/geocoding.py:24`, `providers/routing.py:17` | The domain/app core cannot be reused or tested without DRF installed; status-code decisions are scattered across adapters. | §6 exception table; adapters raise HTTP-agnostic errors. |
| ARCH-02 | **`planning.py` holds three responsibilities** (orchestration, `BR-PLN-07` defaults, `API-04` wire format) in 306 lines, and mutates `DailyLog.header` after the builder validated it. | `planning.py:_header`, `_bol`, `_*_dict`, `_fill_day_endpoints` | Every wire-format tweak risks the pipeline; the defaults rules cannot be unit-tested without running the whole use case. | ADR-5, ADR-6. |
| ARCH-03 | **`App.tsx` God component** — 557 lines, 11 state hooks, five workflows, eight icons. | `src/App.tsx` | Any change touches unrelated features; `NFR-PERF-05` is hard to hold because re-render scope is the whole app. | ADR-7. |
| ARCH-04 | **Dead `apiAdapter` abstraction** computing a contract the caller discards, and duplicating `BR-PLN-07` defaults with different values. | `apiAdapter.ts`, `App.tsx:69` | Wasted work per plan; a business rule with two sources of truth that disagree. | Delete; call `apiClient.planTrip` directly. |
| SCL-01 | **Nominatim throttle is per-process.** `_nominatim_last_call` is a module global, so N workers produce N req/s against `INT-01`'s 1 req/s policy. | `providers/geocoding.py:36-38` | Provider-side blocking of the shared User-Agent; breaches `NFR-SCL-01`'s stateless premise. | Move the throttle to the shared cache, or pin a single worker and document it. |
| OCP-01 | **Throttling is remembered, not declared.** `enforce_rate_limit()` is the first line of two views and absent from the third. | `views.py:20, 29, 38` | A new endpoint ships unthrottled by omission. | Declare a DRF throttle class; make "limited" the default. |
| PRV-01 | **Free-tier provider limits are outside our control** (`CON-05`), and the SRS's own open items flag unconfirmed ORS quotas and HGV maximum distance. | SRS §Open items | `NFR-PERF-01` and `FR-RTE-05` may need different numbers in production. | Both already live in one constant each (`HosConfig`, `domain/policies`) — a quota change is a one-line redeploy. |
| EXP-01 | **PDF export depends on DOM scraping and tab state**, so it breaks silently if a CSS class is renamed or a tab is not open. | `App.tsx:117-143` | `FR-EXP-01` fails in a way no unit test catches. | Sheet-ref registry (ADR-7). |
| DOM-01 | **A calendar day may legitimately show > 11 driving hours**, which looks like a bug to a reviewer. | README deviation list | Perceived `BR-HOS-01` violation during grading. | Correct as documented — `BR-HOS-01` caps driving per *duty period*, not per calendar day. Surface the explanation in the Assumptions panel once UI-01 is fixed. |
| TZ-01 | `timezonefinder` is imported lazily behind a module global with an `atexit` workaround for a library destructor bug. | `providers/timezones.py` | Fragile across library upgrades; couples the app to a specific version. | Already behind the `TimezoneResolver` port in the target design, so the workaround is replaceable in one class. Pin the version in `requirements.txt`. |

---

## 13. Final architecture review

I reviewed the target against the brief's own checklist and against the repository as it stands.

**Dependencies point inward?** In the target, yes, enforced by the §6 table and a CI import
contract. **Today, no** — one violation, ARCH-01: two infrastructure adapters import
presentation-layer errors. It is a three-file fix and it is the single most important structural
change in this document.

**Is the domain independent?** Yes, and verifiably so: `engine.py`, `logbuilder.py`,
`geometry.py`, `config.py` and `types.py` import nothing but the standard library. This is the
property that makes `AC-01`–`AC-05` and the 500-case property suite possible, and ADR-2 plus the
import contract exist to stop it eroding.

**Is business logic separated from infrastructure?** Mostly. Three rules are misplaced
(`FR-RTE-05` and `FR-INP-06` in the routing adapter, `BR-PLN-07` defaults in the orchestrator)
and one log rule (`FR-LOG-09` From/To) runs as post-hoc mutation from the layer above. ADR-5 and
ADR-6 move all four. No HOS constant appears as a literal outside `HosConfig`, which is the
harder half of this question and it is already right.

**Are responsibilities clearly separated?** After the three splits — `planning.py`,
`geocoding.py`, `App.tsx` — yes. I deliberately did **not** split `LogSheet.tsx` (781 lines) or
`_Engine` (348 lines): both are single cohesive algorithms with one reason to change, and
breaking them up to satisfy a line count would scatter logic that currently reads top-to-bottom.
Line count is not the metric; reasons to change is.

**Are names meaningful? Functions focused? Classes cohesive?** Yes throughout, and the proposed
renames (`PlanTripUseCase`, `PeliasGeocoder`, `OsrmCarRouter`) tighten the weakest ones. The
engine's `cap_drive` / `cap_window` / `cap_break` / `cap_cycle` / `cap_fuel` / `cap_leg` locals
are a good example of naming carrying the rule: the `min()` over them *is* `FR-HOS-02`.

**Unnecessary duplication?** One dead duplicate to delete (`apiAdapter`'s parallel contract plus
its conflicting `BR-PLN-07` defaults) and one deliberate, documented duplicate to keep
(`src/domain/form.ts` mirroring server validation, required by `NFR-SEC-03`).

**Unnecessary abstraction?** I rejected repositories, entity base classes, a DI framework, a
mapper library, `ILogger` and `ICacheService`. Four ports survive, each because a named test or
requirement needs it (§2, ADR-3). `apiAdapter.ts` is the existing example of abstraction that
pays nothing, which is why §4 removes it rather than tidying it.

**Can infrastructure be replaced?** After ADR-3/ADR-4, swapping ORS for Mapbox, Nominatim for
Photon, or the DB cache for Redis is a new class plus one line in `container.py`, with no change
in `application/` or `domain/`. Today it means editing nested `try/except` ladders in three
functions.

**Can business logic be tested independently? Can externals be mocked?** The domain already is —
2,039 test lines, ≥ 90 % CI gate on engine and log builder. The real gap is the **application**
layer: `PlanTripUseCase` cannot be tested without patching modules. Ports close it, and that is
the main testability argument for ADR-3.

**Does the implementation satisfy every relevant SRS requirement?** No — and this is the
finding I would raise first in a review, ahead of any structural concern. Two functional
requirements regressed during the UI redesign: `FR-UI-07` (Assumptions panel, built but never
mounted) and the `notices[]` display that `FR-RTE-02`, `FR-INP-06` and `INT-04` depend on. Two
further items contradict the SRS outright: the `FR-UI-09` footer now claims FMCSA compliance
instead of disclaiming it, and `src/lib/auth.ts` adds an authentication gate to a system SRS §3
defines as having none. The structure is in good shape; the requirement drift is where the risk
actually sits.

### Recommended sequence

1. **Requirement regressions and safety** — restore the `FR-UI-09` disclaimer; mount
   `AssumptionsPanel`; add `NoticeList`; remove the mock auth gate; validate `X-Request-ID`.
   *Small, high-value, no structural churn.*
2. **Backend boundary** — HTTP-agnostic exceptions + the single mapping table (ARCH-01); split
   `planning.py` into use case / defaults / presenters (ARCH-02); move the three misplaced rules
   into `domain/` (ADR-5).
3. **Ports and the container** — introduce the four protocols, inject them, add
   `tests/application/test_plan_trip.py` with fakes. *Unlocks the missing test level.*
4. **Provider composition** — split `geocoding.py` per ADR-4; fix the per-process Nominatim
   throttle; declare throttling instead of calling it.
5. **Frontend layering** — extract `src/app/` hooks and `ui/icons` from `App.tsx`; replace the
   PDF DOM scrape with a sheet registry; delete `apiAdapter.ts`.
6. **Guardrails** — import-contract check in CI, plus the outstanding `AC-06` Playwright pass.

Steps 1 and 2 are each independently shippable. Nothing in this sequence touches `engine.py` or
`logbuilder.py`, which is the point: the core that carries `OBJ-1` stays untouched while
everything around it gets its boundaries back.
