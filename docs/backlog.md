# NATS JetStream Studio: Product Backlog

Epics and product backlog items (PBIs) for NATS JetStream Studio. See the [README](../README.md) for the vision and [architecture.md](architecture.md) for the architecture.

## How to read this

- **Priority:** `MVP` is the first usable release, `v1` is the first full release, `Later` is wanted but unscheduled.
- **Size:** `S` is up to 2 days, `M` is 3 to 5 days, `L` is more than a week and may be split when picked up.
- **Read-only mode** (PBI-016) applies to every PBI that changes server state. Those PBIs say "blocked in read-only mode".

## Summary

| Epic | PBIs | MVP | v1 | Later |
| --- | --- | --- | --- | --- |
| 0. Foundation | 001 to 003 | 3 | | |
| 1. Connection management | 010 to 016 | 7 | | |
| 2. Dashboard and server overview | 020 to 022 | 2 | 1 | |
| 3. Streams | 030 to 035 | 5 | 1 | |
| 4. Message browser | 040 to 048 | 5 | 4 | |
| 5. Consumers | 050 to 054 | 3 | 2 | |
| 6. Subjects explorer and live tail | 060 to 062 | 2 | 1 | |
| 7. KV and Object Store | 070 to 071 | | 2 | |
| 8. Monitoring and metrics | 080 to 081 | | 1 | 1 |
| 9. Productivity and UX | 090 to 093 | | 4 | |
| 10. Packaging and distribution | 100 to 101 | | 1 | 1 |
| 11. Visual design | 110 to 123 | | 14 | |
| **Total (60)** | | **27** | **31** | **2** |

## MVP slice and build order

The MVP lets someone connect to their servers, see what is in JetStream, read and filter messages, and do basic stream and consumer administration.

1. Foundation: PBI-001, 002, 003
2. Connect: PBI-011, 012, 014, then 010, 013, 015, 016
3. Overview: PBI-020, 021
4. Streams, read side: PBI-030, 031, 034
5. Messages: PBI-040, 041, 043, then 042, 045
6. Consumers, read side: PBI-050, 051
7. Administration: PBI-032, 033, 052
8. Live: PBI-060, 062

## Cross-cutting requirements

These apply to every PBI and are part of the definition of done.

- **Safety:** the read-only guard is enforced in the main process, not only by hiding buttons.
- **Secrets:** passwords, tokens, seeds and JWTs never reach the renderer after saving and never appear in logs or error messages.
- **Errors:** NATS errors are shown with their error code and description. Permission errors say which subject was denied.
- **Scale:** lists stay responsive with 5,000 streams, 1,000 consumers per stream and 100,000 keys or subjects (paged API calls, virtualized tables).
- **Server support:** NATS Server 2.10 and newer. Features that need a newer server are hidden or disabled with an explanation.
- **Tests:** gateway logic has unit tests against a real `nats-server` started for the test run. UI logic is tested against the fake gateway.

---

## Epic 0: Foundation

### PBI-001: Project scaffold
**Priority:** MVP · **Size:** M

**Story:** As a developer, I want a working Electron, React and TypeScript project with build, lint and test tooling, so that every later PBI starts from a runnable app.

**Acceptance criteria**
- `npm run dev` opens an Electron window that renders a React page with hot reload.
- `npm run build` produces production bundles for the main, preload and renderer processes.
- `npm run lint` and `npm run typecheck` run ESLint, Prettier and TypeScript in strict mode.
- Vitest runs unit tests, and one Playwright smoke test launches the app and finds the main window.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.

### PBI-002: Typed IPC bridge and `NatsGateway` interface
**Priority:** MVP · **Size:** M · **Depends on:** PBI-001

**Story:** As a developer, I want the renderer to reach NATS only through a typed `NatsGateway` interface, so that the UI never touches sockets or credentials and can later run against a web backend.

**Acceptance criteria**
- A shared TypeScript interface defines every NATS operation the UI uses.
- The Electron implementation is exposed through the preload script with `contextBridge`. The renderer has no direct `ipcRenderer` access.
- Both request/response calls and streaming subscriptions (start, data, stop) are supported.
- Errors cross the boundary as a structured object with a kind, the NATS error code when there is one, and a message.
- An in-memory fake gateway exists for UI tests.

### PBI-003: App shell and layout
**Priority:** MVP · **Size:** M · **Depends on:** PBI-001

**Story:** As a user, I want a consistent layout with navigation, tabs and a status area, so that I can move between servers and resources quickly.

**Acceptance criteria**
- A left sidebar lists connections. Each connected one expands into Overview, Streams, Consumers, Subjects, KV and Object Store.
- A top bar shows the active connection name, its environment label and its status.
- The main area has tabs. Several resources can be open at once and tabs can be closed and reordered.
- Light and dark themes follow the OS setting, with a manual override.
- With no connections, the main area shows an empty state that leads to "Add connection".
- The layout is usable at 1280 x 720.

---

## Epic 1: Connection management

### PBI-010: Import NATS CLI contexts
**Priority:** MVP · **Size:** M · **Depends on:** PBI-011

**Story:** As a NATS CLI user, I want the studio to find my existing `nats` contexts, so that I can connect without re-entering anything.

**Acceptance criteria**
- On startup the studio reads `~/.config/nats/context/*.json` (honouring `XDG_CONFIG_HOME`) and lists each context as a connection.
- These context fields are supported: `url`, `user`, `password`, `token`, `creds`, `nkey`, `cert`, `key`, `ca`, `jetstream_domain`, `jetstream_api_prefix`, `inbox_prefix`.
- Imported connections are marked as "from NATS CLI". The studio never writes to the CLI's files.
- A malformed context file is skipped with a visible warning and does not block the others.
- A refresh action re-reads the folder without restarting the app.

