# ELD Trip Planner — Software Requirements Specification

Oct 6, 2026 · @Osama Riyad

Version 1.0. Implementation-ready requirements for the HOS trip planner and ELD log generator built for the Full Stack Developer assessment; companion to SPEC.md.

## 1. Introduction

### 1.1 Purpose

This SRS defines the testable requirements for the ELD Trip Planner, a web app that converts a truck trip into a legal Hours of Service (HOS) schedule, a route map, and drawn daily log sheets. It is the contract between the developer, the coding agent, and the assessment graders.

### 1.2 Scope

**In scope:** trip input; geocoding; truck routing with turn-by-turn directions; HOS schedule generation for a property-carrying driver on the 70-hour/8-day cycle; map of route and stops; one drawn log sheet per calendar day; PDF export and print; public hosting.

**Out of scope:** user accounts, persistent storage of trips, real ELD device functions (engine data capture, FMCSA device registration, data transfer to inspectors), passenger-carrying rules, the 60-hour/7-day cycle, split sleeper-berth periods, adverse-conditions and short-haul exceptions, non-US trips.

The app produces a **projected** log for planning. It is not an FMCSA-registered ELD and must say so in the UI (FR-UI-09).

### 1.3 Definitions

| Term | Meaning |
| --- | --- |
| HOS | Hours of Service, FMCSA rules in 49 CFR Part 395 limiting driving and on-duty time |
| ELD | Electronic Logging Device; here, the drawn record of duty status |
| RODS / log sheet | Record of Duty Status: one 24-hour grid page per calendar day |
| Duty status | One of Off Duty (OFF), Sleeper Berth (SB), Driving (D), On Duty not driving (ON) |
| Cycle used | On-duty plus driving hours already used in the current 8-day period, entered by the user |
| Duty period | Time from coming on duty after a qualifying rest to the next qualifying rest |
| 10-hour rest | 10 consecutive hours OFF or SB |
| 34-hour restart | 34 consecutive hours OFF or SB; resets cycle used to 0 |
| Leg | Routed segment: current → pickup, or pickup → dropoff |
| Stop | Any non-driving event shown on the map: pickup, dropoff, fuel, break, rest, restart |
| Remark | Location and activity text written at each change of duty status |
| Bracket | Cup-shaped mark under the grid spanning a period the truck was stationary |
| HGV | Heavy goods vehicle routing profile (truck-specific roads and speeds) |
| Log time zone | Time zone used on all log sheets; the time zone of the current location |

### 1.4 Intended audience

- Developer (Osama) and the AI coding agent implementing it
- Assessment graders evaluating accuracy and UX
- Future maintainers reading the repository

## 2. Product overview

### 2.1 Product vision

Enter a trip and your cycle hours, and get a legal schedule: every stop on a map and every log sheet already drawn.

### 2.2 Objectives

| ID | Objective | Measure |
| --- | --- | --- |
| OBJ-1 | Correct HOS schedules | 0 rule violations across the invariant test suite (AC-03) |
| OBJ-2 | Logs that match the FMCSA paper form | Reference fixtures render with all required fields (AC-06) |
| OBJ-3 | Fast evaluation by graders | A first-time user plans the sample trip in ≤ 3 clicks and ≤ 15 s on a warm server |
| OBJ-4 | Delivered within budget | Live URL, repo and Loom submitted within 4 days and 16 working hours |

### 2.3 Users and stakeholders

| Stakeholder | Interest |
| --- | --- |
| Graders (hiring company) | Accuracy, UI/UX quality, code quality, Loom clarity |
| Developer | Passing the assessment; a portfolio piece |
| Planner user (driver, dispatcher, student) | A realistic trip schedule and readable logs |
| Third-party providers (OpenRouteService, OSM, CARTO) | Fair use within free-tier limits and attribution |

## 3. User roles and permissions

The system has no authentication. All public endpoints are equal for every visitor.

| Role | Description | Permissions |
| --- | --- | --- |
| Visitor | Anyone opening the hosted URL | Plan trips, view map, directions and logs, export PDF, print |
| Operator | Developer with hosting-console access | Set environment variables and HOS configuration constants, view server logs, redeploy |

No visitor can change HOS configuration, see API keys, or see another visitor's trips (trips are never stored).

## 4. Functional requirements

Each requirement uses "shall" and has one ID. Modules: INP (trip input), GEO (geocoding), RTE (routing), HOS (scheduling engine), LOG (daily log builder), MAP (map and stops), UI (log sheet and app shell), EXP (export), SYS (system).

