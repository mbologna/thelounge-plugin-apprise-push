# thelounge-plugin-apprise-push

[![npm version](https://img.shields.io/npm/v/thelounge-plugin-apprise-push.svg)](https://www.npmjs.com/package/thelounge-plugin-apprise-push)
[![CI](https://github.com/mbologna/thelounge-plugin-apprise-push/actions/workflows/ci.yml/badge.svg)](https://github.com/mbologna/thelounge-plugin-apprise-push/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/thelounge-plugin-apprise-push.svg)](https://www.npmjs.com/package/thelounge-plugin-apprise-push)
[![license](https://img.shields.io/npm/l/thelounge-plugin-apprise-push.svg)](LICENSE)
[![node](https://img.shields.io/node/v/thelounge-plugin-apprise-push.svg)](package.json)

A [TheLounge](https://thelounge.chat/) **server plugin** that forwards IRC highlights and
private messages to [Apprise](https://github.com/caronc/apprise), so you get a push
notification on your phone, desktop, or any of Apprise's 100+ services (Telegram,
Pushover, ntfy, Gotify, Slack, Discord, …) even when no browser tab is open.

It runs entirely server-side, has **no runtime dependencies** (Node.js built-ins only), and
is configured with a single JSON file that is **hot-reloaded** on change.

---

## Features

- 🔔 **Highlights & PMs** out of the box — fully customisable via an ordered rule engine.
- 🧩 **Rule engine** with glob matching on channel, network, sender nick; `notify` /
  `suppress` actions; first-match-wins ordering.
- ✍️ **Per-rule message templates** — override the title/body for specific rules.
- 🔐 **Apprise authentication** — bearer token or arbitrary custom headers.
- 🔁 **Retry with exponential backoff** and a configurable request timeout.
- 😴 **Away-only mode**, per-context **cooldown**, nick/network **blacklists**, and extra
  **highlight words**.
- ♻️ **Hot-reload** — edit the config and changes apply within a second; no restart.
- 🪶 **Zero runtime dependencies**, single small codebase, fully unit-tested.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Apprise connection](#apprise-connection)
  - [Authentication](#authentication)
  - [Delivery tuning](#delivery-tuning)
  - [Notification text](#notification-text)
  - [Global pre-filters](#global-pre-filters)
  - [Rules](#rules)
- [Examples](#examples)
- [Running Apprise API](#running-apprise-api)
- [Debugging](#debugging)
- [Notes](#notes)
- [Development](#development)
- [Related](#related)
- [License](#license)

---

## Requirements

- TheLounge ≥ 4.0
- Node.js ≥ 18
- A running [Apprise API](https://github.com/caronc/apprise/wiki/api_overview) server with a
  persistent notification configuration pre-loaded under a key (e.g. `chatnotifications`)

---

## Installation

1. **Install the plugin:**

   ```bash
   thelounge install thelounge-plugin-apprise-push
   ```

2. **Create the config file** at `~/.thelounge/apprise-push.json` (see
   [Configuration](#configuration) below). A starter file is shipped as
   [`apprise-push.example.json`](apprise-push.example.json).

3. **Restart TheLounge** once to load the plugin. After that, config changes are picked up
   automatically. No further restarts needed.

---

## Configuration

All options go in `$THELOUNGE_HOME/apprise-push.json` (usually `~/.thelounge/apprise-push.json`).

### Apprise connection

| Key           | Type   | Description                                                                             |
| ------------- | ------ | --------------------------------------------------------------------------------------- |
| `apprise_url` | string | Full Apprise API notify endpoint, e.g. `"http://apprise:8000/notify/chatnotifications"` |

The plugin POSTs `{ "title": "...", "body": "..." }` to this URL. The notification
destinations are configured server-side in Apprise under the given key.

### Authentication

Optional. Use these when your Apprise API sits behind auth or a reverse proxy.

| Key               | Type   | Default | Description                                                                |
| ----------------- | ------ | ------- | -------------------------------------------------------------------------- |
| `apprise_token`   | string | `""`    | Shorthand — sent as `Authorization: Bearer <token>`.                       |
| `apprise_headers` | object | `{}`    | Arbitrary extra HTTP headers. Overrides the bearer header on key conflict. |

```json
"apprise_headers": { "Authorization": "Basic dXNlcjpwYXNz", "X-Source": "thelounge" }
```

### Delivery tuning

| Key           | Type   | Default | Description                                                                                        |
| ------------- | ------ | ------- | -------------------------------------------------------------------------------------------------- |
| `timeout`     | number | `10000` | Milliseconds before a single Apprise request is aborted.                                           |
| `retries`     | number | `2`     | Extra attempts after the first on transient failure (timeout, 5xx, network). `0` disables retries. |
| `retry_delay` | number | `500`   | Base backoff in ms; grows exponentially (`500 → 1000 → 2000 …`).                                   |

### Notification text

| Key           | Default                        | Description                                                    |
| ------------- | ------------------------------ | -------------------------------------------------------------- |
| `title_pm`    | `"PM from {nick} [{network}]"` | Title for private message notifications.                       |
| `title_chan`  | `"[{network}] {channel}"`      | Title for channel notifications.                               |
| `body`        | `"{nick}: {message}"`          | Notification body.                                             |
| `body_length` | `100`                          | Truncate `{message}` to this many characters. `0` = unlimited. |

**Keyword expansion**: these placeholders are replaced in `title_pm`, `title_chan`, `body`,
and per-rule `title`/`body` overrides:

| Keyword     | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| `{channel}` | Channel name or sender nick (for PMs)                              |
| `{nick}`    | Message sender                                                     |
| `{network}` | IRC network name                                                   |
| `{mynick}`  | Your own nick on that network                                      |
| `{time}`    | Local time the message was received                                |
| `{message}` | Message text (IRC formatting stripped, truncated to `body_length`) |

### Global pre-filters

These apply before any rule is evaluated. They are fast exits.

| Key                 | Default | Description                                                                                          |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `away_only`         | `false` | Only notify when **no** TheLounge browser tabs are connected. Equivalent to ZNC's away-only mode.    |
| `cooldown`          | `0`     | Minimum seconds between two notifications for the same context (channel or PM). `0` = disabled.      |
| `nick_blacklist`    | `[]`    | Glob patterns. Messages from matching nicks are silently dropped. E.g. `["*bot*", "ChanServ"]`.      |
| `network_blacklist` | `[]`    | Glob patterns. Messages from matching network names are silently dropped.                            |
| `highlight_words`   | `[]`    | Extra words/patterns that count as a highlight in addition to your own nick. Glob patterns accepted. |

### Rules

```json
"rules": [ <rule>, <rule>, ... ]
```

Rules are evaluated **in order**; the **first matching rule wins**. If no rule matches, no
notification is sent.

Each rule is a JSON object. All specified conditions must be true (AND logic). If a rule has
no conditions it matches everything.

#### Rule conditions

| Key         | Type               | Description                                                                                                 |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `channel`   | string \| string[] | Glob pattern(s) for the channel name. If set, the rule only matches channel messages in a matching channel. |
| `pm`        | boolean            | `true` → only match private messages. `false` → only match channel messages. Omit to match both.            |
| `highlight` | boolean            | `true` → only match if the message contains your nick or a `highlight_words` entry.                         |
| `network`   | string \| string[] | Glob pattern(s) for the network name.                                                                       |
| `nick`      | string \| string[] | Glob pattern(s) for the **sender** nick.                                                                    |

#### Rule action & overrides

| Key      | Default    | Description                                                                       |
| -------- | ---------- | --------------------------------------------------------------------------------- |
| `action` | `"notify"` | `"notify"` sends a notification. `"suppress"` blocks and stops evaluation.        |
| `title`  | _(global)_ | Override the title template for this rule. Falls back to `title_pm`/`title_chan`. |
| `body`   | _(global)_ | Override the body template for this rule. Falls back to `body`.                   |

Glob patterns support `*` (any sequence) and `?` (any single character), case-insensitive.

---

## Examples

### Default: highlights and PMs

```json
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

### All messages in a channel

```json
"rules": [
  { "channel": "#announcements" },
  { "highlight": true },
  { "pm": true }
]
```

### Multiple channels: all messages

```json
"rules": [
  { "channel": ["#announcements", "#alerts", "#ops"] },
  { "highlight": true },
  { "pm": true }
]
```

### Highlights only in specific channels

```json
"rules": [
  { "channel": "#dev", "highlight": true },
  { "channel": "#ops", "highlight": true },
  { "pm": true }
]
```

### Custom message template for a rule

```json
"rules": [
  { "channel": "#alerts", "title": "🚨 ALERT [{network}]", "body": "{nick}: {message}" },
  { "highlight": true },
  { "pm": true }
]
```

### Suppress a noisy channel before a catch-all

```json
"rules": [
  { "channel": "#random", "action": "suppress" },
  { "channel": "#*", "highlight": true },
  { "pm": true }
]
```

### Suppress bots everywhere

```json
"nick_blacklist": ["*bot*", "ChanServ", "NickServ"],
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

> `nick_blacklist` is a global pre-filter, so no rule can override it.
> If you need per-channel bot suppression, use a suppress rule instead.

### Per-network rule

```json
"rules": [
  { "network": "Libera", "channel": "#project", "highlight": true },
  { "network": "OFTC", "highlight": true },
  { "pm": true }
]
```

### Extra highlight words

```json
"highlight_words": ["myproject", "urgent", "prod*"],
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

`prod*` will match "production", "prod-alert", etc.

### Authenticated Apprise behind a proxy

```json
"apprise_url": "https://apprise.example.com/notify/chatnotifications",
"apprise_token": "s3cr3t-bearer-token",
"timeout": 5000,
"retries": 3
```

---

## Running Apprise API

The quickest way to run the Apprise API server:

```bash
docker run -p 8000:8000 caronc/apprise:latest
```

Load your notification URLs into Apprise under a key (e.g. `chatnotifications`) via the web
UI or API, then set `apprise_url` to `"http://apprise:8000/notify/chatnotifications"`.

See the [Apprise wiki](https://github.com/caronc/apprise/wiki) for the full list of supported
services (Telegram, Pushover, Slack, Discord, Gotify, ntfy, and many more).

---

## Debugging

Set `"debug": true` in the config. Each incoming message will log its evaluation result to
TheLounge's stdout:

```
[apprise-push] chan "#dev" from "alice" hl=true → notify
[apprise-push] → "[Libera] #dev" / "alice: hey yourname, take a look"
[apprise-push] Apprise → HTTP 200
```

Unknown config keys and bad value types are also reported as warnings at load time.

---

## Notes

- **`/me` actions** (`* nick does something`) are included as triggers. The action text is
  prefixed with `* nick` in the notification body.
- **Cooldown** is tracked independently per context (each channel and each PM thread has its
  own timer).
- **Retries** apply to transient failures (timeouts, network errors, and non-2xx responses)
  with exponential backoff; the request is dropped after the last attempt and the error is logged.
- **Hot-reload**: `apprise-push.json` is watched for changes. Edits take effect within a
  second; no TheLounge restart required. If the file is invalid JSON the previous config is
  kept and an error is logged.
- **Reconnects** are handled automatically: the plugin re-attaches to a network's IRC
  connection on reconnection.
- The plugin has **no runtime npm dependencies** beyond Node.js built-ins.

---

## Development

```bash
npm install      # install dev tooling (ESLint, Prettier)
npm test         # run the node:test unit suite
npm run lint     # ESLint
npm run format   # Prettier --write
```

The codebase is split into small, individually-tested modules under [`lib/`](lib):
`config.js` (defaults, glob compilation, validation), `highlight.js`, `rules.js` (rule
engine), `template.js` (placeholder expansion), and `apprise.js` (HTTP delivery).
[`index.js`](index.js) wires them into TheLounge.

---

## Related

Part of a small family of TheLounge add-ons by [@mbologna](https://github.com/mbologna):

- 🔔 **[thelounge-plugin-apprise-push](https://github.com/mbologna/thelounge-plugin-apprise-push)** — push notifications via Apprise (this project)
- 🎨 **[thelounge-theme-chat](https://github.com/mbologna/thelounge-theme-chat)** — warm, editorial light/dark theme

---

## License

[MIT](LICENSE) © Michele Bologna
