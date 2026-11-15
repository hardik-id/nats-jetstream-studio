# Checks that need a real Windows desktop

Everything so far was built and run on Linux (WSL). CI runs the tests on Windows and macOS (on
pushes to `main`, on manual runs of the workflow, and on pull requests that carry the label
`all-platforms`), but a few things can only be seen by a person, or by a session, on a real
desktop. This is the list.

## Set up

1. Clone onto the Windows drive, for example `C:\src\nats-jetstream-studio`. Do not open the WSL
   folder from Windows: its `node_modules` holds the Linux build of Electron.
2. Install Git and Node 22.12 or newer, then `npm install`.
3. `node scripts/nats-binary.mjs` downloads `nats-server.exe` into `.tools\`.
4. `npm test`, then `npm run test:e2e`. Fix whatever fails only on Windows. The TLS tests need
   `openssl` on the PATH (Git for Windows has it in `C:\Program Files\Git\usr\bin`); without it
   they are skipped on your machine, and fail in CI.

## What to check by hand

The app keeps its data (connections, settings, the audit log) in `%APPDATA%\NATS JetStream Studio`.
Electron names that folder after `productName` in `package.json`, not after the package name.

Start a server with data in two terminals: `npm run nats` and `npm run traffic`. Then `npm run dev`
and add a connection to `nats://127.0.0.1:4222`, user `app`, password `app`.

| Check | How | Expected |
| --- | --- | --- |
| Secrets use the Windows keychain | Save a connection with a password. Open About. Look at `%APPDATA%\NATS JetStream Studio\connections.json`. | About says "OS keychain". The file holds a value starting with `os:` and no plain password. |
| Saved secret survives a restart | Quit, start again, connect. | Connects without asking for the password. |
| Alert notification | Alerts tab: allow notifications, add a rule "consumer pending above 1" for stream `ORDERS` with 0 seconds. | A Windows notification appears, and the alert is listed under "Fired this session". |
| File dialogs | Connection form: Browse next to "Credentials file" and the TLS files. | The Windows file dialog opens and the chosen path is filled in. |
| Downloads | Export messages, export a stream configuration, download an object. | A save dialog appears and the file has the right content. |
| Installer | Download the `-setup.exe` from the GitHub release and install it. | Installs, starts from the Start menu, shows the right version in About. It is unsigned, so SmartScreen warns. |
| Auto-update | With an older version installed, publish a newer tag. Start the app and wait a few seconds. | A banner offers the new version; "Download" then "Restart to install" ends on the new version. "Later" hides the banner. |
| Uninstall | Remove it from Windows settings. | The app is gone; `%APPDATA%\NATS JetStream Studio` (settings) stays. |

Auto-update reads releases from GitHub. While the repository is private the app cannot see them
without a token, so test this after making the repository public, or point `publish` in
`electron-builder.yml` at a public update server.

Record the results in `docs/status.md` (rows 014, 081 and the PBI-100 section).

## macOS

There is no Mac to test on. The CI job runs the tests and the desktop end-to-end tests on a macOS
runner, and the release workflow builds an unsigned universal dmg. An unsigned app is blocked by
Gatekeeper until the user allows it, and auto-update on macOS only works for a signed app. Signing
and notarization need an Apple Developer account; the release workflow reads the credentials from
the repository secrets listed in `.github/workflows/release.yml`.