### 4.1 INP — Trip input

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-INP-01 | The form shall accept Current location, Pickup location and Dropoff location as text with autocomplete (FR-GEO-01). | Each required; 2–200 characters; a suggestion must be selected or the text must geocode server-side. | Valid: field shows the resolved label. Invalid: inline message under the field, e.g. "Pick a location from the list". |
| FR-INP-02 | The form shall accept Current Cycle Used in hours. | Required; numeric; 0 ≤ x ≤ 70; step 0.25; non-quarter values rounded to nearest 0.25 on submit. | Valid: hint shows "{70 − x} hrs available". Out of range: inline "Enter 0–70 hours"; submit disabled. |
| FR-INP-03 | The form shall offer an optional, collapsed "Log details" group: start date/time, driver name, carrier name, main office, vehicle numbers, shipper, commodity. | Start time: valid ISO date-time, not earlier than 7 days before today and not later than 365 days after; text fields ≤ 80 characters. | Blank fields use defaults in BR-PLN-07. Invalid start time: inline message; submit disabled. |
| FR-INP-04 | The form shall provide a "Try a sample trip" button that fills Dallas, TX → Oklahoma City, OK → Chicago, IL with 22.5 hrs cycle used. | — | Fields populate; user still presses Plan. |
| FR-INP-05 | Submitting shall be blocked while any required field is invalid or a request is in flight. | — | Plan button shows a spinner and is disabled during the request. |
| FR-INP-06 | If all three locations resolve to points within 0.5 mi of each other, the system shall still plan the trip. | — | Result contains pre-trip, pickup and dropoff with 0 driving miles; a notice says "All locations are the same place". |

### 4.2 GEO — Geocoding

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-GEO-01 | The system shall return up to 5 US location suggestions for a query of ≥ 3 characters, debounced 300 ms in the client. | Query 3–200 chars; results restricted to the United States. | Success: list of {label, lat, lng}. No match: "No US matches". Provider failure: "Search unavailable, try again". |
| FR-GEO-02 | The system shall geocode a submitted label server-side when no coordinates are supplied. | Must resolve to one US point. | Failure: HTTP 400 with field error `not_found`. |
| FR-GEO-03 | The system shall reverse-geocode each stop and each duty-status change location to "City, ST". | Coordinates within the US. | Failure: fall back to "near {nearest route instruction road}, lat,lng" rounded to 2 decimals; never block the plan. |
| FR-GEO-04 | The system shall cache geocode and reverse-geocode results for ≥ 24 hours keyed by normalized query or by lat/lng rounded to 3 decimals. | — | Repeat lookups make no provider call. |

### 4.3 RTE — Routing

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-RTE-01 | The system shall compute two legs (current → pickup, pickup → dropoff) using a truck (HGV) routing profile. | Each leg routable by road. | Success: distance (mi), duration (hr), geometry, instructions per leg. Unroutable: HTTP 422 `route_not_found` naming the leg. |
| FR-RTE-02 | If HGV routing fails for distance limits or provider error, the system shall retry once with the fallback car-profile provider. | — | Response `routing_provider` reports which was used; UI shows "Car routing used; truck times may differ". |
| FR-RTE-03 | The system shall return turn-by-turn instructions per leg with text, distance (mi) and duration (min). | — | Shown in the Directions panel (FR-MAP-05). |
| FR-RTE-04 | The system shall simplify the combined route geometry to ≤ 2,000 points for the response. | Simplified line within 50 m of the original. | — |
| FR-RTE-05 | The system shall reject trips whose total route distance exceeds 5,000 miles. | — | HTTP 422 `trip_too_long`. |

### 4.4 HOS — Scheduling engine

The engine is a pure function: (legs, cycle used, start time, config) → ordered duty events. It makes no network or database calls. Rules it applies are defined in section 6.

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-HOS-01 | The engine shall schedule the sequence: pre-trip → drive leg 1 → pickup → drive leg 2 → dropoff → off duty to end of day. | Legs have distance ≥ 0 and duration ≥ 0. | Output: contiguous events with no gaps or overlaps. |
| FR-HOS-02 | The engine shall split driving into chunks so no chunk violates BR-HOS-01 to BR-HOS-04 or BR-PLN-01. | — | Each chunk ends at the first limit reached or the end of the leg. |
| FR-HOS-03 | When a limit is reached, the engine shall insert the required stop by the precedence in BR-PLN-04. | — | Event kind is one of: break, fuel, rest\_10, restart\_34. |
| FR-HOS-04 | The engine shall insert a 34-hour restart before any on-duty or driving event that would push cycle used above 70. | — | Includes the case cycle used = 70 at start: the restart is the first event. |
| FR-HOS-05 | The engine shall assign each event a location (lat, lng) by interpolating along the leg geometry at the event's cumulative mileage. | — | Interpolated point lies on the route polyline. |
| FR-HOS-06 | The engine shall compute all times in integer minutes and snap durations to 15-minute steps per BR-PLN-05. | — | Every event start and end falls on :00, :15, :30 or :45. |
| FR-HOS-07 | The engine shall read limits and durations from a configuration object (BR-CFG). | Values positive. | Tests can override values such as pre-trip = 0. |
| FR-HOS-08 | The engine shall raise a typed error if it cannot finish within 30 simulated days. | — | API returns HTTP 500 `schedule_failed`; logged with inputs. |