### PBI-011: Add, edit and delete a connection
**Priority:** MVP · **Size:** L · **Depends on:** PBI-002, PBI-003

**Story:** As a user, I want to define my own connections, so that I can reach servers that are not in my CLI contexts.

**Acceptance criteria**
- The form has a name, one or more server URLs, an authentication method, and optional JetStream domain, API prefix and inbox prefix.
- Authentication methods: none, user and password, token, NKey seed, credentials file (JWT and NKey).
- TLS options: CA file, client certificate and key, TLS-first handshake.
- URLs are validated (`nats://`, `tls://`, host, port) and required fields are enforced before saving.
- A connection can be edited, duplicated and deleted. Delete asks for confirmation.
- Connections persist across restarts.

### PBI-012: Test connection
**Priority:** MVP · **Size:** S · **Depends on:** PBI-011

**Story:** As a user, I want to test a connection before saving it, so that I find mistakes straight away.

**Acceptance criteria**
- A "Test" button in the form works without saving.
- Success shows server name, version, cluster name, round-trip time and whether JetStream is available to the account.
- Failure names the cause: authentication, TLS, timeout or name resolution.
- The test gives up after 5 seconds (configurable).

### PBI-013: Multiple simultaneous connections
**Priority:** MVP · **Size:** M · **Depends on:** PBI-011

**Story:** As a user who works with several environments, I want to be connected to many servers at once, so that I can compare them without reconnecting.

**Acceptance criteria**
- At least five connections can be open at the same time, each with its own tree in the sidebar.
- Every tab belongs to one connection and shows that connection's label and colour.
- Each connection has a colour and an environment label (for example dev, test, prod).
- Connecting or disconnecting one connection does not affect the others.
- Disconnect closes the NATS connection and stops all of its subscriptions and polling.

### PBI-014: Secure secret storage
**Priority:** MVP · **Size:** M · **Depends on:** PBI-011

**Story:** As a user, I want my credentials stored safely, so that saving a connection does not leak them.

**Acceptance criteria**
- Passwords, tokens and NKey seeds are encrypted with Electron `safeStorage` (OS keychain). They are never written in plain text.
- Credentials and key files are referenced by path, not copied.
- After saving, secrets are not sent back to the renderer. The form shows a placeholder.
- Secrets never appear in logs or error messages.
- If the OS keychain is unavailable, the user is warned and can choose to be asked for the secret on each connect instead.

### PBI-015: Auto-reconnect and connection status
**Priority:** MVP · **Size:** S · **Depends on:** PBI-013

**Story:** As a user, I want to see connection health and have dropped connections recover, so that a network blip does not lose my place.

**Acceptance criteria**
- Status (connected, reconnecting, disconnected, error) is shown in the sidebar and the top bar.
- Dropped connections reconnect with backoff, and open views refresh afterwards.
- Live tails resume after a reconnect and show a marker where messages may have been missed.
- Authentication and permission failures stop retrying and show the reason.

### PBI-016: Read-only mode per connection
**Priority:** MVP · **Size:** S · **Depends on:** PBI-011

**Story:** As a user looking at production, I want a read-only switch, so that I cannot purge, delete or publish by accident.

**Acceptance criteria**
- Each connection has a read-only toggle. It defaults to on for connections labelled prod.
- When on, every create, edit, delete, purge and publish action is disabled, with a tooltip that says why.
- The main process rejects mutating gateway calls on a read-only connection, whatever the UI sends.
- A read-only badge is visible in the top bar and on the connection in the sidebar.

---

## Epic 2: Dashboard and server overview

### PBI-020: Server info
**Priority:** MVP · **Size:** S · **Depends on:** PBI-013

**Story:** As a user, I want to see which server I am connected to, so that I know its version and limits.

**Acceptance criteria**
- The Overview shows server name, version, cluster name, connected URL, max payload, whether TLS is in use and the JetStream domain.
- The connected user and account are shown when the server reports them.
- The card updates after a reconnect, including when the client lands on a different cluster node.

### PBI-021: JetStream account overview
**Priority:** MVP · **Size:** M · **Depends on:** PBI-020

**Story:** As a user, I want to see JetStream usage against limits, so that I notice when the account is close to full.

**Acceptance criteria**
- Storage and memory used are shown against their limits, as are stream and consumer counts.
- JetStream API totals and error counts are shown.
- The view refreshes on an interval (default 5 seconds) and on demand. Polling pauses while the tab is hidden.
- If JetStream is not enabled for the account, the view says so instead of showing errors.

### PBI-022: Cluster topology
**Priority:** v1 · **Size:** L · **Depends on:** PBI-021

**Story:** As an operator, I want to see the servers in the cluster and how they are linked, so that I can spot an unhealthy node.

**Acceptance criteria**
- With system-account access, the view lists every server with version, connections, CPU, memory and JetStream usage.
- Routes, gateways and leaf nodes are shown.
- The JetStream meta leader is shown, and each stream's leader and replica state can be reached from here.
- Without system-account access, the view explains what permission is needed.

---

## Epic 3: Streams

### PBI-030: Streams list
**Priority:** MVP · **Size:** M · **Depends on:** PBI-013

**Story:** As a user, I want a searchable list of streams, so that I can find one and see its size at a glance.

