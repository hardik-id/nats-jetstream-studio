# Getting started

This page takes you from a fresh install to reading a message in a stream. It needs about five minutes.

## 1. Install the app

Download the installer for your system from the [Download page](/download/) and open it. The installers are not code-signed yet, so Windows and macOS warn you the first time. [Install](/docs/install/) shows how to get past the warning.

## 2. Add your first connection

You need the address of a NATS server. If you do not have one, use the [demo data](#no-server-use-the-demo-data) below.

1. In the sidebar, click **Add connection**.
2. Enter a **Name**, for example `local`.
3. Enter the **Server URLs**, for example `nats://localhost:4222`. The default port is 4222.
4. Pick the **Authentication** method your server needs. Use **None** for a server without logins. [Connecting](/docs/connections/) explains every method.
5. Click **Test connection**. The studio reports the server name, the NATS version, the round-trip time, and whether JetStream is available to this account.
6. Click **Save**.

{{shot docs-connection-form}}

Click the connection in the sidebar to connect. The top bar shows the state: connecting, connected, reconnecting or error.

## 3. Open a stream

Open **Streams** in the sidebar. The list shows every stream on the server. Click a stream to open it in a tab.

The stream tab has five parts: **Overview**, **Messages**, **Consumers**, **Subjects** and **Configuration**.

{{shot docs-first-stream}}

## 4. Read a message

1. Open the **Messages** tab of the stream.
2. Under **Start from**, choose where to begin, for example **Latest messages**, then click **Go**. You can also start at a sequence number or a time.
3. Click a message to open it in the detail panel. It shows the subject, headers, time and payload. Switch the payload between JSON, text, hex, base64 and Protobuf.

Reading is safe. The studio reads messages straight from the stream. It does not create a consumer and it acknowledges nothing, so no consumer position changes.

While the message panel has focus, use <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> to step through messages and <kbd>Esc</kbd> to close the panel. All shortcuts are listed under [Keyboard shortcuts](/docs/keyboard-shortcuts/).

## No server? Use the demo data

If you have a checkout of the [repository](https://github.com/hardik-id/nats-jetstream-studio) and no NATS server, start a local one with demo data. Run each command in its own terminal. The last two keep running.

```bash
npm install
npm run nats      # a local nats-server on nats://127.0.0.1:4222
npm run traffic   # demo streams, consumers, KV and Object Store, plus live traffic
```

`npm run nats` downloads the official `nats-server` binary if it is not on your path. It creates the users `app` / `app` and `viewer` / `viewer`. Add a connection to `nats://127.0.0.1:4222`, choose **User and password**, and use `app` for both. The `viewer` user cannot publish to normal subjects, which is handy for trying permission errors.

`npm run traffic` first creates the streams `ORDERS`, `EVENTS`, `JOBS` and `TELEMETRY`, with consumers, two KV buckets and one Object Store. It then keeps publishing and consuming until you press <kbd>Ctrl</kbd> + <kbd>C</kbd>. The `ORDERS` stream has one consumer that falls behind and one that never acknowledges, so you can see lag and redeliveries.

## Where to go next

- [Connecting](/docs/connections/): TLS, credentials files, JetStream domains and read-only mode.
- [Features](/features/): everything the studio can do.
- [Web mode](/docs/web-mode/): use the studio in a browser.