### 4.5 LOG — Daily log builder

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-LOG-01 | The builder shall produce one log per calendar day in the log time zone, from trip start date to trip end date inclusive. | — | A trip ending at 23:59 or earlier on day N produces N sheets. |
| FR-LOG-02 | The builder shall split any event crossing midnight at 00:00. | — | Both parts keep the event kind. |
| FR-LOG-03 | The builder shall pad each day with OFF from 00:00 to the first event and from the last event to 24:00. | — | Segments cover 0–1,440 minutes exactly. |
| FR-LOG-04 | The builder shall total hours per duty status per day. | Totals sum to exactly 24.00. | Assertion failure → HTTP 500 `log_invalid`, logged. |
| FR-LOG-05 | The builder shall compute miles driven per day. | Sum over days equals route miles ± 0.5 mi. | — |
| FR-LOG-06 | The builder shall create one remark per change of duty status with minute, "City, ST" and an activity label from BR-LOG-02. | — | Remarks at the same minute merge into one. |
| FR-LOG-07 | The builder shall create one bracket per stationary period (each maximal run of non-driving time). | — | Bracket {start\_min, end\_min} lies inside the day. |
| FR-LOG-08 | The builder shall compute the 70-hour recap per BR-LOG-03. | — | Values to 0.25 h. |
| FR-LOG-09 | The builder shall fill header fields: date, from, to, miles today, vehicle numbers, carrier, main office, home terminal, driver, co-driver "N/A", shipping document, shipper, commodity. | — | Missing optional inputs use BR-PLN-07 defaults. |

### 4.6 MAP — Map, stops and directions

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-MAP-01 | The map shall draw the full route polyline and fit its bounds with 40 px padding. | — | Before planning, show the contiguous US with an empty-state overlay. |
| FR-MAP-02 | The map shall show one marker per stop with a distinct icon and color per kind: start, pickup, dropoff, fuel, 30-min break, 10-hr rest, 34-hr restart. | Icons differ in shape, not only color. | A legend lists all kinds present. |
| FR-MAP-03 | Clicking a marker shall open a popup with kind, location, start and end time, duration and miles from start. | — | — |
| FR-MAP-04 | The stop timeline shall list every stop in order; selecting a row shall pan the map to its marker and open its popup. | — | Hovering a marker highlights its row. |
| FR-MAP-05 | The Directions panel shall list instructions per leg, collapsible by leg. | — | — |
| FR-MAP-06 | The summary shall show total miles, driving hours, on-duty hours, trip start, trip end, elapsed hours, number of days, fuel stops, rests and restarts. | — | — |

### 4.7 UI — Log sheet and app shell

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-UI-01 | Each daily log shall render as an SVG reproducing the FMCSA form: header, 4-row 24-hour grid, totals column, remarks area, recap. | — | Matches reference fixtures (AC-06). |
| FR-UI-02 | The grid shall show hour labels Midnight, 1–11, Noon, 1–11, Midnight and tick marks at :15 (short), :30 (medium), :45 (short) and each hour (tall). | — | — |
| FR-UI-03 | The duty status shall be one continuous stepped line: horizontal in the status row, vertical at each change. | x position = minute / 1,440 × grid width, error ≤ 1 px at 1,000 px width. | — |
| FR-UI-04 | The totals column shall show each row's hours and "= 24". The circled value shall show driving + on-duty hours. | — | — |
| FR-UI-05 | Remarks shall render as 45° flags: "City, ST" on line one, activity on line two. Stationary brackets render under the grid. | Flags < 45 min apart are staggered so no two labels overlap. | — |
| FR-UI-06 | The log view shall provide Day tabs and previous/next controls. | — | Day count matches FR-LOG-01. |
| FR-UI-07 | The app shall show an Assumptions panel listing BR-PLN-02, BR-PLN-03, BR-PLN-06 and the configured pre-trip duration. | — | — |
| FR-UI-08 | During planning, the app shall show skeleton placeholders. After 5 s it shall add "Waking up the server, this can take up to a minute". | — | — |
| FR-UI-09 | The footer shall state "Planning tool — projected logs, not an FMCSA-registered ELD" and provider attributions. | — | — |

### 4.8 EXP — Export

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-EXP-01 | "Download PDF" shall produce one vector PDF with one US-Letter landscape page per day. | Text is selectable. | Failure: toast "PDF export failed"; Print remains available. |
| FR-EXP-02 | "Print" shall print only the log sheets, one per page, hiding app chrome. | — | — |

### 4.9 SYS — System

| ID | Requirement | Validation | Success / failure |
| --- | --- | --- | --- |
| FR-SYS-01 | `GET /api/health/` shall return 200 with build version and provider-key presence (boolean only). | — | — |
| FR-SYS-02 | The backend shall make all third-party API calls; the browser shall never receive provider API keys. | — | Verified by inspecting the built frontend bundle (AC-10). |

## 5. Detailed user workflows

### WF-1 Plan a trip (main flow)