**Acceptance criteria**
- Columns: name, subjects, storage type, retention, replicas, messages, bytes, consumer count, first and last sequence, time of last message.
- Search matches stream name and subjects. Every column sorts. Storage and retention can be filtered.
- The list handles 5,000 streams (paged API calls, virtualized table).
- Streams that back KV and Object Store buckets (`KV_`, `OBJ_`) are hidden by default, with a toggle to show them.
- The list refreshes on an interval and on demand. Clicking a row opens the stream detail.

### PBI-031: Stream detail
**Priority:** MVP · **Size:** M · **Depends on:** PBI-030

**Story:** As a user, I want one page per stream with its state and configuration, so that I understand how it is set up.

**Acceptance criteria**
- Tabs: Overview, Messages, Consumers, Subjects, Configuration.
- State shows messages, bytes, first and last sequence with timestamps, deleted message count and consumer count.
- Configuration is shown as labelled fields and as raw JSON.
- Cluster information shows the leader and each replica as current, lagging or offline.
- Mirror and source streams are shown with their lag.

### PBI-032: Create and edit a stream
**Priority:** MVP · **Size:** L · **Depends on:** PBI-031, PBI-016

**Story:** As a user, I want to create and change streams from the UI, so that I do not need the CLI for routine setup.

**Acceptance criteria**
- The form covers name, subjects, storage, retention, replicas, limits (messages, bytes, age, message size, messages per subject), discard policy, duplicate window, compression, allow direct, allow rollup, deny delete and deny purge.
- A toggle switches between the form and raw JSON, and the two stay in sync.
- In edit mode, fields the server does not allow to change are disabled.
- Server validation errors are shown with the NATS error code and description.
- Blocked in read-only mode.

### PBI-033: Purge and delete a stream
**Priority:** MVP · **Size:** S · **Depends on:** PBI-031, PBI-016

**Story:** As a user, I want to purge or delete a stream with a clear confirmation, so that cleanup is possible but hard to do by mistake.

**Acceptance criteria**
- Purge options: everything, by subject filter, up to a sequence, keep the last N.
- A stream can be deleted.
- Both actions require typing the stream name. The dialog shows the connection name and the current message count.
- The result shows how many messages were purged.
- Blocked in read-only mode.

### PBI-034: Per-subject message counts
**Priority:** MVP · **Size:** M · **Depends on:** PBI-031

**Story:** As a user, I want to see which subjects a stream holds and how many messages each has, so that I know where the data is.

**Acceptance criteria**
- The Subjects tab lists subjects with message counts, read from stream info with a subjects filter.
- The list can be filtered with a NATS wildcard and sorted by count or name.
- Streams with more than 100,000 subjects are paged.
- Clicking a subject opens the message browser filtered to it.

### PBI-035: Export and import stream configuration
**Priority:** v1 · **Size:** S · **Depends on:** PBI-032

**Story:** As a user, I want to copy stream definitions between environments, so that dev and prod stay alike.

**Acceptance criteria**
- A stream's configuration exports as JSON that `nats stream add --config` accepts.
- Importing a JSON file opens the create form pre-filled.
- Export can include the stream's consumers.
- Several selected streams can be exported in one action.

---

## Epic 4: Message browser

### PBI-040: Browse stream messages
**Priority:** MVP · **Size:** L · **Depends on:** PBI-031

**Story:** As a user, I want to page through the messages in a stream, so that I can see what was published without affecting any consumer.

**Acceptance criteria**
- The Messages tab lists sequence, subject, timestamp, size and a payload preview.
- Messages load in pages (default 50) with next and previous, newest first or oldest first.
- Reading uses the get-by-sequence APIs (direct get when the stream allows it). No durable consumer is created and nothing is acknowledged.
- Browsing WorkQueue and Interest streams does not remove or consume messages.
- Gaps left by deleted messages are skipped without errors or empty rows.
- A page of 50 loads in under a second against a local server. Large payloads are truncated in the list.

### PBI-041: Choose the start position
**Priority:** MVP · **Size:** S · **Depends on:** PBI-040

**Story:** As a user, I want to jump to a point in the stream, so that I do not page through millions of messages.

**Acceptance criteria**
- Start from the first message, the last N, a sequence number, or a date and time.
- A sequence outside the stream's range moves to the nearest valid one and says so.
- The time picker uses local time and shows the UTC value.
- A "Jump to latest" action is always available.

### PBI-042: Filter by subject, header and payload text
**Priority:** MVP · **Size:** L · **Depends on:** PBI-040

**Story:** As a user, I want to filter messages, so that I can find the few that matter.

**Acceptance criteria**
- The subject filter accepts NATS wildcards (`orders.*.created`, `orders.>`) and is applied by the server.
- Header filters (key exists, key equals value) and a payload "contains" text filter are applied in the main process while scanning.
- A scan shows progress (messages scanned, matches found), can be cancelled, and stops at a configurable limit (default 10,000 scanned).
- Filters combine with AND and are shown as removable chips.
- An empty result says whether there were no matches or the scan limit was reached, and offers to continue.

### PBI-043: Message detail and payload viewer
**Priority:** MVP · **Size:** M · **Depends on:** PBI-040

**Story:** As a user, I want to open a message and read its headers and payload properly, so that I can understand its content.

**Acceptance criteria**
- A detail panel shows subject, sequence, timestamp, size and a headers table.
- Payload views: JSON (formatted and collapsible), text, hex and base64. The format is detected, with a manual switch.
- Payloads over 1 MB load on demand.
- Subject, headers and payload can each be copied.
- Previous and next message are reachable from the panel, including by keyboard.

