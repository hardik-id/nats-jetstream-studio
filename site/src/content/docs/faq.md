# FAQ and troubleshooting

## Connection errors

**Test connection** names the kind of failure. Find your message below.

### Authentication failed: the server rejected these credentials

The user, password, token, NKey or credentials file was not accepted. Check the method in the form, and that the account matches. For a credentials file, check that it is not expired or revoked. The server may also close the connection without a reason when it rejects a login, and the studio then reports the same message.

### Connection refused: nothing is listening on that address

The host answered but no NATS server listens on that port. Check the address, the port (default 4222), and whether the server is running. In Docker, check that the port is published.

### Server name could not be resolved

The host name does not exist or your DNS cannot find it. Check for typos, and try the IP address.

### Timed out waiting for the server

Nothing answered in time. A firewall or VPN may be in the way. You can raise the limit under **Connection test** in the form, up to 60 seconds.

### TLS error

The certificate could not be verified or the handshake failed. Check these:

- The address starts with `tls://` when the server needs TLS.
- For a private or self-signed CA, set the **CA certificate file** under **TLS**.
- For a server that asks for a client certificate, set the **client certificate file** and **client key file**.
- For a server with `handshake_first`, tick **TLS-first handshake**.

### JetStream is not available to this account

The server is reachable but JetStream is off for this login, or the account has no JetStream. Ask the server's administrator, or use another account. If JetStream sits in another domain or behind an import, set the **JetStream domain** or **API prefix**. See [Connecting](/docs/connections/).

### Permission denied

The user may not use that subject. Ask for permission, or connect as another user. A blocked request names the subject.

### "... is read-only"

The connection is in read-only mode. Turn it off in the connection menu if you really want to change something. See [read-only mode](/docs/connections/#read-only-mode).

### WebSocket URLs are not supported

The studio talks to the normal NATS port. Replace `ws://` or `wss://` with `nats://` or `tls://` and the TCP port of the server.

## Opening the app the first time

The installers are not code-signed yet, so your system warns you. This is expected, and the steps below get past it. See also [Install](/docs/install/).

### Windows SmartScreen: "Windows protected your PC"

Click **More info**, then **Run anyway**.

### macOS Gatekeeper: "cannot be verified" or "is damaged"

Open **System Settings > Privacy & Security** and click **Open Anyway**. Or run this once in a terminal:

```bash
xattr -cr "/Applications/NATS JetStream Studio.app"
```

### Linux

There is no warning. Make the `.AppImage` executable and run it, or install the `.deb`.

## Why is it not just a website?

A browser cannot open a plain TCP connection, and NATS servers speak TCP. A page in a browser could only reach a server that has WebSocket enabled, and the studio does not use WebSocket addresses. Saved passwords would also have to live inside the browser.

So the studio runs as a desktop app that connects straight to your servers. If you want a browser, [web mode](/docs/web-mode/) runs a small server that holds the connections and credentials, and people use the studio through it.

## Does it update itself?

Installed desktop builds check GitHub for a newer version at start and offer to download it. Automatic updates on macOS need a signed app, so until signing is set up, download new macOS versions by hand. Updates have not yet been proven by a real release. See [Install](/docs/install/#updates).

## Does it send data anywhere?

No telemetry. See [Security and privacy](/docs/security/).

## Where can I report a problem?

Open an issue on [GitHub](https://github.com/hardik-id/nats-jetstream-studio/issues).