1. Visitor opens the app; the map shows the US empty state.
2. Visitor types in Current location; suggestions appear after 3 characters (FR-GEO-01); visitor selects one.
3. Visitor repeats for Pickup and Dropoff, then enters Cycle Used (FR-INP-02).
4. Optionally, visitor expands Log details and fills fields (FR-INP-03).
5. Visitor presses **Plan trip**; the button disables and skeletons appear (FR-INP-05, FR-UI-08).
6. Backend geocodes any unresolved labels, routes both legs, runs the engine, builds logs, reverse-geocodes stops, returns the plan (section 8).
7. App shows summary, route, markers and timeline; the Route tab is active.
8. Visitor opens **Daily Logs**, moves between days, and downloads the PDF.

**Alternate paths**

- 2a. No suggestion matches: inline "No US matches"; visitor edits text.
- 6a. Validation error (400): field messages shown; form stays filled.
- 6b. Route not found (422): toast names the failing leg.
- 6c. HGV routing fails: fallback used; notice per FR-RTE-02.
- 6d. Provider rate-limited or down: error per section 10; visitor can retry.

### WF-2 Sample trip

1. Visitor presses **Try a sample trip** (FR-INP-04).
2. Fields fill; visitor presses Plan; WF-1 continues at step 5.

### WF-3 Inspect a stop

1. Visitor selects a timeline row or a marker.
2. Map pans to the marker and opens its popup; the row highlights (FR-MAP-03, FR-MAP-04).

### WF-4 Replan

1. Visitor edits any input after a result is shown.
2. Result remains visible but dimmed with "Inputs changed — press Plan to update".
3. Visitor presses Plan; the new result replaces the old one entirely.

## 6. Business rules

Source: FMCSA *Interstate Truck Driver's Guide to Hours of Service* (2022) and the assessment brief. Values in **bold** are configuration constants (BR-CFG).

### 6.1 HOS rules

| ID | Rule |
| --- | --- |
| BR-HOS-01 | Driving within one duty period shall not exceed **11 h**. |
| BR-HOS-02 | No driving after **14 h** of elapsed time since the duty period began. The window runs through breaks, fuel and on-duty work. On-duty not-driving work after hour 14 is permitted. |
| BR-HOS-03 | After **8 h** of cumulative driving, the driver shall have a non-driving interruption of ≥ **30 min** (OFF, SB or ON) before driving again. Any such interruption resets the 8-hour counter. |
| BR-HOS-04 | Driving shall not occur once cycle used (ON + D) reaches **70 h**. |
| BR-HOS-05 | **10 h** consecutive OFF or SB resets the 11-hour, 14-hour and 8-hour counters. It does not reset cycle used. |
| BR-HOS-06 | **34 h** consecutive OFF or SB resets cycle used to 0 and every other counter. |

### 6.2 Planning rules

| ID | Rule |
| --- | --- |
| BR-PLN-01 | Miles since last fuel shall never exceed **1,000**. Fuel is **30 min** ON. The fuel stop is placed at the last 15-minute driving boundary at or before 1,000 miles. |
| BR-PLN-02 | Pickup and dropoff are each **60 min** ON. Pre-trip inspection is **30 min** ON at trip start and after every 10-hour rest or 34-hour restart. Post-trip inspection is **0 min** by default. |
| BR-PLN-03 | The driver starts fresh (≥ 10 h off before start). Cycle used stays fixed during the trip except for 34-hour restarts; no hours roll off. |
| BR-PLN-04 | When several limits are due at once, precedence is: 34-hour restart, then 10-hour rest, then 30-minute break, then fuel. If a break and a fuel stop fall due within the same 15 minutes, only the fuel stop is scheduled, since it satisfies BR-HOS-03. |
| BR-PLN-05 | All events are whole multiples of 15 minutes. The final driving chunk of a leg is rounded up to the next 15 minutes; fuel-limited chunks round down (BR-PLN-01). Cycle used input rounds to the nearest 0.25 h. |
| BR-PLN-06 | Log time zone = time zone of the current location. 10-hour rests are logged SB; 30-minute breaks, 34-hour restarts and time outside the trip are logged OFF. |
| BR-PLN-07 | Defaults when blank: start time = next full hour in the log time zone; driver = "Driver"; carrier = "Carrier"; main office and home terminal = current location city; vehicle = "TRK-001 / TRL-001"; shipper = "Shipper at pickup"; commodity = "General freight"; shipping document = "BOL-" + 6-character hash of the inputs. |
| BR-PLN-08 | Average speed per leg = leg distance ÷ provider duration. Driving miles per chunk = chunk hours × that speed. |

### 6.3 Log rules