### PBI-044: Protobuf decoding
**Priority:** v1 · **Size:** L · **Depends on:** PBI-043

**Story:** As a user whose services publish Protobuf, I want payloads decoded, so that I can read them.

**Acceptance criteria**
- `.proto` files can be registered per connection and mapped from a subject pattern to a message type.
- Matching payloads are decoded and shown in the JSON view.
- A decode failure falls back to hex and shows the error.
- Decoders sit behind a documented interface, so Avro and MessagePack can be added later.

### PBI-045: Copy and export messages
**Priority:** MVP · **Size:** S · **Depends on:** PBI-042

**Story:** As a user, I want to take messages out of the studio, so that I can share them or use them in tests.

**Acceptance criteria**
- One or more selected messages export to a JSON or NDJSON file.
- Each exported message has subject, sequence, timestamp, headers and payload (base64 when it is not valid UTF-8).
- "Export all matching the current filter" works with a maximum count and a progress indicator.
- A single message can be copied as a `nats pub` command.

### PBI-046: Delete a single message
**Priority:** v1 · **Size:** S · **Depends on:** PBI-043, PBI-016

**Story:** As a user, I want to remove one bad message, so that I do not have to purge a whole subject.

**Acceptance criteria**
- Delete is available from the message detail, with a confirmation that shows sequence and subject.
- The user can choose secure erase or delete without erase.
- The action is disabled when the stream has `deny_delete` set.
- The list updates after the delete.
- Blocked in read-only mode.

### PBI-047: Republish a message
**Priority:** v1 · **Size:** M · **Depends on:** PBI-043, PBI-062

**Story:** As a user, I want to send a stored message again, so that I can replay a failed event.

**Acceptance criteria**
- A message can be republished to the same or another subject, with payload and headers editable first.
- Several selected messages can be republished with a rate limit.
- A warning is shown when the target subject is captured by the source stream, since that creates duplicates.
- Each republish is recorded in the audit log (PBI-092).
- Blocked in read-only mode.

### PBI-048: Advanced filters (regex and JSONPath)
**Priority:** v1 · **Size:** M · **Depends on:** PBI-042

**Story:** As a user, I want to filter on payload structure, so that I can find messages by field value.

**Acceptance criteria**
- The payload can be matched with a regular expression.
- A JSONPath expression with a comparison (for example `$.order.total > 100`) can be used as a filter.
- An invalid expression shows an inline error before the scan starts.
- Payloads that are not JSON are skipped by JSONPath filters, and the skipped count is shown.

---

## Epic 5: Consumers

### PBI-050: Consumers list
**Priority:** MVP · **Size:** M · **Depends on:** PBI-031

**Story:** As a user, I want to see a stream's consumers and how far behind they are, so that I can spot a stuck one.

**Acceptance criteria**
- Columns: name, durable or ephemeral, pull or push, filter subjects, ack policy, pending, ack pending, redelivered, waiting pulls, last active.
- A per-connection view lists consumers across all streams.
- The list has search and sorting, and refreshes on an interval and on demand.
- The list handles 1,000 consumers on one stream.

### PBI-051: Consumer detail and lag
**Priority:** MVP · **Size:** M · **Depends on:** PBI-050

**Story:** As a user, I want a consumer's exact position, so that I can tell whether it is processing, stalled or redelivering.

**Acceptance criteria**
- Configuration is shown as labelled fields and as raw JSON.
- Delivered position and ack floor are shown as consumer and stream sequences with their last-active times.
- Lag is shown as unprocessed messages, next to the stream's last sequence for comparison.
- Cluster information shows the leader and replicas.
- A link opens the message browser at the next message the consumer has not been delivered.

### PBI-052: Create, edit and delete a consumer
**Priority:** MVP · **Size:** L · **Depends on:** PBI-051, PBI-016

**Story:** As a user, I want to manage consumers from the UI, so that I can set one up or remove a stale one.

**Acceptance criteria**
- The form covers name, durable or ephemeral, pull or push, filter subjects, deliver policy (all, last, new, by start sequence, by start time, last per subject), ack policy, ack wait, max deliver, backoff, max ack pending, replay policy and inactive threshold. Push consumers add deliver subject and deliver group.
- A toggle switches between the form and raw JSON, and the two stay in sync.
- In edit mode, fields the server does not allow to change are disabled.
- Delete requires typing the consumer name.
- Blocked in read-only mode.

### PBI-053: Pause and resume a consumer
**Priority:** v1 · **Size:** S · **Depends on:** PBI-051, PBI-016

**Story:** As an operator, I want to pause a consumer for a while, so that I can stop delivery during an incident without deleting it.

**Acceptance criteria**
- A consumer can be paused until a chosen time and resumed early.
- The paused state and remaining time are shown in the list and the detail.
- On servers older than 2.11 the action is disabled with an explanation.
- Blocked in read-only mode.

### PBI-054: Highlight unhealthy consumers
**Priority:** v1 · **Size:** M · **Depends on:** PBI-050, PBI-080

**Story:** As a user, I want problem consumers flagged, so that I do not have to read every row.

**Acceptance criteria**
- A consumer is flagged when its lag keeps growing, redeliveries exceed a threshold, it has pending messages but no activity for a set time, ack pending is at its maximum, or it has no leader.
- Thresholds are configurable per connection.
- Flagged consumers have a badge in the list, and the Overview shows a count.
- The list can be filtered to unhealthy consumers only.

