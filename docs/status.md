# Implementation status

The backlog items in [backlog.md](backlog.md) (PBI-001 to PBI-125) have been implemented. PBI-127 is in progress: see its row. This page says how each was checked and what was **not** verified. The website
(Epic 12, PBI-130 to PBI-137) is in the section "Website" below.

## How it was tested

| Suite | Command | Size | What it uses |
| --- | --- | --- | --- |
| Unit | `npm test` (project `unit`) | 27 tests | Pure logic: subjects, durations, JSONPath, filters, health rules, reconnect backoff |
| Gateway | `npm test` (project `core`) | 212 tests | The real `StudioService` against real `nats-server` processes (2.15.3), including a three-node cluster, TLS servers, a JWT (operator mode) server and a mock OIDC provider |
| UI | `npm test` (project `ui`) | 59 tests | React components against the in-memory fake gateway |
| End-to-end | `npm run test:e2e` | 39 tests | The real UI in Chromium against web mode, and the Electron app (also run against the packaged Linux build) |

Lint: 0 errors. One informational warning remains (the virtual list library cannot be optimised by
the React compiler). Type-check: clean.

## Status by item

"Tested" means an automated test covers the acceptance criteria. Notes say what is not covered.

| PBI | Title | Status | Notes |
| --- | --- | --- | --- |
| 001 | Project scaffold | Tested | Based on the official electron-vite scaffold. |
| 002 | Typed IPC bridge and gateway | Tested | One protocol for IPC and WebSocket; fake gateway for UI tests. |
| 003 | App shell and layout | Tested | |
| 010 | Import NATS CLI contexts | Tested | Contexts that use `nsc` or `user_jwt` are listed with a warning; they cannot connect. |
| 011 | Add, edit, delete a connection | Tested | User/password, token, NKey, TLS (CA, client certificate, handshake-first) and credentials files (JWT, operator mode) are all tested against live servers. Credentials files with Windows line endings are accepted. A credentials file is read again at every reconnect, so a rotated file is picked up. |
| 012 | Test connection | Tested | The timeout (5 seconds by default, 1 to 60) is set in the connection form under "Connection test"; it applies to every connection test, as one deadline for connecting however many servers are listed, and is stored on Enter or when the field is left. |
| 013 | Multiple simultaneous connections | Tested | |
| 014 | Secure secret storage | Tested | Desktop uses Electron `safeStorage`. On this Linux/WSL machine no keychain is present, so the "no keychain" path is what ran here; the keychain path on Windows and macOS was not run. |
| 015 | Auto-reconnect and status | Tested | Retries at about 0, 0.25, 0.5, 1, 2, 4, 8 seconds, then every 8 seconds. |
| 016 | Read-only mode | Tested | Enforced in the gateway for all 21 mutating calls. |
| 020 | Server info | Tested | |
| 021 | JetStream account overview | Tested | Tiered limits are returned but shown only as the account totals. |
| 022 | Cluster topology | Tested | Checked on a real three-node cluster. |
| 030 | Streams list | Tested | 5,000 streams listed in one call. |
| 031 | Stream detail | Tested | |
| 032 | Create and edit a stream | Tested | Mirror, sources, placement and republish are edited in the JSON view only. |
| 033 | Purge and delete a stream | Tested | |
| 034 | Per-subject message counts | Tested | 120,000 subjects. |
| 035 | Export and import configuration | Tested | |
| 040 | Browse stream messages | Tested | All three read modes; work-queue and interest streams left untouched. |
| 041 | Choose the start position | Tested | |
| 042 | Filter by subject, header, payload | Tested | |
| 043 | Message detail and payload viewer | Tested | |
| 044 | Protobuf decoding | Tested | Own reflective decoder (the library's needs `eval`, which the app forbids). Groups are not supported. |
| 045 | Copy and export messages | Tested | |
| 046 | Delete a single message | Tested | |
| 047 | Republish a message | Tested | |
| 048 | Regex and JSONPath filters | Tested | JSONPath subset: fields, indexes, `*`, `..`, and one comparison. |
| 049 | Which consumers have received a message | Tested | State rules unit tested; gateway test against a real server (`all`, `new`, `by_start_sequence`, partial acks); web e2e. Electron project not run. `last` and `last_per_subject` can only say "probably not delivered" ([#32](https://github.com/hardik-id/nats-jetstream-studio/issues/32)). |
| 050 | Consumers list | Tested | 1,000 consumers on one stream. |
| 051 | Consumer detail and lag | Tested | |
| 052 | Create, edit, delete a consumer | Tested | |
| 053 | Pause and resume | Tested | On server 2.15. The "older than 2.11" message is implemented but no old server was run. |
| 054 | Highlight unhealthy consumers | Tested | |
| 060 | Live tail | Tested | 5,000 messages per second, worst frame under 250 ms in headless Chromium. |
| 061 | Subject tree | Tested | Shows the 5,000 busiest subjects per stream. |
| 062 | Publish and request | Tested | |
| 070 | Key-value buckets | Tested | 100,000 keys. |
| 071 | Object Store buckets | Tested | |
| 080 | Time-series charts | Tested | History for up to 500 streams and 2,000 consumers per connection. |
| 081 | Alerts and notifications | Tested | Desktop notifications use the standard Notification API; a headless browser cannot show one, so that last step was not observed. |
| 090 | Command palette | Tested | |
| 091 | Saved filters and favourites | Tested | Saved filters and favourites export to and import from one JSON file, from the "Saved" menu of the message browser. An import is limited to 500 saved filters (names up to 120 characters) and 2,000 favourites. |
| 092 | Audit log | Tested | |
| 093 | Keyboard navigation, session restore | Tested | No formal screen-reader audit was done. Desktop menu (issue #44): `src/main/menu.ts` sets an explicit menu (edit roles, zoom, full screen; reload and dev tools only when not packaged; no close-window item, so Ctrl/Cmd+W only closes a studio tab). Checked by unit tests of the template and an Electron e2e that reads `Menu.getApplicationMenu()` from the unpackaged build under a display on Linux. Not run: a packaged build (so the `isPackaged` branch is covered only by the unit test), Windows, macOS (app menu, Cmd+W). |
| 100 | Installers and auto-update | **Partly verified** | See below. |
| 101 | Web and server mode | Tested | Token and OIDC sign-in, Docker image built and run. |
| 110 | Visual redesign (Linear-style dashboard) | Done | Delivered through PBI-111 to PBI-123; see those rows. |
| 111 | Colour tokens, fonts and focus ring | Done | Inter and JetBrains Mono are bundled. Contrast ratios were recorded in the pull request. |
| 112 | Shared controls | Done | Buttons, inputs, status badges and the segmented tabs live in `ui.tsx`. |
| 113 | Dense data table | Done | Sticky header, 36 px rows, sideways scroll inside the table. |
| 114 | Top bar | Done | 44 px bar with breadcrumb, search button and connection state. |
| 115 | Sidebar with collapsible icon rail | Done | The message browser asks for the rail while its detail panel is open (PBI-123). |
| 116 | Tab bar with overflow menu | Done | 36 px tabs, "+N" menu for tabs that do not fit. |
| 117 | Message browser layout and detail panel | Done | Resizable detail panel, at least 440 px. |
| 118 | Payload and JSON colours | Done | The format switch uses the segmented control (PBI-123). |
| 119 | Publish page layout | Done | A long reply scrolls inside its box. |
| 120 | Object store detail metadata | Done | "Revision undefined" fixed. |
| 121 | List pages: header, filter and summary cards | Done | Several health flags show as one badge and "+N" (PBI-123). |
| 122 | Chart colours | Done | Series, grid and axis colours come from tokens. |
| 123 | Redesign final pass | Done | Every screen was checked in dark and light at 1280 x 720 and 1440 x 900, and a keyboard-only walk-through was done. Not run: Windows desktop (the minimum content width of 1024 px is set with `useContentSize`, see `docs/handoff-windows.md`). |
| 124 | Resizable table columns | Done | Drag, double-click reset and arrow keys on a handle in `DataTable`, so all tables get it; widths stored per table in settings. 15 UI tests (drag, clamp, reset, keyboard, sort not triggered, restore, corrupt value) and a Chromium e2e on the Streams table (drag widens the column, header and first row stay aligned, width survives a reload), checked in dark and light screenshots. Not run: touch input on a real device, Electron e2e of this feature. |
| 125 | Message browser: clearer filters, shapeable detail panel, readable JSON | Done | Filters button with chevron, pressed look, `aria-expanded`/`aria-controls` and count badge; compact filter panel with a sticky Apply/Clear/Hide footer, open for the visit only (not stored; it closes after Apply and Clear, and focus goes to the Filters button; chips stay), Esc returns focus. Collapsible detail sections (`CollapsibleSection`, one stored setting), a 36 px rail, and "Expand to read" (70% of the row by resizing the split, covering the full height of the stream page, not stored, saved width untouched). JSON: 13/15/17 px text, levels, expand/collapse all, debounced search (capped at 500 matches and 200,000 nodes; "expand all" is clamped to about 4,000 rows on large payloads), copy path and value. 8 unit tests (`src/shared/jsonTree.ts`), 21 UI tests in `tests/ui/messagePanel.test.tsx` (16 from PBI-125, including keyboard navigation of the JSON tree and focus after collapse, and 5 added for #58), Chromium e2e: 5 test cases from PBI-125, 6 runs because the no-scroll case runs at two sizes (1000 x 700 and 1440 x 900 with filters open and a message selected: the page did not scroll and the table stayed over 150 px; not measured at other sizes); a 900 KiB payload was searched in about 1 s. Checked in dark and light screenshots. Not run: Electron e2e, touch input, payloads above 1 MB. **Follow-ups (#58), JSON height:** the filter panel is capped at 35% of the window height (24% with a message open, about 11% on windows under 800 px high), Details/Headers/Consumers at 25% of the panel, the filter panel closes after Apply (when it took effect) and Clear, and Expand to read spans the whole stream page and makes the covered parts of that page inert with a declarative `inert` prop (stream header, tabs, toolbar, filter and notice rows; the table stays usable; the sidebar, tab strip, top bar and toasts are not covered and not inert, and the marks exist only while the overlay does: they are props of that page, and expanded state is reset when the message browser goes away, for example when the stream info fails and the page shows an error). Windows under 800 px high get a one-line Details block and visually hidden toolbar labels. Payload scroller measured in Chromium with a message selected, Headers and Consumers closed: 1440 x 900 filters closed 326 px (was about 130), filters open 206 px (was about 104); 1280 x 720 filters closed 216 px (130-200 before), filters open 136 px, expanded 393 px; 1000 x 600 normal 96 px, expanded 273 px; 1000 x 700 with filters open and a message selected 196 px, normal 116 px, expanded 373 px (these three from the reviewer's run, not mine). The page did not scroll in those states, nor at 1000 x 600 with filters open and nothing selected. At 1280 x 720 with filters open the filter fields are mostly scrolled out of view (only the footer and a strip of the body show). A closed Consumers section shows the stream's consumer count from its info. 1280 x 720 closed stays under the 240 px aim: the page chrome above the table is about 270 px. Not measured: other window sizes, Electron, touch, payloads above 1 MB, a screen reader. |
| 127 | Subjects screen: treegrid, detail pane and labelled actions | In progress (slice A done) | Slice A, the pure model in `src/renderer/src/features/subjects/subjectTree.ts` (tree with own and subtree counts, live counts, owning streams; search with ancestors and wildcard patterns; sort; filters; flat visible rows; expand all with the 5,000-row cap; levels; scope to filter mapping and the Publish rule). 48 unit tests in `tests/unit/subjectTree.test.ts`, including 10,000 subjects, a 3,000-level subject and a 100,000-subject build with 30 streams of 3 patterns (about 350 to 430 ms for the tree, ownership adds little; measured with the test run, not in the app). Totals count a mirrored message once per stream; per-stream counts are kept. `SubjectsTab.tsx` is unchanged. Not done: slice B (screen) and slice C (detail pane, actions, live timestamps); nothing here has been seen in the app yet. |

## Website (PBI-130 to PBI-137)

The site is in `site/` (Astro, static). The checks below were run on the built site in the PBI-137 change, served under the real base path (`/nats-jetstream-studio/`) by `site/scripts/serve.mjs`. The first four rows were built and merged in their own pull requests; this page does not repeat what was checked there, only what was run across the whole site at the end.

| PBI | Item | Status | How it was verified |
| --- | --- | --- | --- |
| 130 | Scaffold, layout, Pages deployment | Done | `npm run build` and `npm run check` (0 errors) in `site/`; all 21 pages pass the structure checks below. The deployment itself (`deploy` job) runs only on main and was not run for this change. |
| 131 | Home | Done | Same checks; Lighthouse on Home. The home recording was not re-taken (see issue #39). |
| 132 | Features pages | Done | Same checks; Lighthouse on Features and on Streams. |
| 133 | Download page | Done | Same checks; Lighthouse on Download. Built with the GitHub releases API (in this run with no token, so unauthenticated). |
| 134 | Docs pages | Done | Same checks; Lighthouse on Getting started; code blocks and tables fixed for contrast and keyboard access in this change. Install and Web mode come from `docs/`. |
| 135 | Changelog and RSS | Done | Same checks; `npm test` in `site/` (4 tests for the release-notes renderer). The feed was built; it was not opened in a feed reader. |
| 136 | Screenshots and recordings | Done | Pictures exist in `site/public/media/` and every `img` has alt text and size (checked by `check:built`). `npm run site:media` was not re-run in the PBI-137 change. |
| 137 | Search engines, accessibility and speed | Done | See below. |

What was run for PBI-137 (Linux, Playwright's Chromium 1255 via `CHROME_PATH`):

- `npm run check:built`: all 21 built pages and 667 internal links. No external script, stylesheet, font, image, media or iframe origin; no remote `url()` or `@import` in CSS or remote origin in the scripts; no broken internal link or `#anchor`; exactly one `h1` and no skipped heading level per page; every `img` has `alt`; unique title and description; canonical URL; Open Graph and Twitter tags with absolute image URL; `SoftwareApplication` on Home and `BreadcrumbList` equal to the visible breadcrumbs elsewhere; `robots.txt`, `sitemap-index.xml` and `sitemap-0.xml` exist and list every page. `npm run check:built:negative` injects 18 violations one at a time (remote script, stylesheet, image, `srcset`, `style` url, inline-script origin, preconnect, dns-prefetch, modulepreload, meta refresh, broken link, missing anchor, missing alt, second h1, and four wrong JSON-LD values) and requires each to fail.
- `npm run check:a11y`: axe-core (WCAG 2.0/2.1 A and AA and best practices, which includes the 4.5:1 text contrast rule) and an automated Tab walk (first stop is the skip link, every stop is visible and shows a focus style), on every page, in light and dark, at 1280 and 390 px wide (84 runs). It found code-block contrast, an empty table header, scrollable tables and a missing theme-colour for Shiki; all fixed. A person walked no page by hand. The first CI run scored Features 92 for performance (eight full-size screenshots competing with the first card on a slow link); the cards now use small copies made by `site/scripts/make-card-images.mjs` before build.
- `npm run lighthouse` (`lhci autorun`, mobile preset, 3 runs per page, median, assertion 0.95 on each category). Scores (performance / accessibility / best practices / SEO): Home 100/100/100/100, Features 100/100/100/100, Streams 100/100/100/100, Download 100/100/100/100, Getting started 100/100/100/100.

Not verified: the new workflow steps on GitHub's runners (they use `/usr/bin/google-chrome`), `robots.txt` and the sitemap on the live host (see below), Windows and macOS browsers, Safari and Firefox, screen readers.

Note on `robots.txt`: GitHub Pages serves this project under `/nats-jetstream-studio/`, and crawlers read `robots.txt` only at the host root, so the file at `/nats-jetstream-studio/robots.txt` is not found by them. It starts to work with a custom domain (`base` set to `/`). Search engines find the sitemap through Search Console or the link in the page.

## PBI-100: what was and was not verified

Done and checked on Linux:

- `electron-builder` configuration for Windows (NSIS), macOS (universal dmg) and Linux (AppImage, deb)
- An unpacked Linux build, which passes the desktop end-to-end tests
- Release workflow (`.github/workflows/release.yml`) that builds on a version tag and publishes to
  the GitHub release
- Update flow in the app: check on start, "Download", "Restart to install", "Later"; About dialog
  with app and NATS client versions

Not run, because they need things this machine does not have:

- Windows and macOS builds (the app was developed and tested on Linux only)
- AppImage and deb packaging
- Code signing and notarization (need certificates: see the secrets listed in the workflow)
- A real auto-update (needs a published release to update from)

## Differences from the planned stack

| Planned | Used | Why |
| --- | --- | --- |
| Monaco editor | Text area with JSON validation, and a JSON tree viewer | Much smaller; no web workers to configure under the security policy |
| shadcn/ui | A small set of own components on Tailwind | Fewer dependencies |
| Recharts | Own SVG line chart | One chart type was needed |
| React Router | A tab model in Zustand | Tabs, not pages, are the navigation |
| TanStack Table | Own table on TanStack Virtual | Sorting and keyboard handling were simple to write |