| ID | Rule |
| --- | --- |
| BR-LOG-01 | Each day's four status totals sum to exactly 24.00 h. |
| BR-LOG-02 | Activity labels: Pre-trip inspection / TIV; Pickup — loading; Fuel; 30-min break; 10-hr rest; 34-hr restart; Dropoff — unloading; Off duty. A remark at the start of driving reads "Depart". |
| BR-LOG-03 | Recap per day: on-duty today = D + ON hours that day; A = cycle used at start + cumulative ON and D since start, through the end of that day (after a restart, cumulative since the restart ended); B = 70 − A; restart flag = a 34-hour restart ended that day. 60-hour/7-day columns render greyed "N/A". |

### 6.4 Configuration (BR-CFG)

All bolded values above are constants in one backend module. Changing them requires a redeploy by the Operator; no visitor can change them.

## 7. Data requirements

The system stores no trip data. All entities below exist only for one request (backend) or one page session (browser). The only persisted data is the provider-response cache.

### 7.1 Entities and important fields

| Entity | Important fields | Notes |
| --- | --- | --- |
| TripRequest | current, pickup, dropoff (Location); cycle\_used\_hr (decimal, 0–70, step 0.25); start\_time (ISO, optional); driver, carrier, main\_office, vehicle, shipper, commodity (text ≤ 80, optional) | Validated input |
| Location | label (text); lat, lng (decimal, 6 dp); city, state (text) | US only |
| RouteLeg | from\_label, to\_label; distance\_mi; duration\_hr; geometry (lat/lng list); instructions (list) | Exactly 2 per plan |
| Instruction | text; distance\_mi; duration\_min | Belongs to one leg |
| DutyEvent | status (off\_duty, sleeper\_berth, driving, on\_duty); kind (pre\_trip, drive, pickup, dropoff, fuel, break, rest\_10, restart\_34, off); start, end (ISO, tz-aware); miles\_start, miles\_end; lat, lng; location (City, ST); note | Engine output, ordered, contiguous |
| Stop | DutyEvent fields for non-drive kinds + duration\_hr, miles\_from\_start | Derived view for map and timeline |
| DailyLog | date; day\_index; miles\_today; header (object); segments; totals; remarks; brackets; recap | One per calendar day |
| LogSegment | status; start\_min, end\_min (0–1,440) | Covers the day exactly |
| Remark | minute; location; note | One per status change |
| Bracket | start\_min; end\_min | One per stationary period |
| Recap | on\_duty\_today; total\_last\_8\_days (A); available\_tomorrow (B); restart\_taken | Hours to 0.25 |
| TripSummary | total\_miles; driving\_hours; on\_duty\_hours; trip\_start; trip\_end; total\_elapsed\_hours; num\_days; num\_fuel\_stops; num\_rests; num\_restarts; timezone; routing\_provider | — |
| CacheEntry | key (normalized query or rounded lat/lng); value (JSON); created\_at | Persisted; TTL ≥ 24 h |

### 7.2 Relationships

- A TripRequest produces one TripPlan made of: 1 TripSummary, 2 RouteLegs, ≥ 4 DutyEvents, 0..n Stops, ≥ 1 DailyLog.
- Each RouteLeg has 0..n Instructions.
- Each DailyLog has ≥ 1 LogSegment, 0..n Remarks, 0..n Brackets and 1 Recap.
- Each Stop corresponds to exactly one non-drive DutyEvent.

### 7.3 Ownership and lifecycle

| Data | Owner | Created | Retained | Deleted |
| --- | --- | --- | --- | --- |
| TripRequest and TripPlan | Visitor | On Plan | In browser memory until replan or page close | On page close; never written to disk or server logs (except error logs, section 11) |
| CacheEntry | System | On first provider lookup | 24 h minimum, 7 days maximum | Expired by TTL or on redeploy |
| Map tiles, geocoding data | Providers (OSM, CARTO, OpenRouteService) | — | Per provider terms | — |

## 8. API and integration requirements

### 8.1 Internal REST API

All endpoints use JSON over HTTPS, prefix `/api/`, and return errors in the format of section 10.

| ID | Endpoint | Request | Response |
| --- | --- | --- | --- |
| API-01 | `POST /api/trips/plan/` | TripRequest. Each location is `{label}` or `{label, lat, lng}`. | 200: `{summary, route:{geometry, legs[]}, stops[], events[], daily_logs[], notices[]}` matching section 7 field names. |
| API-02 | `GET /api/geocode/?q=` | q: 3–200 chars | 200: `[{label, lat, lng}]`, at most 5 |
| API-03 | `GET /api/health/` | — | 200: `{status:"ok", version, providers:{ors:true}}` |

- API-04: All timestamps shall be ISO 8601 with offset in the log time zone; distances in miles to 1 decimal; hours to 2 decimals.
- API-05: API-01 and API-02 shall be rate-limited to 30 requests per minute per client IP; excess returns 429 `rate_limited`.
- API-06: CORS shall allow only the production frontend origin and `http://localhost:5173`.

### 8.2 External integrations

