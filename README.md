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

- 🔔 **Highlights & PMs** out of the box, fully customisable via an ordered rule engine.
- 🧩 **Rule engine** with glob matching on channel, network, sender nick, and **message
  content** (`contains`); `notify` / `suppress` actions; first-match-wins ordering.
- ✍️ **Per-rule overrides** for title, body, cooldown, and notification priority.
- 🔔 **Notification priority** support for services that honour it (Pushover, ntfy, Gotify …).
- 🔐 **Apprise authentication** with a bearer token or arbitrary custom headers.
- 🔁 **Retry with exponential backoff** and a configurable request timeout.
- 😴 **Away-only mode**, per-context **cooldown**, nick/network **blacklists**, and extra
  **highlight words**.
- 🌍 **Configurable timezone** for the `{time}` placeholder.
- ♻️ **Hot-reload**: edit the config and changes apply within a second; no restart.
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

The plugin POSTs `{ "title": "...", "body": "..." }` (plus an optional `"priority"` field)
to this URL. The notification destinations are configured server-side in Apprise under the
given key.

### Authentication

Optional. Use these when your Apprise API sits behind auth or a reverse proxy.

| Key               | Type   | Default | Description                                                                |
| ----------------- | ------ | ------- | -------------------------------------------------------------------------- |
| `apprise_token`   | string | `""`    | Shorthand, sent as `Authorization: Bearer <token>`.                        |
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

| Key           | Default                        | Description                                                                                           |
| ------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `title_pm`    | `"PM from {nick} [{network}]"` | Title template for private message notifications.                                                     |
| `title_chan`  | `"[{network}] {channel}"`      | Title template for channel notifications.                                                             |
| `body`        | `"{nick}: {message}"`          | Notification body template.                                                                           |
| `body_length` | `100`                          | Truncate `{message}` to this many characters. `0` = unlimited.                                        |
| `priority`    | `null`                         | Notification priority passed to Apprise. `null` = omit. Accepts a number or `"min"` / `"low"` / `"normal"` / `"high"` / `"max"`. Honoured by Pushover, ntfy, Gotify and others. |
| `timezone`    | `""`                           | IANA timezone name for the `{time}` placeholder, e.g. `"America/New_York"`. Empty = system timezone. |

**Keyword expansion**: these placeholders are replaced in `title_pm`, `title_chan`, `body`,
and per-rule `title`/`body` overrides:

| Keyword     | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `{channel}` | Channel name or sender nick (for PMs)                                                    |
| `{nick}`    | Message sender                                                                           |
| `{network}` | IRC network name                                                                         |
| `{mynick}`  | Your own nick on that network                                                            |
| `{time}`    | Time the message was received (IANA timezone from `timezone` config, or system timezone) |
| `{message}` | Message text (IRC formatting stripped, truncated to `body_length`)                       |

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

All conditions are AND'd together. A rule with no conditions matches every message.

| Key         | Type               | Description                                                                                                 |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `channel`   | string \| string[] | Glob pattern(s) for the channel name. If set, the rule only matches channel messages in a matching channel. |
| `pm`        | boolean            | `true` → only match private messages. `false` → only match channel messages. Omit to match both.            |
| `highlight` | boolean            | `true` → only match if the message contains your nick or a `highlight_words` entry.                         |
| `network`   | string \| string[] | Glob pattern(s) for the network name.                                                                       |
| `nick`      | string \| string[] | Glob pattern(s) for the **sender** nick.                                                                    |
| `contains`    | string \| string[] | Glob pattern(s) matched against the message text (after stripping IRC formatting). Any one pattern matching is sufficient. E.g. `["*deploy*", "*alert*"]`. Note: patterns are substring-matched — `"*down*"` matches "shutdown" and "password". |
| `message_type` | string            | `"privmsg"` to match only regular messages, `"action"` to match only `/me` actions. Omit to match both. |

#### Rule action & overrides

| Key        | Default    | Description                                                                                                                   |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `action`   | `"notify"` | `"notify"` sends a notification. `"suppress"` blocks further evaluation and sends nothing.                                    |
| `title`    | _(global)_ | Override the title template for this rule. Omit to fall back to `title_pm` (PMs) or `title_chan` (channels).                  |
| `body`     | _(global)_ | Override the body template for this rule. Omit to fall back to the global `body`.                                             |
| `cooldown` | _(global)_ | Per-rule cooldown in seconds. Overrides the global `cooldown` for messages matched by this rule. Use `0` to always notify. The timer resets on each sent notification; skipped messages do not reset it. |
| `priority` | _(global)_ | Per-rule priority. Overrides the global `priority` for this rule. Same values as the global `priority` field. |

