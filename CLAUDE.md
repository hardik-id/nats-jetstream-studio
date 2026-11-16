# NATS JetStream Studio: notes for Claude sessions

Desktop (Electron) and web studio for NATS and JetStream. Read `docs/architecture.md` for the
architecture, `CONTRIBUTING.md` for running and testing, and `docs/status.md` for what is
implemented and how each backlog item was verified.

## Commands

- `npm run dev`: desktop app with hot reload
- `npm run lint`, `npm run typecheck`
- `npm test`: unit, gateway (needs a real nats-server: `node scripts/nats-binary.mjs` downloads it
  into `.tools/`) and UI tests. One project: `npx vitest run --project core <file>`
- `npm run test:e2e`: builds both targets, then Playwright against Chromium and Electron
- `npm run nats` and `npm run traffic`: a local server with demo data and live traffic

## Rules of this codebase

- The renderer never touches NATS or Node. Everything goes through `NatsGateway`
  (`src/shared/api.ts`); a new gateway method must be added to the interface, to `GATEWAY_METHODS`,
  to `StudioService` and, if it changes server state, to `MUTATING_METHODS`.
- Anything that changes server state goes through `StudioService.mutate()`, which enforces
  read-only mode and writes the audit log. Never rely on a disabled button alone.
- Secrets never reach the renderer, logs or error messages.
- Reading stream messages uses the get-message APIs, never a consumer.
- Gateway tests run against real `nats-server` processes; do not replace them with mocks.
- Prettier formatting (no semicolons, single quotes, width 100). The React lint rules forbid
  setting state inside an effect body and impure calls during render.

## Still not verified

See the table and the PBI-100 section in `docs/status.md`. For work that needs a Windows desktop,
follow `docs/handoff-windows.md`.