| ID | Provider | Use | Fallback |
| --- | --- | --- | --- |
| INT-01 | OpenRouteService geocode (search, autocomplete, reverse) | FR-GEO-01..03 | Nominatim, max 1 req/s, with an identifying User-Agent |
| INT-02 | OpenRouteService directions, `driving-hgv` profile | FR-RTE-01, FR-RTE-03 | OSRM public server, car profile (FR-RTE-02) |
| INT-03 | CARTO or OSM raster tiles via Leaflet | FR-MAP-01 | OSM standard tiles |
| INT-04 | `timezonefinder` (local library) | BR-PLN-06 | Default `America/Chicago` with a notice |

- INT-05: Every outbound call shall have a 10 s timeout and at most 1 retry on timeout or 5xx.
- INT-06: Provider API keys shall be read from environment variables only.
- INT-07: The UI shall display attribution for OpenStreetMap, CARTO (if used) and OpenRouteService.

## 9. Non-functional requirements

Targets assume a warm server unless stated. Provider latency outside our control is measured separately.

| ID | Category | Requirement | Verification |
| --- | --- | --- | --- |
| NFR-PERF-01 | Performance | API-01 p95 ≤ 8 s for trips ≤ 3,000 mi, including provider calls. | 20 timed runs of 3 reference trips on production |
| NFR-PERF-02 | Performance | Engine + log builder ≤ 200 ms for a 3,000 mi trip. | pytest benchmark |
| NFR-PERF-03 | Performance | API-02 p95 ≤ 1.5 s; cached ≤ 100 ms. | Timed runs |
| NFR-PERF-04 | Performance | Frontend initial JS ≤ 350 KB gzipped; Lighthouse Performance ≥ 80 (desktop). | Build output, Lighthouse |
| NFR-PERF-05 | Performance | Log tab switch renders in ≤ 100 ms for a 7-day trip. | Browser profiler |
| NFR-SEC-01 | Security | All traffic over HTTPS; HTTP redirects to HTTPS. | curl check |
| NFR-SEC-02 | Security | No secrets in the repository or frontend bundle. | `git grep` and bundle search for key prefix |
| NFR-SEC-03 | Security | All inputs validated server-side per section 4, regardless of client validation. | API tests with invalid payloads |
| NFR-SEC-04 | Security | Django `DEBUG=False`, strong `SECRET_KEY`, `ALLOWED_HOSTS` set in production. | Settings check |
| NFR-SEC-05 | Security | Rate limits per API-05; CORS per API-06. | API tests |
| NFR-AVL-01 | Availability | Frontend available ≥ 99% during the 14-day grading window (static host). Backend best effort on free tier; cold start ≤ 60 s. | Uptime monitor pinging `/api/health/` every 10 min |
| NFR-SCL-01 | Scalability | Backend is stateless so it scales horizontally without code change. Supports 5 concurrent plan requests on one free instance without errors. | Load test with 5 parallel requests |
| NFR-REL-01 | Reliability | Same inputs and start time produce byte-identical engine output. | Determinism test |
| NFR-REL-02 | Reliability | Provider failure never returns an unhandled 500; it maps to a section 10 error. | Mocked failure tests |
| NFR-MNT-01 | Maintainability | Engine and log builder line coverage ≥ 90%; overall backend ≥ 75%. | pytest-cov in CI |
| NFR-MNT-02 | Maintainability | Lint and type checks pass: ruff (backend), ESLint + `tsc --noEmit` (frontend). | CI |
| NFR-MNT-03 | Maintainability | README documents setup in ≤ 5 commands, architecture, assumptions and tests. | Fresh-clone run |
| NFR-ACC-01 | Accessibility | WCAG 2.1 AA: text contrast ≥ 4.5:1, every input has a visible label, all controls keyboard-operable with visible focus. | axe DevTools: 0 serious/critical issues; manual keyboard pass |
| NFR-ACC-02 | Accessibility | Each log SVG has a text alternative listing the day's segments and totals. | Screen-reader check |
| NFR-ACC-03 | Accessibility | Layout works from 360 px to 1,920 px width with no horizontal page scroll; the log sheet scrolls inside its card below 768 px. | Responsive test at 360, 768, 1,280, 1,920 px |
| NFR-OBS-01 | Observability | Structured JSON logs per request: request ID, endpoint, status, duration, provider call count and durations. | Inspect host logs |
| NFR-OBS-02 | Observability | Every response carries an `X-Request-ID` header, also shown in UI error toasts. | API test |

## 10. Error handling requirements

All API errors shall use one body format: `{"error":{"code":"...","message":"...","fields":{...},"request_id":"..."}}`. The UI shall show `message` and never a stack trace.

| Code | HTTP | Trigger | UI behavior |
| --- | --- | --- | --- |
| `validation_error` | 400 | Field rules in section 4 fail | Inline field messages from `fields` |
| `not_found` | 400 | A location cannot be geocoded | Inline under that field |
| `route_not_found` | 422 | A leg has no road route | Toast naming the leg |
| `trip_too_long` | 422 | Route > 5,000 mi (FR-RTE-05) | Toast with the limit |
| `rate_limited` | 429 | API-05 exceeded or provider 429 | Toast "Too many requests, try again in a minute" |
| `provider_unavailable` | 503 | Primary and fallback provider both fail | Toast with Retry button |
| `schedule_failed`, `log_invalid` | 500 | FR-HOS-08, FR-LOG-04 | Toast "Something went wrong" + request ID |
| network error | — | No response within 90 s | Toast "Server not reachable" + Retry |

