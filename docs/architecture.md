# Architecture

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

## Stack

Electron, React, TypeScript, Vite (electron-vite), Tailwind CSS, TanStack Query and Virtual,
Zustand, Vitest, Playwright, electron-builder.
