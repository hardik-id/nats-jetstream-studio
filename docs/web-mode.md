# Web / server mode

The same React UI can be served by a small Node server instead of running inside Electron. People
then use the studio from a browser, and the server holds the NATS connections and credentials.

```
browser  --HTTP + WebSocket-->  studio server  --TCP/TLS-->  NATS servers
```

## Run it

```bash
npm run build:web
STUDIO_AUTH=none npm run serve          # http://127.0.0.1:8080, local use only
```

or with Docker:

```bash
docker build -t nats-jetstream-studio .
docker run -p 8080:8080 -v studio-data:/data \
  -e STUDIO_OIDC_ISSUER=https://login.example.com \
  -e STUDIO_OIDC_CLIENT_ID=studio \
  -e STUDIO_PUBLIC_URL=https://studio.example.com \
  nats-jetstream-studio
```

## Sign-in

The server refuses to start until you choose how people sign in. Without a session nothing is
served: not the page, not the WebSocket, and so no NATS operation.

| Mode | Settings | Use for |
| --- | --- | --- |
| OIDC | `STUDIO_OIDC_ISSUER`, `STUDIO_OIDC_CLIENT_ID`, `STUDIO_PUBLIC_URL`, optional `STUDIO_OIDC_CLIENT_SECRET`, `STUDIO_OIDC_SCOPES` | Teams. Authorization-code flow with PKCE. Register `<public url>/auth/callback` as the redirect URI. |
| Shared token | `STUDIO_AUTH_TOKEN` (16+ characters) | A small trusted group. |
| None | `STUDIO_AUTH=none` | Your own machine. Only allowed on `127.0.0.1` unless `STUDIO_ALLOW_INSECURE=1`. |

With `STUDIO_AUTH=none` the server only accepts requests whose `Host` header is a loopback name
(`localhost`, `127.0.0.0/8`, `::1`), and only opens the WebSocket for a page whose `Origin` is
loopback too. Other websites therefore cannot reach it through DNS rebinding (a public name that
is switched to resolve to `127.0.0.1`); they get a 403. With `STUDIO_ALLOW_INSECURE=1` on a
non-loopback address this check is off and there is no such protection, so only do that on a
network you fully trust.

Logging out, or a session expiring, also closes that session's open connections right away.

The signed-in user is shown in the top bar and recorded with every change in the audit log.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where to listen. The Docker image listens on `0.0.0.0`. |
| `STUDIO_DATA_DIR` | `.studio-data` | Connections, settings, audit log and the key that encrypts saved secrets. Keep it on a volume. |
| `STUDIO_PROVISION_FILE` | none | JSON file with connections to create or update at start (see below). |
| `STUDIO_LOCK_CONNECTIONS` | off | `1`: users cannot add, change or delete connections. |
| `STUDIO_READ_ONLY` | off | `1`: every connection is read-only, enforced by the server. |
| `STUDIO_CONTEXT_DIR` | NATS CLI folder | Folder with NATS CLI context files to offer as connections. |
| `STUDIO_SAMPLE_INTERVAL_MS` | `5000` | How often stream and consumer metrics are sampled. |

## Connections managed by an administrator

```json
{
  "connections": [
    {
      "name": "Production",
      "servers": ["tls://nats-1.example.com:4222", "tls://nats-2.example.com:4222"],
      "auth": "creds",
      "credsFile": "/secrets/studio.creds",
      "envLabel": "prod",
      "readOnly": true,
      "color": "#dc2626"
    }
  ]
}
```

Connections are matched by name, so restarting with the same file updates them instead of adding
duplicates. Combine with `STUDIO_LOCK_CONNECTIONS=1` so that read-only cannot be switched off from
the UI. Read-only is enforced in the server for every change: create, edit, delete, purge, publish.

## Differences from the desktop app

| Topic | Desktop | Web mode |
| --- | --- | --- |
| Secrets | Encrypted with the OS keychain | Encrypted with a key file in the data directory |
| Credential and certificate files | Chosen with a file dialog on your machine | Paths on the server |
| Connections | Per user | Shared by everyone who signs in |
| Settings, saved filters, favourites, alert rules | Per user | Shared |
| Audit log | Local, no user name | On the server, with the signed-in user |
| Auto-update | Yes | Deploy a new image |
| Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab | Yes | The browser keeps these shortcuts; use the studio's tab bar and the tab's close button |
| Desktop notifications for alerts | Yes | Yes, after allowing them in the browser |
