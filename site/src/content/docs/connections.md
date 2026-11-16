# Connecting

Open the connection form with **Add connection** in the sidebar, or choose **Edit** from the menu of an existing connection. Use **Test connection** before you save: it tries the settings without saving them.

## Server URLs

- Write one address per line. Give several servers of the same cluster so the studio can fail over to another one.
- Use `nats://host:port` or `tls://host:port`. A bare `host:port` is read as `nats://`. The default port is 4222.
- `ws://` and `wss://` (WebSocket) addresses are not supported. Use the normal NATS port of the server.

## Authentication

The **Method** list has five choices.

| Method | What you enter |
| --- | --- |
| None | Nothing. For servers that do not ask for a login. |
| User and password | User and password. |
| Token | The token. |
| NKey seed | The seed, which starts with `S`, or a path to a seed file. |
| Credentials file (JWT and NKey) | A path to a `.creds` file. This is the usual login for accounts and operators created with `nsc`. |

For the file types, the studio stores the path, not a copy of the file. It reads a credentials file again at every reconnect, so a rotated file is picked up. In the desktop app the **Browse** button opens a file dialog. In [web mode](/docs/web-mode/) the path is on the server.

### Saving secrets

For passwords, tokens and NKey seeds, the checkbox **Save the secret on this computer** controls storage. When it is on, the secret is encrypted and stored. When it is off, the studio asks for the secret every time you connect and keeps nothing. [Security and privacy](/docs/security/) says how secrets are encrypted on each system.

## TLS

Open the **TLS** section for the options below. A `tls://` address turns TLS on.

- **CA certificate file**: the certificate authority that signed the server certificate. Needed when the server uses a private CA.
- **Client certificate file** and **Client key file**: for servers that require a client certificate (mutual TLS).
- **TLS-first handshake**: for servers configured with `handshake_first`. The TLS handshake then happens before any NATS data is sent.

## JetStream domain, API prefix and inbox prefix

These are in **JetStream and inbox options**. Leave them empty unless your setup needs them.

- **JetStream domain**: the domain name, for example `hub`, when you reach a JetStream domain on a leaf node or in a super-cluster.
- **API prefix**: replaces the default `$JS.API` prefix. Needed when the JetStream API of another account is imported under a different subject prefix.
- **Inbox prefix**: replaces the default `_INBOX` prefix for reply subjects. Needed when permissions only allow a certain prefix.

## Environment, colour and description

Give each connection an **Environment** label, for example `dev`, `test`, `staging` or `prod`, and a colour. They show in the sidebar and the top bar, so you do not confuse two servers. When you type `prod` or `production`, the form ticks **Read-only** for you. You can untick it again.

## Read-only mode

Tick **Read-only** in the form, or use **Make read-only** in the connection menu. A read-only connection blocks every change: creating, editing and deleting streams, consumers and buckets, purging, deleting messages, putting KV values, uploading objects, pausing consumers, publishing and request/reply. Reading, browsing and live tail keep working.

The block is enforced by the studio's core and not only by disabled buttons. A blocked attempt is written to the audit log as `blocked`. In [web mode](/docs/web-mode/) an administrator can force read-only for everyone.

## NATS CLI contexts

If you use the `nats` command line tool, the studio lists its contexts as connections. It reads them from `$XDG_CONFIG_HOME/nats/context`, or `~/.config/nats/context` when that variable is not set. It takes over the server URLs, user, password, token, NKey, credentials file, TLS files, JetStream domain, API prefix and inbox prefix of each context.

- Click the refresh button in the sidebar to read the folder again.
- Details that come from the context are locked in the form. Change them with the `nats` CLI. You can still set the colour, the environment label and read-only mode.
- A CLI connection cannot be deleted in the studio. Remove it with `nats context rm`.
- A context that uses `nsc` or `user_jwt` shows a warning and cannot connect. Set a credentials file on the context instead. A SOCKS proxy setting is ignored.

## Test timeout

Under **Connection test** you can set how long a test waits, from 1 to 60 seconds. The default is 5. It applies to every test. It is one limit for the whole attempt, however many servers you listed.

## After you connect

If the connection drops, the studio reconnects by itself. It retries quickly at first and then every 8 seconds. The top bar shows `reconnecting` while it does. If something does not work, see [FAQ and troubleshooting](/docs/faq/).
