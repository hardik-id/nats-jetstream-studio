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
| 4. Message browser | 040 to 049 | 5 | 5 | |
| 5. Consumers | 050 to 054 | 3 | 2 | |
| 6. Subjects explorer and live tail | 060 to 062 | 2 | 1 | |
| 7. KV and Object Store | 070 to 071 | | 2 | |
| 8. Monitoring and metrics | 080 to 081 | | 1 | 1 |
| 9. Productivity and UX | 090 to 093 | | 4 | |
| 10. Packaging and distribution | 100 to 101 | | 1 | 1 |
| 11. Visual design | 110 to 123 | | 14 | |
| 12. Website | 130 to 137 | | 8 | |
| **Total (69)** | | **27** | **40** | **2** |

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

### PBI-049: Which consumers have received a message
**Priority:** v1 · **Size:** M · **Depends on:** PBI-043, PBI-050

**Story:** As someone debugging a pipeline, I want to see for one message which consumers have
received and finished with it and which have not, so that I can tell where it is stuck.

**How it is worked out:** NATS keeps no per-message receipt. The studio compares the message's
sequence, subject and time with each consumer's info (filter subjects, deliver policy and its start
options, ack policy, `created`, `delivered.stream_seq`, `ack_floor.stream_seq`), which it already
reads for PBI-050. It never creates a consumer or changes any state to answer.

**Where the consumer starts.** A new consumer sets its delivered sequence and ack floor to the
sequence before its start, so messages before the start look "at or below the ack floor" without
ever being delivered. The start is therefore decided first, per deliver policy:

| Deliver policy | Messages before the consumer's start |
| --- | --- |
| `all` | none: it starts at the stream's first message |
| `by_start_sequence` | sequence below `opt_start_seq` |
| `by_start_time` | stored before `opt_start_time` |
| `new` | stored before the consumer's `created` time |
| `last` | stored before `created`, except the stream's last message at that time, which cannot be identified afterwards |
| `last_per_subject` | stored before `created`, except the last message per subject at that time, which cannot be identified afterwards |

**Acceptance criteria**
- The message detail panel has a "Consumers" section listing every consumer of the stream, with one
  state each, checked in this order:
  1. **Not for this consumer:** its filter subjects do not match the message subject.
  2. **Before the consumer started:** the message is before the start (table above). For `last` and
     `last_per_subject` it says "probably not delivered: only the last message (per subject) at
     creation was", because which one that was is not recorded.
  3. **Done:** sequence at or below the ack floor. The tooltip says this means acknowledged,
     terminated or out of delivery attempts, because NATS does not tell them apart. For ack policy
     `none` it reads "Delivered, no ack needed" and uses the last delivered sequence.
  4. **Delivered, waiting for ack:** above the ack floor and at or below the last delivered
     sequence. When `num_ack_pending` is 0 nothing is outstanding, so the state is shown as **Done**.
     For ack policy `explicit` it adds "may already be done out of order", because NATS does not
     expose individual acks above the floor (with `all`, acks are cumulative and the floor is exact).
  5. **Not delivered yet:** above the last delivered sequence.
- Each state shows an icon and a word, never colour alone, and a tooltip explains the rule used.
- Each row links to the consumer detail (PBI-051). A paused consumer (PBI-053) is marked.
- On a work-queue stream the section notes that a message is removed once its consumer acknowledges
  it (or, with ack policy `none`, once it is delivered), so a visible message has not been finished.
  On an interest stream it notes that the message is removed once every interested consumer has
  finished with it.
- The states refresh with the consumer list and with a Refresh button, and say when they were read.
- Works in read-only mode (it only reads). Unit tests cover the state rules, including filters with
  wildcards and every deliver and ack policy in the table; a gateway test checks them against a real
  server with consumers created with `all`, `new` and `by_start_sequence`, one of which acks some
  messages and leaves others pending.

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

### PBI-124: Resizable table columns
**Priority:** v1 · **Size:** S · **Depends on:** PBI-113 · **Files:** `src/renderer/src/components/DataTable.tsx`, tests

**Story:** As a user, I want to change the width of a table column, so that I can read long names and subjects without truncation and hide what I do not need.

