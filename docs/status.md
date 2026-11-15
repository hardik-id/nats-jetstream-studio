# Implementation status

All 46 backlog items in [backlog.md](backlog.md) have been implemented. This page says how each
was checked and what was **not** verified.

## How it was tested

| Suite | Command | Size | What it uses |
| --- | --- | --- | --- |
| Unit | `npm test` (project `unit`) | 23 tests | Pure logic: subjects, durations, JSONPath, filters, health rules, reconnect backoff |
| Gateway | `npm test` (project `core`) | 193 tests | The real `StudioService` against real `nats-server` processes (2.15.3), including a three-node cluster, TLS servers and a mock OIDC provider |
| UI | `npm test` (project `ui`) | 19 tests | React components against the in-memory fake gateway |
| End-to-end | `npm run test:e2e` | 38 tests | The real UI in Chromium against web mode, and the Electron app (also run against the packaged Linux build) |

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
| 011 | Add, edit, delete a connection | Tested | User/password, token, NKey and TLS (CA, client certificate, handshake-first) tested against live servers. **Credentials-file (JWT) login is implemented but was not tested against a JWT-enabled server.** |
| 012 | Test connection | Tested | The 5 second timeout is a setting (`testTimeoutMs`); there is no screen for it yet. |
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
| 091 | Saved filters and favourites | Tested | Export and import of saved filters as a file is **not implemented**. |
| 092 | Audit log | Tested | |
| 093 | Keyboard navigation, session restore | Tested | No formal screen-reader audit was done. |
| 100 | Installers and auto-update | **Partly verified** | See below. |
| 101 | Web and server mode | Tested | Token and OIDC sign-in, Docker image built and run. |

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
- `package.json` has no `repository` yet; set it before the first release so updates know where to look

## Differences from the planned stack

| Planned | Used | Why |
| --- | --- | --- |
| Monaco editor | Text area with JSON validation, and a JSON tree viewer | Much smaller; no web workers to configure under the security policy |
| shadcn/ui | A small set of own components on Tailwind | Fewer dependencies |
| Recharts | Own SVG line chart | One chart type was needed |
| React Router | A tab model in Zustand | Tabs, not pages, are the navigation |
| TanStack Table | Own table on TanStack Virtual | Sorting and keyboard handling were simple to write |