- ERR-01: Errors shall not clear the form.
- ERR-02: Unknown routes shall return 404 JSON for `/api/*`; the frontend shall show a not-found page for other unknown paths.

## 11. Audit and logging requirements

There are no user accounts or data changes to audit, so audit is limited to operational logs.

- LOGR-01: Log each API request per NFR-OBS-01 at INFO.
- LOGR-02: Log every provider error and fallback use at WARNING with provider, endpoint, status and latency.
- LOGR-03: Log every 500 at ERROR with request ID, a stack trace, and the sanitized request (locations rounded to 2 decimals; free-text fields removed).
- LOGR-04: Never log API keys, full request bodies or client IP beyond what the host logs by default.
- LOGR-05: Logs are retained per the hosting provider default, maximum 30 days.

## 12. Reporting and analytics requirements

The user-facing report is the trip itself: the summary (FR-MAP-06), the stop timeline and the PDF logs. No product analytics, cookies or tracking scripts shall be included. Operational metrics come only from logs (section 11).

## 13. AI/ML requirements

Not applicable. The schedule is deterministic and rule-based (NFR-REL-01); no AI/ML component shall be used at runtime.

## 14. Deployment and environment requirements

| Environment | Frontend | Backend | Providers |
| --- | --- | --- | --- |
| Local | Vite dev server, port 5173 | Django runserver, port 8000 | Real keys from `.env`, or mocked in tests |
| CI (GitHub Actions) | `npm ci`, lint, type check, build | ruff, pytest with coverage | All HTTP mocked; no keys |
| Production | Vercel, `VITE_API_URL` set | Render (or Railway) web service, gunicorn + whitenoise, Python 3.12 | Real keys from host environment |