**Acceptance criteria**
- Every column header has a thin drag handle on its right edge, visible on header hover and on keyboard focus (pointer events with pointer capture; mouse and touch; `touch-action: none`; col-resize cursor). Dragging sets the width in px; it never drops below the header's floor and never exceeds 1200 px. Header and rows keep sharing one grid template, and text is not selected while dragging.
- A column with a user width has a fixed px track; the others keep their default. When the columns exceed the viewport the table scrolls sideways.
- Double-click on the handle resets that column. The handle is focusable (`role="separator"`, `aria-orientation`, `aria-label`, `aria-valuenow/min/max`); the arrow keys resize by 10 px (Shift: 50 px), Home resets. The handle does not sort, select a row or scroll.
- Widths are stored per table (key `table.widths:<ariaLabel>` or the optional `storageKey` prop) in the app settings, so they survive restarts in the desktop app and in web mode. They are written only when a drag ends and never from the unloaded fallback; stored values are validated (unknown columns ignored, clamped to floor and maximum).
- Sticky header, virtualization, ellipsis, right alignment, `stickToBottom` and keyboard row navigation keep working.

### PBI-125: Message browser: clearer filters, shapeable detail panel, readable JSON
**Priority:** v1 · **Size:** M · **Depends on:** PBI-117, PBI-118, PBI-124 · **Files:** `src/renderer/src/features/messages/`, `src/renderer/src/components/MessageDetail.tsx`, `PayloadViewer.tsx`, `JsonView.tsx`, `ui.tsx`, tests

**Story:** As a user reading messages, I want filters that look expandable, a detail panel I can shrink, collapse or widen, and JSON I can read comfortably, so that big payloads do not fight with the rest of the panel.

**Acceptance criteria**
- Filters: the button has a chevron that flips with its state, a pressed look when open, `aria-expanded` and `aria-controls`, and a count badge when content filters are active ("Filters · 2"). Active filter chips stay visible when the panel is closed and can be removed there. The panel is compact (two columns, tight spacing, a maximum height with its own scroll) with Apply, Clear and Hide in a footer that stays visible. Open or closed is remembered per stream. Esc inside the panel closes it and returns focus to the button. All existing behaviour and validation is kept.
- Detail panel: Details, Headers, Consumers and Payload are collapsible sections (a reusable `CollapsibleSection` with a chevron header button, `aria-expanded` and a closed-state summary such as "Headers (3)"); their state is remembered for the whole panel. The payload gets all remaining height. A "Collapse panel" button shrinks the panel to a thin rail (about 36 px) that keeps the selection and has an expand button; it is distinct from the X that closes and deselects, and it is remembered. An "Expand to read" toggle widens the panel to about 70% of the container by resizing the split (the table shrinks, nothing overlays it) and back; Esc or the same button restores it. The drag handle, the minimum width and the saved width keep working, and the expanded state never overwrites the saved width.
- JSON: the default text is 13 px with A- and A+ buttons (3 steps, remembered) that also apply to the Text, Hex and Base64 views. Expand all, Collapse all and a levels control (1, 2, 3, all) replace the fixed depth. A search box with next and previous and a match count highlights matches and expands the tree to show them (Ctrl or Cmd+F in the payload focuses it, Esc clears it); the work is capped so 1 MB payloads stay responsive. "Copy path" (for example `$.order.items[0]`) and "Copy value" are available on a hovered or focused row and by keyboard. The wrap toggle, the truncation notice and the decoders keep working.
- Everything is keyboard accessible with accessible names, icons come with text or a label (never colour alone), contrast is fine in both themes, and the panel works at 1000 px window width. The DataTable column resize (PBI-124) and the Live tail keep working.

### PBI-126: Filter from a message, and multiple include/exclude conditions
**Priority:** v1 · **Size:** M · **Depends on:** PBI-125 · **Files:** `src/shared/filters.ts`, `src/shared/api.ts`, `src/renderer/src/features/messages/`, `src/renderer/src/components/JsonView.tsx`, `MessageDetail.tsx`, `PayloadViewer.tsx`, tests, site docs

**Story:** As a user reading a message, I want to click a value or a header and add it to the filter as "only this" or "not this", and to combine several such conditions, so that I can narrow a stream down while reading it without typing JSONPath.

