// Text for the feature pages. Every claim here matches an implemented item in docs/status.md.
// Screenshot names are file stems in site/public/media; alt text comes from manifest.json.

export interface Shot {
  /** File stem in site/public/media; size and alt text come from manifest.json. */
  name: string
}
export interface Capability {
  title: string
  text: string
  extra?: Shot
  /** A short honest hedge, shown as a small note under the text. */
  note?: string
}
export interface FeatureContent {
  /** One sentence for the /features/ card. */
  card: string
  /** The problem this area solves. */
  problem: string
  shot: Shot
  capabilities: Capability[]
  docs: { path: string; label: string }[]
}

export const featureContent = {
  connections: {
    card: 'Keep many servers open at once, each with its own colour and environment label.',
    problem:
      'Most teams run several NATS servers: dev, test, prod, and a few more. You need to reach all of them, tell them apart at a glance, and not break production by accident.',
    shot: {
      name: 'features-connections'
    },
    capabilities: [
      {
        title: 'Several servers at once',
        text: 'Open at least five connections side by side. Each has its own tree in the sidebar, a colour and an environment label such as dev, test or prod. Every tab shows the label and colour of its connection. Connecting or disconnecting one does not touch the others. Dropped connections reconnect on their own, and the status shows in the sidebar.'
      },
      {
        title: 'Every auth type',
        text: 'No auth, user and password, token, NKey seed, and credentials files (JWT and NKey). TLS works with a CA file, a client certificate and key, or a TLS-first handshake. You can also set the JetStream domain, API prefix and inbox prefix.',
        extra: {
          name: 'docs-connection-form'
        }
      },
      {
        title: 'Use your NATS CLI contexts',
        text: 'The studio reads the contexts you already made with the nats CLI and lists them as connections, marked "from NATS CLI". It never writes to the CLI files. A broken context file is skipped with a warning and the rest still load.'
      },
      {
        title: 'Test before you save',
        text: 'The Test button needs no saving. It shows the server name, version, cluster name, round-trip time and whether JetStream is available to your account. When it fails, it names the cause: authentication, TLS, timeout or name resolution.'
      },
      {
        title: 'Read-only mode',
        text: 'Switch any connection to read-only. It is on by default for connections labelled prod. Create, edit, delete, purge and publish actions are then refused, and the app itself rejects them, not just the buttons.'
      },
      {
        title: 'Secrets stay safe',
        text: 'In the desktop app, passwords, tokens and NKey seeds are encrypted with the operating system secure storage; in web mode, with a key file in the data directory. Credentials files are used by path and not copied. On the desktop, if no secure storage is available, the app warns you and can ask for the secret on each connect.',
        note: 'Not yet tested with the Windows and macOS secure storage. Only the no-keychain case was run, on Linux.'
      }
    ],
    docs: [
      { path: '/docs/connections/', label: 'Connecting: auth types, TLS and CLI contexts' },
      { path: '/docs/security/', label: 'Security and privacy' }
    ]
  },
  'message-browser': {
    card: 'Read stream messages without a consumer, then filter and export them.',
    problem:
      'To see what is in a stream, the usual way is to create a consumer, which adds state on the server and, on work-queue and interest streams, can be refused or change which messages the stream keeps. The message browser reads messages directly, so nothing is acknowledged or removed.',
    shot: {
      name: 'features-message-browser'
    },
    capabilities: [
      {
        title: 'Read without a consumer',
        text: 'Messages are fetched by sequence, using direct get when the stream allows it. No consumer is created and nothing is acknowledged. Work-queue and interest streams are left untouched. Pages are 50 messages, newest or oldest first.'
      },
      {
        title: 'Start where you want',
        text: 'Begin at the first message, the last N, a sequence number, or a date and time. The time picker uses local time and shows the UTC value. "Jump to latest" is always one click away.'
      },
      {
        title: 'Filter by subject, header and payload',
        text: 'Use NATS wildcards for the subject, match headers by key or key and value, and search payload text. Add a regular expression or a JSONPath comparison such as $.order.total > 100. Filters combine and show as removable chips. A scan shows progress, can be cancelled and stops at a limit you set.'
      },
      {
        title: 'Message detail',
        text: 'See subject, sequence, time, size and headers. View the payload as JSON, text, hex or base64; the format is detected and you can switch. Big payloads load on demand. Copy any part, and step to the previous or next message from the keyboard.'
      },
      {
        title: 'Protobuf decoding',
        text: 'Register .proto files per connection and map a subject pattern to a message type. Matching payloads show as JSON. If decoding fails, you get the hex view and the error. Protobuf groups are not supported.'
      },
      {
        title: 'Export, copy and act',
        text: 'Export selected messages, or everything that matches a filter, as JSON or NDJSON. Copy a message as a nats pub command. Republish a message, with the payload and headers editable first, or delete a single message. Changes are blocked in read-only mode.'
      }
    ],
    docs: [{ path: '/docs/getting-started/', label: 'Getting started: read your first message' }]
  },
  streams: {
    card: 'List, create, edit, purge and export streams.',
    problem:
      'Stream settings are easy to get wrong on the command line, and a list of thousands of streams is hard to read. The studio shows every stream in a fast table and lets you change one with a form.',
    shot: {
      name: 'features-streams'
    },
    capabilities: [
      {
        title: 'A list that scales',
        text: 'See name, subjects, storage, retention, replicas, messages, bytes, consumer count and last message time. Search, sort every column and filter by storage or retention. The list was tested with 5,000 streams. Streams behind KV and Object Store buckets are hidden until you ask for them.'
      },
      {
        title: 'Stream detail',
        text: 'Tabs for Overview, Messages, Consumers, Subjects and Configuration. State shows sequences, byte size and deleted messages. The cluster view shows the leader and each replica, and mirrors and sources show their lag.',
        extra: {
          name: 'docs-first-stream'
        }
      },
      {
        title: 'Create and edit',
        text: 'A form covers subjects, storage, retention, replicas, limits, discard policy, duplicate window, compression and more. Switch to raw JSON at any time; the two stay in sync. Fields the server will not let you change are disabled, and server errors show with their code. Mirror, sources, placement and republish are edited in the JSON view.'
      },
      {
        title: 'Per-subject counts',
        text: 'The Subjects tab lists subjects with their message counts. Filter with a NATS wildcard, sort by count or name, and click a subject to open the message browser on it. It was tested with 120,000 subjects.'
      },
      {
        title: 'Purge and delete, with care',
        text: 'Purge everything, by subject, up to a sequence, or keep the last N. You type the stream name to confirm, and the dialog shows the connection and the message count. The result tells you how many messages were purged.'
      },
      {
        title: 'Export and import',
        text: 'Export a stream configuration as JSON that nats stream add --config accepts, with or without its consumers. Export several streams at once. Importing a file opens the create form already filled in.'
      }
    ],
    docs: []
  },
  consumers: {
    card: 'See lag, ack pending and redeliveries, and spot unhealthy consumers early.',
    problem:
      'A consumer that falls behind or keeps redelivering is easy to miss until it hurts. The studio puts lag, pending and redeliveries in one table and flags the ones that look unhealthy.',
    shot: {
      name: 'features-consumers'
    },
    capabilities: [
      {
        title: 'One list of every consumer',
        text: 'See name, durable or ephemeral, pull or push, filter subjects, ack policy, pending, ack pending, redelivered, waiting pulls and last activity. Search and sort. View one stream or all streams of a connection. It was tested with 1,000 consumers on one stream.'
      },
      {
        title: 'Lag and position',
        text: "The detail page shows the delivered position and the ack floor with their times, and lag as the number of unprocessed messages next to the stream's last sequence. A link opens the message browser at the next message the consumer has not received."
      },
      {
        title: 'Health flags',
        text: 'A consumer is flagged when its lag keeps growing, redeliveries pass a threshold, it has pending messages but no activity, ack pending is at its maximum, or it has no leader. Thresholds are set per connection. Filter the list to unhealthy consumers, and see the count on the Overview.'
      },
      {
        title: 'Pause and resume',
        text: 'Pause a consumer until a chosen time, or resume it early. The paused state and remaining time show in the list and the detail. This needs NATS Server 2.11 or newer; on older servers the action is disabled with an explanation.',
        note: 'The older-server message is implemented but was not tried on a server older than 2.11.'
      },
      {
        title: 'Create, edit and delete',
        text: 'A form covers durable or ephemeral, pull or push, filters, deliver policy, ack policy, ack wait, max deliver, backoff and more, with a raw JSON view that stays in sync. Deleting a consumer needs you to type its name. All of it is blocked in read-only mode.'
      }
    ],
    docs: []
  },
  'live-tail-and-publish': {
    card: 'Tail any subject, publish messages and send requests.',
    problem:
      'When you are debugging, you need to watch traffic as it happens and send a test message right away, without writing a script or leaving the app.',
    shot: {
      name: 'features-live-tail-and-publish'
    },
    capabilities: [
      {
        title: 'Live tail',
        text: 'Subscribe to a subject or wildcard and see time, subject, size and a payload preview as messages arrive. Pause, resume and clear, and watch the current rate. The buffer keeps 10,000 messages by default and shows how many were dropped. The view stayed responsive at 5,000 messages per second in testing.'
      },
      {
        title: 'Safe by default',
        text: 'Subscribing to > on a connection labelled prod asks for confirmation first. Run several tails in separate tabs. If the connection drops, the tail resumes after reconnect and marks where messages may have been missed. Click any message to open its detail.'
      },
      {
        title: 'Subject tree',
        text: 'See your subjects as a tree built token by token from stream subject counts and from subjects seen in tails. Each node shows its stored message count and the stream that captures it. Search the tree, and from a node browse stored messages, start a tail or publish. The tree shows the 5,000 busiest subjects per stream.'
      },
      {
        title: 'Publish',
        text: 'Set a subject, headers and a payload, with JSON validation. Send a core publish, or a JetStream publish that shows the acknowledgement: stream, sequence and whether it was a duplicate.'
      },
      {
        title: 'Request and reply',
        text: 'Send a request and see the reply payload, headers and round-trip time. The timeout is configurable, and "no responders" is reported as such. Save messages as templates per connection; the last 20 you sent are kept as history. Publishing is blocked in read-only mode.'
      }
    ],
    docs: []
  },
  'kv-and-object-store': {
    card: 'Browse, watch, upload and download Key-Value and Object Store data.',
    problem:
      'KV and Object Store data lives in streams with odd names, and the CLI shows one key or object at a time. The studio gives them their own screens.',
    shot: {
      name: 'features-kv-and-object-store'
    },
    capabilities: [
      {
        title: 'Browse KV buckets',
        text: 'Buckets are listed with value count, size, history depth, TTL, replicas and storage type. Search keys or filter by prefix. The list was tested with 100,000 keys.'
      },
      {
        title: 'Values and history',
        text: 'Open a value in the payload viewer with its revision and created time. View the revision history of a key.'
      },
      {
        title: 'Change keys and buckets',
        text: 'Put, delete and purge keys, and create or delete buckets. These are blocked in read-only mode.'
      },
      {
        title: 'Watch live',
        text: 'Turn on watch mode to see changes to a bucket as they happen.'
      },
      {
        title: 'Object Store',
        text: 'See buckets with size and object count, and objects with name, size, modified time, digest, chunk count and description. Preview text, JSON and image objects under 1 MB.'
      },
      {
        title: 'Upload and download',
        text: 'Download an object to a file with progress, upload files, and delete objects. Upload and delete are blocked in read-only mode.'
      }
    ],
    docs: []
  },
  'monitoring-and-alerts': {
    card: 'Live charts, alert rules and cluster topology.',
    problem:
      'You want to know a stream is growing or a consumer is stuck before users tell you. The studio charts the numbers while it is open and warns you when a rule trips.',
    shot: {
      name: 'features-monitoring-and-alerts'
    },
    capabilities: [
      {
        title: 'Server and account overview',
        text: 'See server name, version, cluster, max payload, TLS and JetStream domain. The account view shows storage and memory against their limits, stream and consumer counts, and API totals and errors. It refreshes every 5 seconds by default, and pauses while the tab is hidden.'
      },
      {
        title: 'Time-series charts',
        text: 'Streams chart message rate, total messages and bytes. Consumers chart pending, ack pending and redelivered. Pick 5 minutes, 15 minutes or 1 hour and hover for values. Samples are kept in memory while the app is open, so no database is needed.'
      },
      {
        title: 'Alert rules',
        text: 'Make rules per connection on consumer pending, redelivered, or stream bytes as a share of its limit, with a threshold and a duration. A triggered rule shows a badge and, if you turn it on, a desktop notification. Mute or snooze rules, and list the alerts that fired this session.',
        note: 'The desktop notification itself was never seen on screen; the alert rules and badges are tested.'
      },
      {
        title: 'Cluster topology',
        text: "With system-account access, list every server with version, connections, CPU, memory and JetStream use. See routes, gateways and leaf nodes, the JetStream meta leader, and each stream's leader and replica state. Without that access, the view tells you which permission is missing. This was checked on a real three-node cluster."
      },
      {
        title: 'Unhealthy consumers',
        text: 'Consumers that lag, redeliver too much or stall are flagged in the list and counted on the Overview. See the consumers page for the rules.'
      }
    ],
    docs: []
  },
  productivity: {
    card: 'Command palette, favourites, saved filters and an audit log.',
    problem:
      'Daily work means jumping between many streams and servers. A few small tools make that quick, and keep a record of what you changed.',
    shot: {
      name: 'features-productivity'
    },
    capabilities: [
      {
        title: 'Command palette',
        text: 'Press Ctrl+K (Cmd+K on macOS) and search connections, streams, consumers, KV buckets and Object Store buckets. Results are grouped by type and connection, and Enter opens one in a tab. Actions such as new connection, publish and switch theme are there too.'
      },
      {
        title: 'Favourites',
        text: 'Star streams, consumers and subjects. Starred items appear in a Favourites section in the sidebar.'
      },
      {
        title: 'Saved filters',
        text: 'Save a message-browser filter set under a name, per connection. Saved filters and favourites survive restarts, and export to and import from one JSON file.'
      },
      {
        title: 'Audit log',
        text: 'Every change records the time, connection, action, target and result. View and filter the log, and export it as CSV. It is stored locally and never records payloads or secrets. Retention is 90 days by default and can be changed.'
      },
      {
        title: 'Keyboard and session restore',
        text: 'Move through tables with the arrow keys, Enter and Esc, and press ? for the shortcut list. Open tabs, the active connection and the layout come back after a restart, and connections reconnect when their tab is opened.'
      },
      {
        title: 'Light and dark',
        text: 'The app follows your system theme, with a manual switch.'
      }
    ],
    docs: [{ path: '/docs/keyboard-shortcuts/', label: 'Every keyboard shortcut' }]
  }
} satisfies Record<string, FeatureContent>

export type FeatureSlug = keyof typeof featureContent