---

## Epic 6: Subjects explorer and live tail

### PBI-060: Live tail of a subject
**Priority:** MVP · **Size:** M · **Depends on:** PBI-013, PBI-043

**Story:** As a user, I want to watch messages on a subject as they arrive, so that I can see what my services are doing right now.

**Acceptance criteria**
- Subscribing to a subject or wildcard shows arriving messages with time, subject, size and a payload preview.
- The tail can be paused, resumed and cleared, and shows the current message rate.
- The buffer is capped (default 10,000 messages). The oldest are dropped and the dropped count is shown.
- The UI stays responsive at 5,000 messages per second.
- Subscribing to `>` on a connection labelled prod asks for confirmation first.
- Clicking a message opens the detail viewer (PBI-043). Several tails can run in separate tabs.

### PBI-061: Subject tree
**Priority:** v1 · **Size:** L · **Depends on:** PBI-034, PBI-060

**Story:** As a user, I want subjects shown as a hierarchy, so that I can explore a naming scheme I do not know.

**Acceptance criteria**
- A tree is built token by token from stream subject counts and from subjects seen in live tails.
- Each node shows its stored message count and which stream captures it.
- Nodes expand lazily and the tree can be searched.
- From a node the user can browse stored messages, start a tail or publish.

### PBI-062: Publish and request
**Priority:** MVP · **Size:** M · **Depends on:** PBI-013, PBI-016

**Story:** As a user, I want to send a message or a request, so that I can test a subscriber or a service.

**Acceptance criteria**
- The form has subject, headers and a payload editor with JSON validation.
- Both a core publish and a JetStream publish are available. The JetStream publish shows the acknowledgement (stream, sequence, duplicate flag).
- Request mode shows the reply's payload, headers and round-trip time, with a configurable timeout. "No responders" is reported as such.
- Messages can be saved as templates per connection, and the last 20 sent are kept as history.
- Blocked in read-only mode.

---

## Epic 7: KV and Object Store

### PBI-070: Key-Value buckets
**Priority:** v1 · **Size:** L · **Depends on:** PBI-043, PBI-016

**Story:** As a user, I want to browse and edit KV buckets, so that I can inspect configuration and state kept in NATS.

**Acceptance criteria**
- Buckets are listed with name, value count, size, history depth, TTL, replicas and storage type.
- Keys can be searched and filtered by prefix. The list handles 100,000 keys.
- A key's value opens in the payload viewer with its revision and created time, and the key's revision history can be viewed.
- Keys can be put, deleted and purged, and buckets created and deleted. These are blocked in read-only mode.
- A watch mode shows changes to the bucket live.

### PBI-071: Object Store buckets
**Priority:** v1 · **Size:** M · **Depends on:** PBI-016

**Story:** As a user, I want to browse Object Store buckets, so that I can see and fetch stored files.

**Acceptance criteria**
- Buckets are listed with size and object count.
- Objects are listed with name, size, modified time, digest, chunk count and description.
- An object can be downloaded to a file with progress.
- Files can be uploaded and objects deleted. These are blocked in read-only mode.
- Text, JSON and image objects under 1 MB can be previewed.

---

## Epic 8: Monitoring and metrics

### PBI-080: Time-series charts
**Priority:** v1 · **Size:** L · **Depends on:** PBI-031, PBI-051

**Story:** As a user, I want to see rates and lag over time, so that I can tell a trend from a snapshot.

**Acceptance criteria**
- Stream detail charts message rate, total messages and bytes.
- Consumer detail charts pending, ack pending and redelivered.
- Samples are taken in memory while the app is open (default every 5 seconds, last hour kept). No external database is needed.
- The time range can be set to 5 minutes, 15 minutes or 1 hour, and hovering shows values.
- Sampling stops for disconnected connections.

### PBI-081: Alerts and desktop notifications
**Priority:** Later · **Size:** M · **Depends on:** PBI-080

**Story:** As a user, I want to be told when a threshold is crossed, so that I do not have to watch the screen.

**Acceptance criteria**
- Rules are defined per connection with a metric (consumer pending, redelivered, stream bytes as a share of its limit), a threshold and a duration.
- A triggered rule shows a badge and, if enabled, a desktop notification.
- Rules can be muted or snoozed.
- Alerts triggered during the session are listed.

---

## Epic 9: Productivity and UX

### PBI-090: Command palette and global search
**Priority:** v1 · **Size:** M · **Depends on:** PBI-030, PBI-050

**Story:** As a frequent user, I want to jump to anything by typing, so that I do not click through the tree.

**Acceptance criteria**
- Ctrl+K (Cmd+K on macOS) opens a palette with fuzzy search over connections, streams, consumers, KV buckets and Object Store buckets.
- Results are grouped by type and connection. Enter opens the result in a tab.
- Actions are included (new connection, publish, toggle theme).
- Results appear within 100 ms from cached metadata.

### PBI-091: Saved filters and favourites
**Priority:** v1 · **Size:** S · **Depends on:** PBI-042

**Story:** As a user, I want to keep the filters and resources I use most, so that I do not rebuild them every day.

**Acceptance criteria**
- A message-browser filter set can be saved under a name, per connection.
- Streams, consumers and subjects can be starred, and starred items appear in a Favourites section in the sidebar.
- Saved filters and favourites persist across restarts and can be exported and imported as JSON.

### PBI-092: Audit log of changes
**Priority:** v1 · **Size:** S · **Depends on:** PBI-016

