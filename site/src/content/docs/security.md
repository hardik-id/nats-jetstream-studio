# Security and privacy

## Where your secrets are stored

Passwords, tokens and NKey seeds are encrypted before they are written to disk. Connection settings, saved filters and other preferences are plain files in the app's data folder, and they contain no secrets.

| Where | How secrets are protected |
| --- | --- |
| Windows desktop | Encrypted with the Windows Data Protection API (DPAPI), through Electron `safeStorage`. Tied to your Windows account. |
| macOS desktop | Encrypted with a key held in the macOS Keychain, through Electron `safeStorage`. |
| Linux desktop | Encrypted with a key held by the desktop keyring (libsecret, for example GNOME Keyring, or KWallet), through Electron `safeStorage`. |
| Web mode | Encrypted with AES-256-GCM. The key is a file in the server's data directory (`STUDIO_DATA_DIR`), readable only by the server's user. Keep that directory on a volume and protect it. |

Secret storage was tested on Linux only. The Windows and macOS paths were not run (see [implementation status](https://github.com/hardik-id/nats-jetstream-studio/blob/main/docs/status.md)).

If a Linux system has no keyring, a saved secret would only be lightly protected. The connection form then warns you and suggests that you untick **Save the secret on this computer**. The studio then asks for the secret each time you connect and stores nothing.

Credentials files, NKey seed files and TLS certificate files are not copied. The studio only keeps their paths and reads the files when it connects. Secrets are never sent to the user interface once saved: the form shows only that one is stored.

## No telemetry

The studio sends no telemetry, analytics or crash reports. It has no tracking code and no account. Its connections go to the NATS servers you add. The few other requests are these:

- **Update check (desktop app only).** An installed build asks GitHub Releases for a newer version about five seconds after it starts, and when you press **Check for updates** in the About dialog. It never downloads or installs anything until you say so. It does not run in web mode.
- **Sign-in (web mode only).** If you choose OIDC, the server talks to your identity provider.

The fonts are part of the app, so nothing is loaded from a font service. This website also uses no trackers and no third-party scripts.

## The audit log

Every action that changes something is written to a log on your machine, one line per action. Each entry has:

- the time,
- the connection name,
- the action, for example `stream.create`, `stream.purge`, `message.delete`, `consumer.update`, `kv.put`, `object.delete`, `publish` or `request`,
- the target, for example the stream or `stream > consumer`,
- the result: `ok`, `error` or `blocked` (a read-only connection refused it),
- a short detail, such as an error message or a byte count,
- in web mode, the signed-in user.

Message payloads and secrets are never written to the log. Reading, browsing and live tail are not logged, because they change nothing.

The log is the file `audit.ndjson` in the app's data folder. It keeps 90 days by default. You can change that and export the log as CSV in the **Audit log** tab. In the desktop app the log is local and has no user name. In web mode it is on the server and every entry carries the user. Attempts blocked by read-only mode are recorded too.

## Unsigned builds

The installers are not code-signed yet. That is why Windows SmartScreen and macOS Gatekeeper warn you the first time. The files are built by a public GitHub workflow from a tagged commit, and you can read the source. See [Install](/docs/install/) for how to open the app, and the [FAQ](/docs/faq/) for what the warnings mean.

## Read-only mode and web mode

Use [read-only mode](/docs/connections/#read-only-mode) on production connections. It is enforced by the studio's core, not just the buttons. In [web mode](/docs/web-mode/) nothing is served without a signed-in session (unless the administrator set `STUDIO_AUTH=none` on `127.0.0.1`, where the audit user is `local` and only loopback `Host` and `Origin` headers are accepted, so websites cannot reach it through DNS rebinding), and an administrator can lock connections and force read-only.