- DEP-01: Required backend variables: `SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `ORS_API_KEY`, `NOMINATIM_USER_AGENT`. A committed `.env.example` lists them with placeholder values.
- DEP-02: Merging to `main` shall run CI; deployment shall happen only if CI passes.
- DEP-03: Dependencies shall be pinned (`requirements.txt` with versions, `package-lock.json`).
- DEP-04: The repository shall contain `render.yaml` (or the Railway equivalent) so the backend can be redeployed from scratch.
- DEP-05: Supported browsers: latest two versions of Chrome, Edge, Firefox and Safari, desktop and mobile.

## 15. Acceptance criteria

The release is accepted when every criterion passes on production, unless the method says otherwise.

| ID | Criterion | Method | Covers |
| --- | --- | --- | --- |
| AC-01 | Given a 1,100 mi leg at 50 mph, cycle 0, start 08:00, pre-trip 0: events match the reference schedule (pickup 08:00–09:00; drive to 17:00; break; drive to 20:30; SB to 06:30; drive to 14:30; break; drive to 16:00; fuel to 16:30; drive to 18:30; dropoff to 19:30). Day 1 = OFF 8.5, SB 3.5, D 11, ON 1; Day 2 = OFF 5, SB 6.5, D 11, ON 1.5. | Unit test | FR-HOS-01..06, BR-HOS-01..05, BR-PLN-01 |
| AC-02 | Same trip with cycle 65: a 34-hour restart starts at 13:00 day 1 and ends 23:00 day 2. With cycle 70, the restart is the first event. | Unit test | FR-HOS-04, BR-HOS-04, BR-HOS-06 |
| AC-03 | 500 random trips (50–3,000 mi, cycle 0–70): no event breaks BR-HOS-01..04 or BR-PLN-01; every day totals 24.00; segments contiguous; day miles sum to route miles ± 0.5. | Property test (Hypothesis) | OBJ-1, FR-LOG-03..05 |
| AC-04 | A 150 mi trip yields 1 sheet, no breaks, rests or fuel stops, totals 24.00. | Unit test | FR-LOG-01 |
| AC-05 | Schneider reference day (OFF 8.5, SB 5, D 9.5, ON 1) builds with 4 remarks, 4 brackets and circled 10.5. | Unit + visual test | FR-LOG-06..07, FR-UI-04..05 |
| AC-06 | The AC-05 day and the FMCSA p. 19 day render with every header field, the stepped line, totals, 45° flags without overlap, brackets and recap. | Playwright screenshot, reviewed manually | OBJ-2, FR-UI-01..05 |
| AC-07 | The sample trip plans end to end on production; map shows route, all stop markers and legend; timeline selection pans the map. | Manual | WF-1..3, FR-MAP-01..06 |
| AC-08 | Invalid inputs (empty location, cycle 71, cycle −1, nonsense place) show the specified messages and send no request, or return the specified 400. | Manual + API tests | FR-INP-01..05, section 10 |
| AC-09 | PDF download for a 3-day trip yields 3 landscape pages with selectable text. | Manual | FR-EXP-01 |
| AC-10 | Provider key string is absent from the repository history and the built frontend bundle. | Script in CI | FR-SYS-02, NFR-SEC-02 |
| AC-11 | Lighthouse desktop: Performance ≥ 80, Accessibility ≥ 90; axe: 0 serious or critical issues; no horizontal scroll at 360 px. | Tooling | NFR-PERF-04, NFR-ACC-01, NFR-ACC-03 |
| AC-12 | NFR-PERF-01..03 targets met on production. | Timed runs | Section 9 |
| AC-13 | GitHub repo, live URL and a 3–5 minute Loom submitted within 4 days. | Submission | OBJ-4 |

## 16. Constraints and assumptions

### Constraints

- CON-01: Django (backend) and React (frontend) are mandatory.
- CON-02: Free services only: free map, routing and hosting tiers.
- CON-03: ≤ 16 working hours over ≤ 4 days.
- CON-04: Rules apply to US interstate property carriers only (49 CFR 395).
- CON-05: Free-tier provider quotas and backend cold starts are outside the developer's control.

### Assumptions

- ASM-01: Property-carrying driver, 70 h/8-day cycle, no adverse driving conditions (brief).
- ASM-02: Fuel at least every 1,000 miles; 1 h pickup and 1 h dropoff (brief).
- ASM-03: Driver starts fresh; cycle used stays fixed except for restarts (BR-PLN-03).
- ASM-04: 30-minute pre-trip inspection per duty period, from the FMCSA example and the Schneider video (BR-PLN-02).
- ASM-05: Provider leg duration is a fair estimate of truck driving time (BR-PLN-08).
- ASM-06: The current location's time zone stands in for the home terminal's (BR-PLN-06).

## 17. Future considerations

- Split sleeper-berth periods (7/3, 8/2) for shorter trip times
- Day-by-day 8-day history input so hours roll off correctly
- Adverse driving conditions and short-haul exceptions; 60 h/7-day cycle
- Multi-stop trips and appointment time windows
- Truck-stop and fuel-price data for stop placement
- Saved, shareable trips (adds a database and data-retention rules)
- Import of actual ELD data to compare against the plan

## Appendix A. Requirements consistency review

The draft was reviewed for missing, ambiguous, duplicated, contradictory and unverifiable requirements. All findings below are fixed in this version.

| # | Type | Finding | Fix |
| --- | --- | --- | --- |
| 1 | Ambiguous | "Fuel at least once every 1,000 miles" did not say where the stop goes | BR-PLN-01: at the last 15-minute boundary at or before 1,000 mi |
| 2 | Contradictory | Rounding driving chunks up could push fuel past 1,000 mi | BR-PLN-05: fuel-limited chunks round down |
| 3 | Missing | No behavior when cycle used = 70 at start, or when pickup would exceed 70 | FR-HOS-04: restart before any on-duty or driving event |
| 4 | Ambiguous | Unclear whether on-duty work satisfies the 30-minute break | BR-HOS-03: OFF, SB or ON all qualify |
| 5 | Ambiguous | Unclear whether on-duty work is allowed after the 14-hour window | BR-HOS-02: allowed; only driving is barred |
| 6 | Duplicated | A break and a fuel stop could both be scheduled back to back | BR-PLN-04: fuel stop alone when both fall due together |
| 7 | Missing | No log time zone or default start time | BR-PLN-06, BR-PLN-07 |
| 8 | Ambiguous | Recap "last 8 days" needs history the input lacks | BR-PLN-03 + BR-LOG-03 define A from cycle used at start |
| 9 | Missing | Same-place trips, over-long trips, non-US input | FR-INP-06, FR-RTE-05, FR-GEO-01 (US only), scope |
| 10 | Unverifiable | Brief's "UI and UX must be good" | OBJ-3, NFR-PERF-04, NFR-ACC-01..03, AC-11 |
| 11 | Contradictory | Definition allowed OFF or SB for the 34-hour restart; BR-HOS-06 said OFF only | BR-HOS-06 now says OFF or SB; logging stays OFF (BR-PLN-06) |
| 12 | Missing | Pre-trip after a restart was unspecified | BR-PLN-02: after every 10-hour rest and restart |
| 13 | Missing | Risk of the output being mistaken for a compliant ELD | Scope note + FR-UI-09 disclaimer |
| 14 | Unverifiable | "Fast" and "reliable" without numbers | NFR-PERF-01..05, NFR-REL-01..02 with methods |

### Open items

- Confirm current OpenRouteService free-tier quotas and HGV maximum distance on its dashboard before deployment. Adjust FR-RTE-05 and API-05 if needed.
- Graders may not expect a pre-trip inspection. If early feedback says so, set it to 0 (BR-CFG) and update AC-01 fixtures.