**Story:** As a team lead, I want a record of what was changed from the studio, so that we can answer "who purged that?".

**Acceptance criteria**
- Every mutating action records time, connection, action, target and result.
- The log can be viewed, filtered and exported as CSV.
- The log is stored locally. Payloads and secrets are not recorded.
- Retention is configurable (default 90 days).

### PBI-093: Keyboard navigation and session restore
**Priority:** v1 · **Size:** M · **Depends on:** PBI-003

**Story:** As a user, I want the app to work from the keyboard and reopen where I left off, so that daily use is quick.

**Acceptance criteria**
- Tables can be navigated with arrow keys, Enter and Esc.
- A help overlay (`?`) lists the shortcuts.
- Open tabs, the active connection and the layout are restored on restart. Connections reconnect when their tab is opened.
- Focus is always visible, and controls have labels for screen readers.

---

## Epic 10: Packaging and distribution

### PBI-100: Installers and auto-update
**Priority:** v1 · **Size:** L · **Depends on:** PBI-001

**Story:** As a user, I want a normal installer and updates, so that I can install the studio without building it.

**Acceptance criteria**
- electron-builder produces installers for Windows (NSIS), macOS (universal dmg) and Linux (AppImage and deb).
- CI builds on a version tag and attaches the installers to the GitHub release.
- Windows and macOS builds are code-signed, and the macOS build is notarized.
- The app checks for updates on start, and the user can defer an update.
- The About dialog shows the app version and the NATS client version.

### PBI-101: Web and server mode
**Priority:** Later · **Size:** L · **Depends on:** PBI-002

**Story:** As a platform team, I want to host the studio for everyone, so that people can use it from a browser without installing anything.

**Acceptance criteria**
- The same React UI is served by a Node backend that implements `NatsGateway` over HTTP and WebSocket.
- The backend ships as a Docker image, with connections configured on the server.
- Users must sign in (OIDC) before any NATS access.
- Read-only mode can be enforced on the server per connection.
- Differences from the desktop app are documented.

---

## Epic 11: Visual design

### PBI-110: Visual redesign based on a Linear-style developer-tool dashboard
**Priority:** v1 · **Size:** L · **Depends on:** PBI-003

**Story:** As a user who spends hours in the studio, I want a refined, dark-first look with dense tables and one accent colour, so that it feels like a modern developer tool and is easy on the eyes.