**Acceptance criteria**
- Model: `ContentFilters` gets a list of conditions `{ kind: 'jsonPath' | 'contains' | 'regex' | 'header', expr (or key and value), exclude? }`. All conditions AND together; an exclude condition rejects the messages it matches (an exclude JSONPath on a payload that is not JSON does not reject it). The single fields of before (`jsonPath`, `payloadContains`, `payloadRegex`, `headers`) are still read, in one shared place, so stored and exported saved filters keep working; validation reports errors per condition; the scan stays read-only.
- JSON tree: every string, number, boolean and null row gets "Filter" (adds `<path> == <literal>`) and "Exclude", beside Copy path and Copy value, visible on hover and keyboard focus, with names such as "Filter to event_type equals x". A value directly in an array uses `<array path> contains <literal>`; array steps further up are written `[*]` (`$.items[*].sku == "A"`), so a nested value means "any item". Literals are quoted so every generated expression parses and matches its message. Only in the Message browser, not in Live tail.
- Headers: each header row has Include and Exclude.
- Applying: a click adds the condition to the applied filters (the same condition is never added twice; the opposite one flips the existing condition) and reruns the scan from the current start position. One chip per condition, excluded ones marked "not" (text, not only colour), each with a flip and a remove button; the Filters badge counts conditions. Focus stays on the pressed button while the message is still in the result, otherwise it moves to the new chip.
- Filters panel: a list of conditions (type, expression, Include/Exclude, remove), "Add condition", errors per row, the scan limit, and the Apply, Clear and Hide footer of PBI-125 unchanged and compact.
- Saved filters store and restore conditions; export writes the new shape and import still reads old files.
- Also: an open Consumers section shows its list (at least four rows at 1440 x 900), and Expand all and Collapse all are icon-only buttons (unfold and fold icons, with a title and an accessible name), as tall as the level buttons and on the same row.

### PBI-127: Subjects screen: treegrid, detail pane and labelled actions
**Priority:** v1 · **Size:** L · **Depends on:** PBI-061, PBI-125 · **Files:** `src/renderer/src/features/subjects/`, `src/renderer/src/state/subjectsUi.ts`, `src/renderer/src/state/seenSubjects.ts`, tests

**Story:** As a user exploring subjects, I want to expand the whole hierarchy at once, see what each action does and on which wildcard, and compare counts at a glance, so that I can find a subject and browse, tail or publish on it without hunting for hover icons. This extends PBI-061.

**Delivered in three slices.** A: the pure tree model and its unit tests (`subjectTree.ts`, no UI). B: the screen (treegrid, toolbar, virtualisation, persistence; merges last). C: the detail pane, labelled actions and live metadata (`seenSubjects` gets a timestamp). KV and Object Store streams stay excluded, and only subjects seen in live tails count as core subjects.

