# thelounge-plugin-apprise-push

A [TheLounge](https://thelounge.chat) server plugin that sends push notifications via the [Apprise](https://github.com/caronc/apprise) HTTP API.

Supports nick highlights, whole-channel monitoring, private messages, and fine-grained suppression — all configured through an ordered rule list.

---

## Requirements

- TheLounge ≥ 4.0
- A running [Apprise API](https://github.com/caronc/apprise/wiki/api_overview) server with a persistent notification configuration pre-loaded under a key (e.g. `chatnotifications`)

---

## Installation

1. **Install the plugin:**

   ```bash
   thelounge install thelounge-plugin-apprise-push
   ```

2. **Create the config file** at `~/.thelounge/apprise-push.json` (see [Configuration](#configuration) below).

3. **Restart TheLounge** to pick up the config.

---

## Configuration

All options go in `$THELOUNGE_HOME/apprise-push.json` (usually `~/.thelounge/apprise-push.json`).

### Apprise connection

| Key | Type | Description |
|---|---|---|
| `apprise_url` | string | Full Apprise API notify endpoint, e.g. `"http://apprise:8000/notify/chatnotifications"` |

The plugin POSTs `{ "title": "...", "body": "..." }` to this URL. The notification destinations are configured server-side in Apprise under the given key.

### Notification text

| Key | Default | Description |
|---|---|---|
| `title_pm` | `"PM from {nick} [{network}]"` | Title for private message notifications. |
| `title_chan` | `"[{network}] {channel}"` | Title for channel notifications. |
| `body` | `"{nick}: {message}"` | Notification body. |
| `body_length` | `100` | Truncate `{message}` to this many characters. `0` = unlimited. |

**Keyword expansion** — these placeholders are replaced in `title_pm`, `title_chan`, and `body`:

| Keyword | Value |
|---|---|
| `{channel}` | Channel name or sender nick (for PMs) |
| `{nick}` | Message sender |
| `{network}` | IRC network name |
| `{message}` | Message text (IRC formatting stripped, truncated to `body_length`) |

### Global pre-filters

These apply before any rule is evaluated. They are fast exits.

| Key | Default | Description |
|---|---|---|
| `away_only` | `false` | Only notify when **no** TheLounge browser tabs are connected. Equivalent to ZNC's away-only mode. |
| `cooldown` | `0` | Minimum seconds between two notifications for the same context (channel or PM). `0` = disabled. |
| `nick_blacklist` | `[]` | Glob patterns. Messages from matching nicks are silently dropped. E.g. `["*bot*", "ChanServ"]`. |
| `network_blacklist` | `[]` | Glob patterns. Messages from matching network names are silently dropped. |
| `highlight_words` | `[]` | Extra words/patterns that count as a highlight in addition to your own nick. Glob patterns accepted. |

### Rules

```json
"rules": [ <rule>, <rule>, ... ]
```

Rules are evaluated **in order**; the **first matching rule wins**. If no rule matches, no notification is sent.

Each rule is a JSON object. All specified conditions must be true (AND logic). If a rule has no conditions it matches everything.

#### Rule conditions

| Key | Type | Description |
|---|---|---|
| `channel` | string \| string[] | Glob pattern(s) for the channel name. If set, the rule only matches channel messages in a matching channel. |
| `pm` | boolean | `true` → only match private messages. `false` → only match channel messages. Omit to match both. |
| `highlight` | boolean | `true` → only match if the message contains your nick or a `highlight_words` entry. |
| `network` | string \| string[] | Glob pattern(s) for the network name. |
| `nick` | string \| string[] | Glob pattern(s) for the **sender** nick. |

#### Rule action

| Key | Default | Description |
|---|---|---|
| `action` | `"notify"` | `"notify"` sends a notification. `"suppress"` blocks and stops evaluation. |

Glob patterns support `*` (any sequence) and `?` (any single character), case-insensitive.

---

## Examples

### Default — highlights and PMs

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

### Multiple channels — all messages

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
  { "channel": "#dev",  "highlight": true },
  { "channel": "#ops",  "highlight": true },
  { "pm": true }
]
```

### Suppress a noisy channel before a catch-all

```json
"rules": [
  { "channel": "#random", "action": "suppress" },
  { "channel": "#*",      "highlight": true },
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
  { "network": "OFTC",   "highlight": true },
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

---

## Running Apprise API

The quickest way to run the Apprise API server:

```bash
docker run -p 8000:8000 caronc/apprise:latest
```

Load your notification URLs into Apprise under a key (e.g. `chatnotifications`) via the web UI or API, then set `apprise_url` to `"http://apprise:8000/notify/chatnotifications"`.

See the [Apprise wiki](https://github.com/caronc/apprise/wiki) for the full list of supported services (Telegram, Pushover, Slack, Discord, Gotify, ntfy, and many more).

---

## Debugging

Set `"debug": true` in the config. Each incoming message will log its evaluation result to TheLounge's stdout:

```
[apprise-push] chan "#dev" from "alice" hl=true → notify
[apprise-push] → "[Libera] #dev" / "alice: hey yourname, take a look"
[apprise-push] Apprise → HTTP 200
```

---

## Notes

- **`/me` actions** (`* nick does something`) are included as triggers. The action text is prefixed with `* nick` in the notification body.
- **Cooldown** is tracked independently per context (each channel and each PM thread has its own timer).
- **Reconnects** are handled automatically: the plugin re-attaches to a network's IRC connection on reconnection.
- The plugin has no npm dependencies beyond Node.js built-ins.
