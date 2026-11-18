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

<!-- {{shot ...}} lines are replaced by the site build with the dark and light screenshots; on GitHub they show as plain text. -->

{{shot docs-connection-form}}

Click the connection in the sidebar to connect. The top bar shows the state: connecting, connected, reconnecting or error.

## 3. Open a stream

Open **Streams** in the sidebar. The list shows every stream on the server. Click a stream to open it in a tab.

The stream tab has four parts: **Overview**, **Consumers**, **Subjects** and **Configuration**. Its messages are read on the **Messages** screen (next step), which **Browse messages** in the stream's header opens.

{{shot docs-first-stream}}

## 4. Read a message

1. Open **Messages** in the sidebar and choose the stream in the **Stream** field (type part of its name to filter the list), or press **Browse messages** on the stream's page. There is one Messages screen per connection: every link that browses messages (a subject, a favourite, a consumer's next undelivered message) opens it on the right stream, and the stream you chose comes back after a restart.
2. Under **Start from**, choose where to begin, for example **Latest messages**, then click **Go**. You can also start at a sequence number or a time.
3. Click a message to open it in the detail panel. It shows the subject, headers, time and payload. Switch the payload between text, hex and base64. JSON shows only when the payload parses as JSON, and Protobuf only when a decoder is set for the subject.

   The sections of the panel (Details, Headers, Consumers, Payload) fold with their chevron, so the payload can have the height. **Collapse panel** shrinks the panel to a thin rail and keeps the message selected; **Expand to read** widens it to about 70% of the window and gives it the full height of the Messages screen (the header and toolbar are covered; the table stays on the left) until you press it again or <kbd>Esc</kbd>. The filter panel closes by itself after **Apply filters** or **Clear** (the filter chips stay visible and **Filters** reopens it), so the payload keeps its height. The Details, Headers and Consumers sections share a strip of about a quarter of the panel that scrolls as a whole (it grows when **Consumers** is open, so the list shows several rows); a closed **Consumers** section shows how many consumers the stream has. In a JSON payload, **A-** and **A+** change the text size, **Levels**, **Expand all** and **Collapse all** control how much is open, and the search box finds keys and values (<kbd>Ctrl</kbd> or <kbd>Cmd</kbd> + <kbd>F</kbd> while the payload has focus). Hover a line, or tab to it, to copy its path (for example `$.order.items[0]`) or its value.

   **Filter from a message.** Hover a line (or tab to it) and press **Filter** to keep only the messages with the same value, or **Exclude** to drop them. The filter is `$.path == "value"`; for a value directly in an array it is `$.array contains "value"`, and a value in an object inside an array uses `[*]` (`$.items[*].sku == "A"`), meaning any item. Each row of the **Headers** section has **Include** and **Exclude** buttons too. The condition is added to the filters you already have, the same condition is never added twice, and the list is read again from your start position. Filters are a list of conditions that must all match: each shows as a chip, an excluded one is marked **not**, and a chip has a button to flip include and exclude and one to remove it. **Filters** opens the list to edit: each row has a type (JSONPath, Contains, Regex or Header), the text, **Include** or **Exclude**, and a remove button, and **Add condition** adds a row. An excluded condition rejects a message when its test matches, so excluding `$.a != 1` rejects a message when any `a` differs from 1. Numbers are compared as doubles, so integers beyond 2^53 are compared rounded. An excluded JSONPath condition does not remove a message whose payload is not JSON, because the path matches nothing in it. Saved filters keep the conditions, and files exported before this version still import. These buttons are in the message browser, not in Live tail.

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