**Acceptance criteria**
- Layout: a virtualised `role="treegrid"` on the left (columns Subject, Messages, Live, Streams; counts right aligned; the stream badge is shown only where the owners differ from the parent's) and a detail pane on the right that follows the PBI-125 pattern (resizable, collapses to a rail, width and state remembered, collapsed under 1000 px).
- Toolbar: search (substring on the full path, or a subject pattern with `*` or `>`) that keeps ancestors, highlights, shows a match count and does not change the expanded set; Expand all and Collapse all with text; Levels 1, 2, 3, All; sort by Messages, Name or Live; "Only with messages"; source filter All, Streams or Live. Expand all opens branches breadth first up to 5,000 rows, never closes any, and says "Opened N of M branches" when capped.
- Actions in the detail pane, with text: Browse stored messages, Start live tail, Publish message, Copy subject, Copy filter, and the same in a visible row menu; the hover-only icons are removed. A scope control "This subject", "Everything below" (`.>`, default for a branch) and "One level below" (`.*`) shows the exact filter that Browse and Live tail receive; a node with its own messages and children can browse its own subject. Browse says why it is disabled when no stream stores the subject and offers a stream choice when several do. Publish uses the exact subject, is disabled for a wildcard scope and in read-only mode, and adds no new mutating gateway method.
- Keyboard and accessibility: one tab stop with roving focus; Up, Down, Home, End, Left, Right, `*`, Enter, Space, type-ahead; `aria-level`, `aria-expanded`, `aria-selected`, `aria-posinset`, `aria-setsize`, `aria-rowindex` and `aria-rowcount`; colour is never the only signal.
- Data: loading shows rows as each stream answers, a failed stream keeps the others, live-only subjects are labelled "live"; 10,000 subjects stay responsive and the DOM holds under 100 rows. Expanded paths, selection, sort, filters and pane state are remembered per connection; the top level is open on the first visit.
- Not in this work: deleting a branch, payload preview per subject, rate and last-seen columns, discovery of core subjects nobody tailed.

## Epic 12: Website

A public website on GitHub Pages, so that people can see what the studio does, download it and read
the user documentation without opening the repository. Address:
`https://hardik-id.github.io/nats-jetstream-studio/` (a custom domain can be added later without
changing the pages).

### Site plan (applies to PBI-130 to PBI-137)

**Technology:** [Astro](https://astro.build) as a static site in a `site/` folder with its own
`package.json`, so the app's dependencies and build are untouched. Pages are `.astro` and Markdown
files; no client framework. Deployed by a GitHub Actions workflow with `actions/deploy-pages`. The
look reuses the app's tokens from PBI-111 (Inter, JetBrains Mono, the indigo accent, dark-first with
a light theme).

**Site map**

| Path | Page | What people see |
| --- | --- | --- |
| `/` | Home | What it is in one sentence, the demo GIF, a download button for their system, six feature highlights, "safe on production" (read-only mode, audit log, no consumer created when reading), desktop or web, link to GitHub |
| `/features/` | Features | A card per feature area with a screenshot, linking to the pages below |
| `/features/connections/` | Connections | Several servers, environments and colours, `nats` CLI contexts, every auth type, read-only mode |
| `/features/message-browser/` | Message browser | Paging without a consumer, start positions, filters (subject, header, text, regex, JSONPath), payload views, Protobuf, export, republish |
| `/features/streams/` | Streams | List, detail, create and edit, purge, per-subject counts, config export and import |
| `/features/consumers/` | Consumers | Lag, ack pending, redeliveries, health flags, pause and resume |
| `/features/live-tail-and-publish/` | Live tail and publish | Tail any subject, publish, request/reply, templates, subject tree |
| `/features/kv-and-object-store/` | KV and Object Store | Browse, history, watch, upload and download |
| `/features/monitoring-and-alerts/` | Monitoring and alerts | Charts, alert rules, desktop notifications, cluster topology |
| `/features/productivity/` | Productivity | Command palette, favourites, saved filters, keyboard navigation, audit log, tabs restored |
| `/download/` | Download | Buttons for Windows, macOS and Linux for the latest release, the first-run warning steps, checksums, "run in a browser instead" |
| `/docs/` | Documentation | Index of the pages below |
| `/docs/getting-started/` | Getting started | Install, add the first connection, open a stream, read a message |
| `/docs/install/` | Install | From `docs/install.md` |
| `/docs/connections/` | Connecting | Auth types, TLS, JetStream domain, CLI contexts, read-only mode |
| `/docs/web-mode/` | Web mode | From `docs/web-mode.md`: Docker, sign-in, provisioning |
| `/docs/keyboard-shortcuts/` | Keyboard shortcuts | The shortcut table |
| `/docs/security/` | Security and privacy | Where secrets are stored, what leaves the machine (nothing), the audit log, unsigned builds |
| `/docs/faq/` | FAQ and troubleshooting | Connection errors, SmartScreen and Gatekeeper, "why not a browser-only app" |
| `/changelog/` | Changelog | One entry per GitHub release |
| `/404` | Not found | Links to Home, Features and Docs |

Contributor material (architecture, backlog, status, contributing) stays in the repository; the site
footer links to it.

**Navigation**

- Header: logo and name (to Home), Features, Download, Docs, Changelog, a GitHub link, theme switch.
  On narrow screens the links move into a menu button.
- Breadcrumbs on every page except Home, under the header: `Home / Features / Message browser`,
  `Home / Docs / Web mode`. The last item is the current page and is not a link. They are generated
  from the path and a title map, and are also published as `BreadcrumbList` structured data.
- Feature and docs pages end with "Previous" and "Next" links in site-map order. Docs pages have a
  sidebar listing the docs pages and an "On this page" list for long pages.
- Footer: Product (Features, Download, Changelog), Docs, Project (GitHub, Issues, Contributing,
  License), and the version of the latest release.

**For agents:** branch from `main` as `site/pbi-13N-short-name`; touch only `site/`, the workflow
and the files the item lists; run `npm run build` and `npm run check` in `site/`; attach
screenshots of each new page (dark and light, 1280 px and 390 px wide); do not merge.

| Wave | Items | Can run in parallel? |
| --- | --- | --- |
| 1 | PBI-130 scaffold and deploy, PBI-136 media | Yes, separate folders |
| 2 | PBI-131 home, PBI-132 features, PBI-133 download, PBI-134 docs, PBI-135 changelog | Yes, separate pages; all need 130, and 131 and 132 need 136 |
| 3 | PBI-137 search-engine, accessibility and speed pass | No, needs all the others |

### PBI-130: Site scaffold, layout and deployment
**Priority:** v1 · **Size:** M · **Depends on:** PBI-111 (tokens) · **Files:** `site/**`, `.github/workflows/pages.yml`, `.gitignore`

**Story:** As a visitor, I want a fast site with the same look as the app and clear navigation, so that I can find my way from any page.

**Acceptance criteria**
- An Astro project in `site/` builds to static files with `npm run build`; `npm run check` type-checks it. The app's root `package.json`, lint and tests are not affected.
- The base path is `/nats-jetstream-studio/` and comes from one setting, so a custom domain later needs one change. Every internal link and asset uses it.
- A shared layout provides the header, breadcrumbs, footer, a skip link and the theme switch (follows the system setting, remembers a manual choice). Colours and fonts come from the PBI-111 tokens; fonts are served from the site, not from a third party.
- Breadcrumbs behave as described in the site plan and are hidden on Home.
- A `404` page exists, and every page in the site map exists as a stub with its title, so later items only fill in content.
- `.github/workflows/pages.yml` builds and deploys on pushes to `main` that change `site/**` or the docs it reads, and on manual runs. Pull requests build the site but do not deploy. GitHub Pages is switched to "GitHub Actions" as its source (a repository setting: needs the owner's go-ahead).
- The repository homepage URL points to the site once it is live.

### PBI-131: Home page
**Priority:** v1 · **Size:** S · **Depends on:** PBI-130, PBI-136 · **Files:** `site/src/pages/index.astro`, `site/src/components/home/**`

**Story:** As someone who has just heard of the studio, I want to understand in a few seconds what it is and whether it is for me.

**Acceptance criteria**
- Above the fold at 1280 x 720: the name, one sentence ("A free GUI and desktop client for NATS and JetStream"), a primary download button that names the visitor's system (falls back to "Download"), a secondary "See features" link and the demo recording.
- The recording does not autoplay for people who prefer reduced motion; a still image is shown instead.
- Six highlights, each with an icon, a title, one sentence and a link to its feature page: message browser, consumers health, live tail and publish, several connections, KV and Object Store, monitoring.
- A "Safe on production" section: read-only mode, the audit log, reading without creating a consumer.
- A "Desktop or web" section linking to Download and to the web-mode docs.
- A closing call to action: download, and star or open the project on GitHub. One primary button per screen height.

### PBI-132: Features pages
**Priority:** v1 · **Size:** M · **Depends on:** PBI-130, PBI-136 · **Files:** `site/src/pages/features/**`, `site/src/components/features/**`

**Story:** As someone comparing tools, I want to see each capability with a real screenshot, so that I know what I get before installing.

**Acceptance criteria**
- `/features/` shows one card per feature area (the eight in the site map) with a screenshot, a title and one sentence.
- Each feature page has: a heading, one paragraph on the problem it solves, three to six capabilities as short sections, with one screenshot per page and a screenshot or recording per capability where one exists, and a link to the matching docs page where one exists.
- Every claim matches an implemented backlog item (`docs/status.md`); nothing unverified (signed installers, auto-update on macOS) is promised.
- Screenshots have alt text that says what is shown, open larger on click, and switch with the site theme (dark and light versions from PBI-136).
- "Previous" and "Next" links follow the site-map order.

### PBI-133: Download page
**Priority:** v1 · **Size:** S · **Depends on:** PBI-130 · **Files:** `site/src/pages/download.astro`, `site/src/lib/releases.ts`

**Story:** As a visitor who wants to try the studio, I want the right installer for my system and to know about the first-run warning before I see it.

**Acceptance criteria**
- The version, date and file links of the latest release are read from the GitHub releases API when the site is built, so the page needs no script to show them. If the API call fails, the build falls back to a link to the releases page instead of failing.
- Three cards: Windows (`.exe`), macOS (`.dmg`, universal), Linux (`.AppImage` and `.deb`), with file sizes. The visitor's system is highlighted.
- The first-run steps for SmartScreen and Gatekeeper are on the page, next to the matching card, with the links to issues #17 and #18.
- A "Run it in a browser" box links to the web-mode docs, and a "Build from source" line links to `CONTRIBUTING.md`.
- The release workflow triggers a site deployment after a release is published, so the page shows the new version without a manual step.

### PBI-134: Documentation pages
**Priority:** v1 · **Size:** M · **Depends on:** PBI-130 · **Files:** `site/src/pages/docs/**`, `site/src/content/docs/**`, `docs/install.md`, `docs/web-mode.md` (only if wording must change to be shared)

**Story:** As a user, I want the how-to pages on the website, so that I do not have to read them on GitHub.

**Acceptance criteria**
- The seven docs pages in the site map exist. Install and Web mode are built from the existing files in `docs/` (one source, no copies); the others are new.
- Getting started takes a new user from install to reading a message, with screenshots, and offers the demo data route (`npm run nats`, `npm run traffic`) for people without a server.
- Connecting covers every auth type the connection form offers, TLS options, JetStream domain and API prefix, CLI contexts and read-only mode.
- Keyboard shortcuts lists every shortcut the app has, checked against the code.
- Security and privacy states where secrets are stored on each system and in web mode, that the app sends no telemetry, and what the audit log records.
- Docs pages have the sidebar, the "On this page" list, "Previous" and "Next" links and an "Edit this page on GitHub" link.

### PBI-135: Changelog page
**Priority:** v1 · **Size:** S · **Depends on:** PBI-130 · **Files:** `site/src/pages/changelog.astro`, `site/src/lib/releases.ts`

**Story:** As a user, I want to see what changed in each version.

**Acceptance criteria**
- One entry per published GitHub release, newest first: version, date, the release notes rendered from Markdown and a link to its downloads. Drafts and pre-releases are left out.
- Read at build time with the same helper as the Download page, with the same fallback.
- An RSS feed of the entries is published and linked from the page head.

### PBI-136: Screenshots and recordings
**Priority:** v1 · **Size:** S · **Depends on:** nothing · **Files:** `scripts/site-media.mjs`, `site/public/media/**`, `package.json` (one script)

**Story:** As the maintainer, I want the site's pictures made by a script, so that they can be retaken after every UI change.

**Acceptance criteria**
- `npm run site:media` starts a local `nats-server` with the demo data and traffic, starts web mode, and uses Playwright to save every picture the site needs, in dark and light, at a fixed size. It stops only the processes it started.
- It produces: the home recording (WebM or MP4 with a GIF fallback under 4 MB), a still of it, one screenshot per feature card and the screenshots the feature and docs pages name.
- Pictures are stored as WebP or AVIF with width and height known, so pages do not shift while loading. File names are stable, so retaking them needs no page change.
- The README's `docs/images/demo.gif` and `docs/images/social-preview.png` are made by the same script.

### PBI-137: Search engines, accessibility and speed
**Priority:** v1 · **Size:** S · **Depends on:** PBI-130 to PBI-136 · **Files:** `site/**`, `.github/workflows/pages.yml`

**Story:** As the product owner, I want the site to be found, to be usable by everyone and to load fast, before it is announced.

**Acceptance criteria**
- Every page has its own title and description, a canonical address, and Open Graph and Twitter card tags using the social preview image.
- `sitemap.xml` and `robots.txt` are generated. Home carries `SoftwareApplication` structured data (name, systems, price 0, license, download address); every other page carries `BreadcrumbList`.
- Lighthouse on Home, Features, one feature page, Download and one docs page scores at least 95 for performance, accessibility, best practices and SEO, on mobile settings. The workflow fails a pull request that drops below.
- Keyboard-only walk-through of every page; text contrast at least 4.5:1 in both themes; one `h1` per page and headings in order; all pictures have alt text.
- The site loads no third-party scripts, fonts or trackers. If visit counts are wanted later, that is a separate decision.
- A link checker runs in the workflow and fails on broken internal links.
- The README links to the site, and `docs/status.md` marks PBI-130 to PBI-137 done.