**Reference:** [Linear inspired developer tool dashboard](https://superdesign.dev/library/linear-inspired-developer-tool-dashboard) (a community mockup, not Linear itself). The design is prepared first (with the `/design` command), and this item implements it.

**Direction (to be confirmed by the design)**
- Dark-first: a near-black base with an indigo accent. The light theme stays and gets the same treatment.
- Regions are separated by borders, not shadows. Dense tables with sticky headers. Strong colour is kept for status (green, amber, red).

**Acceptance criteria**
- A design document or prototype exists and has been approved before the code changes start.
- The new look is applied through the colour tokens in `src/renderer/src/main.css` and the shared components in `src/renderer/src/components/ui.tsx`, so no screen needs its own styling.
- Light and dark themes both pass the contrast checks: text at least 4.5:1, chart and status colours validated with the dataviz palette validator.
- The layout problems found in the screenshot review are fixed: the cramped payload column when the message panel is open, tabs clipped at the right edge, table columns cut off at 1440 px, the cut-off reply on the Publish page, and the "Revision undefined" text in the object store detail.
- The end-to-end tests pass unchanged, except for selectors the design intentionally changes, and the screenshots are retaken and attached to the pull request.
- Usable at 1280 x 720 and with keyboard focus visible everywhere.

**Design:** [PBI-110 redesign canvas](https://claude.ai/artifact/5AfNuQJycZfJ1pvCRCpFuY), approved by the product owner on 2026-11-15 (private to the owner; four boards: Foundations, Streams dark, Message browser dark, Consumers light). PBI-110 is delivered through PBI-111 to PBI-123 below.

### Working on the PBI-110 sub-items (for agents)

Each item below is small enough for one agent in one session. Rules for every item:

- Start from `main` on a branch named `ui/pbi-1NN-short-name`. Touch only the files the item lists. If another file must change, keep the change minimal and say why in the PR.
- Read the design canvas boards named in the item. Use the CSS variables from PBI-111 (`var(--…)` or the Tailwind classes that map to them), never new hex values in components.
- Before opening the PR, run `npm run lint`, `npm run typecheck`, `npm test` and `npm run test:e2e`. Update e2e selectors only where the item changes them on purpose.
- Attach a before and after screenshot (dark and light) of every screen the item changes. Use the fake gateway (`npm run dev` in web mode) or the seeded local server (`npm run nats`, `npm run seed`).
- Do not merge. Leave the PR for review.

**Order and parallel waves**

| Wave | Items | Can run in parallel? |
| --- | --- | --- |
| 1 | PBI-111 tokens and fonts | No, everything depends on it |
| 2 | PBI-112 controls, PBI-113 tables, PBI-118 payload colours, PBI-122 charts, PBI-120 object store fix | Yes, separate files (PBI-120 can start any time) |
| 3 | PBI-114 top bar, PBI-115 sidebar, PBI-116 tab bar, PBI-117 message browser, PBI-119 publish, PBI-121 list page headers | Yes, separate files; all need 112, and 117 and 121 also need 113 |
| 4 | PBI-123 final pass | No, needs all the others |

### PBI-111: Colour tokens, fonts and focus ring
**Priority:** v1 · **Size:** S · **Depends on:** design approved · **Files:** `src/renderer/src/main.css`, `src/renderer/index.html` (font links), `src/server` CSP only if fonts are blocked

**Story:** As a developer of the studio, I want the design's colours and fonts as tokens, so that every screen picks up the new look without its own styling.

**Acceptance criteria**
- The existing variables in `main.css` (`--bg`, `--panel`, `--raised`, `--hover`, `--line`, `--fg`, `--muted`, `--faint`, `--accent*`, `--ok/warn/danger*`, `--code`, `--json-*`) take the values from the Foundations board, for both `:root` (light) and `[data-theme='dark']`. No variable is renamed, so existing components keep working.
- Dark: bg `#0B0C0E`, panel `#121316`, raised `#1A1B1F`, line `#23252A`, fg `#E8E9EB`, muted `#A6A9B0`, faint `#8A8E97`, accent `#5E6AD2`. Light: bg `#FFFFFF`, panel `#F7F7F8`, raised `#EFEFF1`, line `#E4E4E7`, fg `#16171A`, muted `#52555C`, faint `#696D75`, accent `#5059C9`. Status colours as on the board.
- Inter (UI) and JetBrains Mono (data) are bundled with the app (npm `@fontsource` packages or local woff2), not loaded from Google at runtime, so the desktop app works offline. A `--font-mono` variable is used for subjects, sequences and payloads.
- Tabular figures (`font-variant-numeric: tabular-nums`) are on by default for table cells.
- One global focus style: a 2 px accent outline, 1 px offset, on every focusable element (`:focus-visible`).
- Every text/background pair is checked: text at least 4.5:1 in both themes. Record the ratios in the PR. Any pair that fails is adjusted and the board's value is noted as changed.

### PBI-112: Shared controls (buttons, inputs, badges, segmented tabs)
**Priority:** v1 · **Size:** S · **Depends on:** PBI-111 · **Files:** `src/renderer/src/components/ui.tsx`, `src/renderer/src/components/inputs.tsx`

**Story:** As a user, I want buttons, fields and status badges to look and behave the same everywhere, matching the design.

**Acceptance criteria**
- Buttons: primary (accent fill), secondary (raised fill, 1 px border), ghost, danger (tinted), and icon-only (square, `aria-label` required by the type). Heights 32 px (primary and secondary) and 28 px (compact). Radius 6 px.
- Inputs and selects: 32 px (28 px compact), 1 px border, mono font when the field takes a subject or JSONPath.
- `Badge` gains status variants (ok, warn, danger, info, neutral). Each shows an icon and a word; colour is never the only signal.
- `SubTabs` renders as the segmented control from the Foundations board.
- `Dialog`, `Menu`, `Card` use borders instead of shadows (a soft shadow only on floating menus and dialogs).
- Existing props stay compatible; no feature file needs changes for this item.

### PBI-113: Dense data table
**Priority:** v1 · **Size:** S · **Depends on:** PBI-111 · **Files:** `src/renderer/src/components/DataTable.tsx`

**Story:** As a user scanning many streams or messages, I want compact rows, a sticky header and columns that never disappear off the edge.

**Acceptance criteria**
- Header: 32 px, sticky, uppercase 11 px labels in the faint colour. Rows: 36 px default, 32 px compact.
- Selected row: accent tint plus a 2 px accent left edge. Hover: the hover colour.
- When the columns do not fit, the table scrolls sideways inside its own box; no column is cut off or hidden (fixes "Last message" on Streams and "Waiting pulls" on Consumers at 1440 px).
- Numeric columns are right-aligned with tabular figures.
- Keyboard row navigation and virtualisation still work (existing tests pass).

### PBI-114: Top bar
**Priority:** v1 · **Size:** S · **Depends on:** PBI-112 · **Files:** `src/renderer/src/features/shell/TopBar.tsx`

**Story:** As a user, I want a slim top bar that shows where I am and whether I am connected.

**Acceptance criteria**
- 44 px bar as on the Streams board: app mark, breadcrumb (connection colour dot, connection name, current stream when there is one), Read-only badge when the connection is read-only.
- Search button opens the command palette and shows the `Ctrl K` / `⌘K` hint.
- Connection state on the right with icon and text (Connected · RTT, Reconnecting, Disconnected).
- Wraps rather than overflows at narrow widths.

### PBI-115: Sidebar with collapsible icon rail
**Priority:** v1 · **Size:** M · **Depends on:** PBI-112 · **Files:** `src/renderer/src/features/shell/Sidebar.tsx`, `src/renderer/src/features/shell/nav.tsx`

**Story:** As a user, I want the connections tree to get out of the way when I need room, for example while reading a message.

**Acceptance criteria**
- Expanded: 240 px, sections as on the Streams board (connection rows with colour dot, section links indented with icons and counts, "Add connection" at the bottom).
- Collapsed: a 48 px icon rail as on the Message browser board; each icon has an `aria-label` and a tooltip.
- A button and a shortcut toggle it; the state is saved per window (setting) and restored at start.
- The message browser may request the collapsed state while a detail panel is open (an API on the shell store, used by PBI-117).

### PBI-116: Tab bar with overflow menu
**Priority:** v1 · **Size:** S · **Depends on:** PBI-112 · **Files:** `src/renderer/src/features/shell/TabBar.tsx`

**Story:** As a user with many tabs open, I want to reach every tab, not have the last ones clipped.

**Acceptance criteria**
- 36 px tabs as on the Streams board; the active tab has a 2 px accent underline.
- Tabs that do not fit go into a "+N" menu at the right edge listing every hidden tab; choosing one activates it and scrolls it into view.
- Middle-click and the close button still close tabs; existing keyboard shortcuts still work.

### PBI-117: Message browser layout and detail panel
**Priority:** v1 · **Size:** M · **Depends on:** PBI-112, PBI-113, PBI-115 (rail API; can stub it) · **Files:** `src/renderer/src/features/messages/MessageBrowser.tsx`, `src/renderer/src/features/messages/FilterPanel.tsx`, `src/renderer/src/components/MessageDetail.tsx`

**Story:** As a user reading a message, I want the payload to have room, so that JSON is not cut off.

**Acceptance criteria**
- Layout as on the Message browser board: filter row with removable filter chips, table of seq / subject / payload preview / time, and a detail panel on the right.
- The detail panel is at least 440 px wide and can be resized by dragging its edge (width saved as a setting). Opening it collapses the sidebar to the rail; closing it restores the previous state.
- Header facts (received, size, headers) in a two-column grid; the payload wraps and scrolls inside its box, never cut off.
- At 1280 x 720 the table still shows seq, subject and a payload preview with the panel open.

### PBI-118: Payload and JSON colours
**Priority:** v1 · **Size:** S · **Depends on:** PBI-111 · **Files:** `src/renderer/src/components/JsonView.tsx`, `src/renderer/src/components/PayloadViewer.tsx`

**Story:** As a user, I want payloads to be easy to read in both themes.

**Acceptance criteria**
- JSON keys, strings, numbers and literals use the `--json-*` tokens as on the Message browser board (keys indigo, strings amber, numbers green in dark), each at least 4.5:1 on `--code`.
- Mono font, 12 px, line height 1.65; long lines wrap (`pre-wrap`, break long words) unless the user turns wrapping off.
- The JSON / Text / Hex / Base64 switch uses the segmented control from PBI-112 when it is merged (otherwise keep the current control and leave a note).

### PBI-119: Publish page layout
**Priority:** v1 · **Size:** S · **Depends on:** PBI-112 · **Files:** `src/renderer/src/features/publish/PublishTab.tsx`

**Story:** As a user sending a request, I want to see the whole reply.

**Acceptance criteria**
- The reply panel is never cut off at the bottom of the window: the page scrolls, or the editor and reply share the height and each scrolls inside its box.
- The page uses the new controls and the page header from the design (title, subtitle, actions on the right).
- Checked at 1280 x 720 and 1440 x 900 with a reply of at least 60 lines.

### PBI-120: Object store detail shows "Revision undefined"
**Priority:** v1 · **Size:** S · **Depends on:** none · **Files:** `src/renderer/src/features/objects/ObjBucketTab.tsx` (and the conversion in `src/core` only if the value is lost there)

**Story:** As a user looking at an object, I want correct metadata, not "undefined".

**Acceptance criteria**
- Find why `info.revision` is undefined (the field name in `@nats-io/obj` `ObjectInfo` is likely different, for example the sequence) and show the right value, or hide the row when the server does not give one.
- A UI or gateway test covers it.

### PBI-121: List pages: header, filter and summary cards
**Priority:** v1 · **Size:** M · **Depends on:** PBI-112, PBI-113 · **Files:** `src/renderer/src/features/streams/StreamsTab.tsx`, `src/renderer/src/features/consumers/ConsumersTab.tsx`, `src/renderer/src/features/consumers/ConsumersPanel.tsx`, `src/renderer/src/components/ui.tsx` (`Page` only)

**Story:** As a user, I want list pages to show what matters at a glance.

**Acceptance criteria**
- `Page` header as on the boards: 20 px title, one-line subtitle with counts (for example "6 streams · 1.82 GB of 10 GB file storage"), filter input and actions on the right.
- Consumers page: three summary cards (total pending, ack pending, needs attention) as on the Consumers board; the "needs attention" card uses the warn colours only when something needs attention.
- Health column shows the status badges from PBI-112 (Healthy, Lagging, Paused, Inactive).
- Create buttons are shown disabled with a tooltip on read-only connections, not hidden.

### PBI-122: Chart colours
**Priority:** v1 · **Size:** S · **Depends on:** PBI-111 · **Files:** `src/renderer/src/components/LineChart.tsx`, `src/renderer/src/components/MetricsPanel.tsx`, `src/renderer/src/main.css` (`--series-*`, `--chart-*` only)

**Story:** As a user watching rates and lag, I want charts that match the new look and stay readable for colour-blind users.

**Acceptance criteria**
- Series, grid and axis colours come from tokens; the series palette passes the dataviz palette validator in both themes (record its output in the PR).
- Lines 2 px, recessive grid, tooltips keep working.

### PBI-123: Redesign final pass
**Priority:** v1 · **Size:** S · **Depends on:** PBI-111 to PBI-122 · **Files:** any, small fixes only

**Story:** As the product owner, I want to check the whole app against the design before calling PBI-110 done.

**Acceptance criteria**
- Every screen (overview, streams, stream detail, consumers, consumer detail, messages, live tail, subjects, publish, KV, object store, monitoring, audit, decoders, connection form, command palette, dialogs) is checked in dark and light at 1280 x 720 and 1440 x 900; leftover old colours or spacing are fixed.
- Keyboard-only walk-through: focus is visible everywhere and nothing is reachable only by mouse.
- Full screenshot set retaken and attached to the PR; `docs/status.md` marks PBI-110 to PBI-123 done.