Glob patterns support `*` (any sequence) and `?` (any single character), case-insensitive.

> **Rule ordering tip:** Put `suppress` rules before catch-all `notify` rules. Specific
> conditions before broad ones. Global pre-filters (`away_only`, blacklists) always run first
> regardless of rule order.

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

### Keyword alerts in a channel

```json
"rules": [
  { "channel": "#ops", "contains": ["*down*", "*alert*", "deploy*"] },
  { "highlight": true },
  { "pm": true }
]
```

Sends a notification whenever `#ops` has a message containing "down", "alert", or starting with "deploy", in addition to the usual highlights and PMs.

### Per-rule cooldown: silence a noisy channel, never suppress PMs

```json
"rules": [
  { "pm": true, "cooldown": 0 },
  { "channel": "#general", "highlight": true, "cooldown": 300 },
  { "highlight": true }
]
```

PMs are always delivered immediately. Highlights in `#general` are throttled to one every 5 minutes. Other highlights use the global `cooldown`.

### Filter by message type

```json
"rules": [
  { "channel": "#dev", "message_type": "action" },
  { "highlight": true },
  { "pm": true }
]
```

Only `/me` actions in `#dev` trigger a notification (e.g. `* alice pushes to main`), not regular messages. Highlights and PMs still work as normal.

### Priority notifications for critical channels

```json
"priority": "low",
"rules": [
  { "channel": "#incidents", "contains": "*CRITICAL*", "priority": "high" },
  { "highlight": true },
  { "pm": true }
]
```

All notifications default to low priority, but messages in `#incidents` that contain "CRITICAL" are sent at high priority.

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

[apprise-push] chan "#general" from "bob" hl=false → skip (cooldown)
[apprise-push] chan "#random" from "eve" hl=false → skip (no_match)
[apprise-push] PM "dave" from "dave" hl=false → skip (away_only)
[apprise-push] chan "#spam" from "bot" hl=false → suppress (suppress)
```

Possible outcomes and their meanings:

| Output | Meaning |
|---|---|
| `→ notify` | A rule matched and a notification was sent |
| `→ skip (away_only)` | `away_only: true` and a browser tab is connected |
| `→ skip (nick_blacklist)` | Sender matched a `nick_blacklist` pattern |
| `→ skip (network_blacklist)` | Network matched a `network_blacklist` pattern |
| `→ skip (cooldown)` | Within the cooldown window for this context |
| `→ skip (no_match)` | No rule matched — message was silently dropped |
| `→ suppress (suppress)` | A rule with `action: "suppress"` matched |

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

## Troubleshooting

**No notifications at all**
1. Set `"debug": true` — check that messages are reaching the plugin and what decision is being logged.
2. Verify `apprise_url` is reachable from the server: `curl -X POST <apprise_url> -H "Content-Type: application/json" -d '{"title":"test","body":"test"}'`.
3. Check TheLounge logs at startup for `[apprise-push] started` — if absent, the config file was not found or failed to parse.
4. If you see `→ skip (no_match)`, your rules don't match. The default rules only notify on highlights and PMs; add a broader rule if needed.

**Notifications fire but `{time}` shows the wrong timezone**
- Set `"timezone": "Your/Timezone"` using an [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). Invalid values fall back to the server's system timezone and a warning is logged at load time.

**Notifications stop after a while**
- If `cooldown` is set, check that enough time has passed. Debug output will show `→ skip (cooldown)`.
- Cooldown is per-context (per channel and per PM thread) and resets only when a notification is actually sent, not when messages are skipped.

**Hot-reload not working**
- Some network filesystems and container volume mounts don't deliver `fs.watch` events. In those cases, restart TheLounge after editing the config.
- If the new config has a JSON syntax error, the previous config is kept and an error is logged.

**Apprise request fails / retries exhausted**
- Increase `timeout` if your Apprise server is slow to respond.
- Check Apprise server logs for errors — the plugin logs the HTTP status code on failure.
- Use `"debug": true` to see individual attempt results.

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

See also:

- 🎨 **[thelounge-theme-chat](https://github.com/mbologna/thelounge-theme-chat)**: a warm, editorial light/dark theme (automatic light/dark, digest-style messages, pure CSS)

---

## License

[MIT](LICENSE) © Michele Bologna
