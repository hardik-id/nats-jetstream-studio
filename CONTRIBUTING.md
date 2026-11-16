# Contributing

Thanks for helping. This page covers running the studio from source, the checks to run before a pull
request, and the rules the code follows.

## Get started

```bash
npm install
npm run dev              # desktop app with hot reload
```

To work without a NATS server of your own:

```bash
npm run nats             # local nats-server on 4222 (users app/app, viewer/viewer, sys/sys)
npm run traffic          # demo streams, consumers, KV, objects, plus live publishers and consumers
```

Then add a connection to `nats://127.0.0.1:4222` with user `app`, password `app`. The first
command downloads the official `nats-server` binary into `.tools/` if it is not on your PATH.

## Commands

| Command                                               | What it does                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                                         | Desktop app in development mode                                  |
| `npm run build`                                       | Type-check and build the desktop app into `out/`                 |
| `npm run build:linux`, `build:win`, `build:mac`       | Installers into `release/`                                       |
| `npm run build:web`, `npm run serve`                  | Build and run web mode ([docs/web-mode.md](docs/web-mode.md))   |
| `npm run lint`, `npm run typecheck`, `npm run format` | Code quality                                                     |
| `npm test`                                            | Unit tests, gateway tests against a real `nats-server`, UI tests |
| `npm run test:e2e`                                    | End-to-end tests: the UI in Chromium and the desktop app         |

Tests need a real `nats-server`: `node scripts/nats-binary.mjs` downloads it into `.tools/`.
Run one test project with `npx vitest run --project core <file>`.

## Rules of the codebase

- The renderer never touches NATS or Node. Everything goes through `NatsGateway`
  (`src/shared/api.ts`). A new gateway method goes into the interface, `GATEWAY_METHODS`,
  `StudioService` and, if it changes server state, `MUTATING_METHODS`.
- Anything that changes server state goes through `StudioService.mutate()`, which enforces
  read-only mode and writes the audit log. Never rely on a disabled button alone.
- Secrets never reach the renderer, logs or error messages.
- Reading stream messages uses the get-message APIs, never a consumer.
- Gateway tests run against real `nats-server` processes. Do not replace them with mocks.
- Prettier formatting (no semicolons, single quotes, width 100). The React lint rules forbid setting
  state inside an effect body and impure calls during render.

The layout of `src/` is described in [docs/architecture.md](docs/architecture.md).

## Pull requests

1. Branch from `main`, keep the change focused, and add or update tests.
2. Run `npm run lint`, `npm run typecheck` and `npm test` (and `npm run test:e2e` for UI changes).
3. CI runs Linux on every pull request. Windows and macOS run on `main`; add the `all-platforms` label
   only when a change is platform specific, because those runners are slow.
4. Squash merge into `main`.

## Releases

Push a tag such as `v0.2.0`. The [release workflow](.github/workflows/release.yml) builds the
Windows, macOS and Linux installers and attaches them to a GitHub release as a draft. Check the
files, then publish the draft. Code signing is tracked in
[#17](https://github.com/hardik-id/nats-jetstream-studio/issues/17) and
[#18](https://github.com/hardik-id/nats-jetstream-studio/issues/18).

## More documentation

- [docs/status.md](docs/status.md): what is implemented and how each backlog item was verified
- [docs/backlog.md](docs/backlog.md): the product backlog
- [docs/handoff-windows.md](docs/handoff-windows.md): checks that need a real Windows desktop
