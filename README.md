# NATS JetStream Studio

A studio for NATS and JetStream. Connect to one or more NATS servers and browse streams,
consumers, subjects and messages, filter them, and manage them from one place. It runs as a desktop
app (Electron) and, with the same UI, as a web app served by a small Node server.

## What it does

- **Connections**: several servers at once, colour and environment per connection, read-only mode
  (on by default for production), automatic reconnect. Contexts from the `nats` CLI are found
  automatically.
- **Overview**: server details, JetStream usage against limits, unhealthy consumers, cluster
  topology (with a system-account user).
- **Streams**: list, search, create, edit, purge, delete, per-subject message counts, configuration
  export and import.
- **Messages**: page through any stream without creating a consumer or acknowledging anything.
  Start from the latest, the first, a sequence or a time. Filter by subject, header, payload text,
  regular expression or JSONPath. View payloads as JSON, text, hex, base64 or decoded Protobuf.
  Export, delete and republish.
- **Consumers**: lag, ack pending, redeliveries, health flags, create, edit, pause, resume, delete.
- **Live**: tail any subject, publish, request/reply, message templates.
- **KV and Object Store**: browse, edit, watch, upload, download.
- **Monitoring**: charts for streams and consumers, alert rules with desktop notifications.
- **Productivity**: command palette (Ctrl/Cmd+K), favourites, saved filters, audit log of every
  change, keyboard navigation, tabs restored on restart.

## Getting started

```bash
npm install
npm run dev              # desktop app with hot reload
```

To try it without a NATS server of your own:

```bash
npm run nats             # local nats-server on 4222 (users app/app, viewer/viewer, sys/sys)
npm run traffic          # demo streams, consumers, KV, objects, plus live publishers and consumers
```

Then add a connection to `nats://127.0.0.1:4222` with user `app`, password `app`. The first
command downloads the official `nats-server` binary into `.tools/` if it is not on your PATH.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Desktop app in development mode |
| `npm run build` | Type-check and build the desktop app into `out/` |
| `npm run build:linux`, `build:win`, `build:mac` | Installers into `release/` |
| `npm run build:web`, `npm run serve` | Build and run web mode ([docs/web-mode.md](docs/web-mode.md)) |
| `npm run lint`, `npm run typecheck`, `npm run format` | Code quality |
| `npm test` | Unit tests, gateway tests against a real `nats-server`, UI tests |
| `npm run test:e2e` | End-to-end tests: the UI in Chromium and the desktop app |

## Architecture

The model is the same as AKS desktop (Headlamp): a React UI in a desktop shell, with a local
backend that reads a config file and holds the connections.

```
┌──────────────────────────── Electron ────────────────────────────┐
│  Renderer (React + TypeScript)        Main process (Node)         │
│  ┌─────────────────────────┐   IPC    ┌────────────────────────┐  │
│  │ UI, tables, viewers     │ <──────> │ StudioService          │  │      TCP / TLS
│  │ talks to NatsGateway    │  typed   │ connections, sampler   │ ─┼──> NATS servers
│  │ interface only          │          │ secrets (OS keychain)  │  │
│  └─────────────────────────┘          └────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

- **Why not a pure browser app:** browsers cannot open the NATS TCP port. A browser-only app would
  need every server to enable its WebSocket listener and would keep credentials in the browser.
- **`src/shared`**: the `NatsGateway` contract and pure logic used on both sides (subject matching,
  durations, filters, JSONPath, health rules).
- **`src/core`**: `StudioService` implements the gateway with the official clients
  (`@nats-io/transport-node`, `jetstream`, `kv`, `obj`). It knows nothing about Electron or HTTP.
  Read-only mode and the audit log are enforced here, not in the UI.
- **`src/main`, `src/preload`**: the Electron shell. The renderer is sandboxed and gets exactly one
  bridge object; it has no Node or Electron access.
- **`src/server`**: web mode. The same service behind HTTP and a WebSocket, with sign-in.
- **`src/renderer`**: the React UI. In tests it runs against an in-memory fake gateway
  (`src/renderer/src/gateway/fake.ts`).
- **Config**: NATS CLI contexts (`~/.config/nats/context/*.json`) plus connections added in the
  studio. Secrets are encrypted with the OS keychain; context files are never written to.

Reading messages uses the get-message APIs (direct get when the stream allows it), never a
consumer, so browsing is safe on work-queue and interest streams too.

## Documentation

- [docs/backlog.md](docs/backlog.md): the product backlog
- [docs/status.md](docs/status.md): what is implemented and how each item was verified
- [docs/web-mode.md](docs/web-mode.md): running the studio as a web app

## Stack

Electron, React, TypeScript, Vite (electron-vite), Tailwind CSS, TanStack Query and Virtual,
Zustand, Vitest, Playwright, electron-builder.
