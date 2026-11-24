# thelounge-plugin-apprise-push

[![npm version](https://img.shields.io/npm/v/thelounge-plugin-apprise-push.svg)](https://www.npmjs.com/package/thelounge-plugin-apprise-push)
[![CI](https://github.com/mbologna/thelounge-plugin-apprise-push/actions/workflows/ci.yml/badge.svg)](https://github.com/mbologna/thelounge-plugin-apprise-push/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/thelounge-plugin-apprise-push.svg)](https://www.npmjs.com/package/thelounge-plugin-apprise-push)
[![license](https://img.shields.io/npm/l/thelounge-plugin-apprise-push.svg)](LICENSE)
[![node](https://img.shields.io/node/v/thelounge-plugin-apprise-push.svg)](package.json)

thelounge-plugin-apprise-push is a server plugin for [The Lounge](https://thelounge.chat/)
that sends IRC highlights and private messages to an
[Apprise API](https://github.com/caronc/apprise-api) server, which delivers them to
Telegram, Pushover, ntfy, Gotify, Slack, Discord or any other of Apprise's services. It
runs inside The Lounge, so notifications arrive with no browser tab open.

An ordered list of rules decides which messages notify. A rule matches on channel,
network, sender, message text, message type, highlight or private message, and can
override the title, body, priority, cooldown, batching window and Apprise endpoint.
Around the rules sit a per-channel cooldown, a global rate limit, an away-only mode, nick
and network blacklists, a mute file and batching for busy channels. Failed sends are
retried with backoff and can fall back to other Apprise instances. The configuration is
one JSON file, reloaded when it changes. The plugin uses only Node.js built-ins.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Examples](#examples)
- [Running Apprise API](#running-apprise-api)
- [Mute and snooze](#mute-and-snooze)
- [Metrics](#metrics)
- [Debugging](#debugging)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Development](#development)
- [Why not an existing tool](#why-not-an-existing-tool)
- [Versioning](#versioning)
- [Related projects](#related-projects)
- [Licence](#licence)

## Requirements

- The Lounge 4.0 or later
- Node.js 18 or later
- An [Apprise API](https://github.com/caronc/apprise/wiki/api_overview) server with a
  saved notification configuration under a key, such as `chatnotifications`

## Installation

1. Install the plugin:

   ```bash
   thelounge install thelounge-plugin-apprise-push
   ```

2. Create `apprise-push.json` in The Lounge's home (see [Configuration](#configuration)).
   [`apprise-push.example.json`](apprise-push.example.json) is a starting point.

3. Restart The Lounge once to load the plugin. Later changes to the configuration apply
   without a restart.

## Configuration

All options go in `$THELOUNGE_HOME/apprise-push.json`, usually
`~/.thelounge/apprise-push.json`. The file is watched: an edit applies within a second. If
the new file is not valid JSON, the plugin keeps the previous configuration and logs an
error. Unknown keys and values of the wrong type are logged as warnings when the file
loads, and a bad value falls back to its default.

### Apprise connection

| Key           | Type   | Description                                                                             |
| ------------- | ------ | --------------------------------------------------------------------------------------- |
| `apprise_url` | string | Full Apprise API notify endpoint, e.g. `"http://apprise:8000/notify/chatnotifications"` |

The plugin POSTs `{ "title": "...", "body": "..." }`, plus `"priority"` when one is set,
to this URL. Apprise sends it to the services configured under the key. The URL, here and
in rules, must use `http://` or `https://`; any other scheme is rejected with a warning
and nothing is sent to it. Without `apprise_url` at startup the plugin stays inactive.

### Authentication

Optional, for an Apprise API behind authentication or a reverse proxy.

| Key               | Type   | Default | Description                                                                |
| ----------------- | ------ | ------- | -------------------------------------------------------------------------- |
| `apprise_token`   | string | `""`    | Sent as `Authorization: Bearer <token>`.                                   |
| `apprise_headers` | object | `{}`    | Arbitrary extra HTTP headers. Overrides the bearer header on key conflict. |

```json
"apprise_headers": { "Authorization": "Basic dXNlcjpwYXNz", "X-Source": "thelounge" }
```

A header value that is not a string is ignored with a warning. With an `Authorization`
header and an `http://` `apprise_url`, the plugin warns that the credential travels in
plain text.

### Fallback instances

| Key                      | Type  | Default | Description                                                                                                                                                                                                                                                                   |
| ------------------------ | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apprise_fallback_bases` | array | `[]`    | Base URLs of other Apprise instances serving the same keys, e.g. `["http://apprise-2:8000"]`. When a send fails, each is tried on the same `/notify/<key>` path (rule URLs included) before the next retry, so one instance being down loses nothing. Same token and headers. |

### Config-error alerts

| Key         | Type   | Default           | Description                                                                                                       |
| ----------- | ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `alert_key` | string | `"system-alerts"` | Apprise key that is told when Apprise answers a notification with a client error (4xx). `""` turns the alert off. |

A 4xx means Apprise was reached and refused the request: the key has no configuration
(`404`), the token is wrong (`401`/`403`), or the service behind the key refused the
message (`424`). Retrying won't fix any of these, so the plugin:

1. does not retry (the fallback instances are still tried once);
2. logs an error naming the endpoint and the status, on every failed notification, with or
   without `debug`;
3. sends a `warning` to `alert_key`, at most once every 24 hours per The Lounge process.
   The alert goes to the failing URL with its last path segment replaced (`/notify/irc` →
   `/notify/system-alerts`), then to the same path on each fallback instance, with the
   same token and headers. It is sent once, without retries, and a failed alert is only
   logged.

A 4xx on one instance is reported even when a fallback instance then delivers, since the
key is still broken there. `408` and `429` are not config errors: they are retried like a
timeout or a `5xx`. Network errors and `5xx` keep the retry-then-log behaviour below and
send no alert. Nothing is sent about the alert key itself.

### Delivery tuning

| Key           | Type   | Default | Description                                                                                                                                                                                   |
| ------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout`     | number | `10000` | Milliseconds before a single Apprise request is aborted.                                                                                                                                      |
| `retries`     | number | `2`     | Extra attempts after the first on transient failure (timeout, 5xx, 408, 429, network). `0` disables retries. Other 4xx answers are [config errors](#config-error-alerts) and are not retried. |
| `retry_delay` | number | `500`   | Base backoff in ms; it doubles on each attempt (`500 → 1000 → 2000 …`).                                                                                                                       |

After the last attempt the notification is dropped and the error logged.

### Notification text

| Key           | Default                        | Description                                                                                                                                                                     |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title_pm`    | `"PM from {nick} [{network}]"` | Title template for private message notifications.                                                                                                                               |
| `title_chan`  | `"[{network}] {channel}"`      | Title template for channel notifications.                                                                                                                                       |
| `body`        | `"{nick}: {message}"`          | Notification body template.                                                                                                                                                     |
| `body_length` | `100`                          | Truncate `{message}` to this many characters. `0` = unlimited.                                                                                                                  |
| `priority`    | `null`                         | Notification priority passed to Apprise. `null` = omit. Accepts a number or `"min"` / `"low"` / `"normal"` / `"high"` / `"max"`. Honoured by Pushover, ntfy, Gotify and others. |
| `timezone`    | `""`                           | IANA time zone for the `{time}` placeholder, e.g. `"America/New_York"`. Empty = the system time zone.                                                                           |

These placeholders work in `title_pm`, `title_chan`, `body` and the per-rule `title` and
`body`. An unknown placeholder is left as written, so a typo shows in the notification.

| Placeholder | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| `{channel}` | Channel name, or the sender's nick for a private message             |
| `{nick}`    | Message sender                                                       |
| `{network}` | IRC network name                                                     |
| `{mynick}`  | Your own nick on that network                                        |
| `{time}`    | Time the message was received, in `timezone`                         |
| `{message}` | Message text with IRC formatting removed, truncated to `body_length` |

A `/me` action notifies like a message, with its text prefixed by `* nick`. `body_length`
counts characters as people read them, so an emoji at the cut is never split.

### Global pre-filters

The first five run before any rule, in the order listed, and no rule can override them.
`cooldown`, `digest_window` and `highlight_words` are global defaults used once a rule
matches.

| Key                 | Default | Description                                                                                                                                                                                                                                        |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignore_services`   | `true`  | Skip private messages from network services: NickServ, ChanServ, MemoServ, OperServ, HostServ, BotServ, SaslServ and the comma-separated nicks in the `THELOUNGE_SERVICE_NICKS` environment variable. Channel messages from them are not affected. |
| `away_only`         | `false` | Only notify when **no** The Lounge browser tab is connected, like ZNC's away-only mode.                                                                                                                                                            |
| `nick_blacklist`    | `[]`    | Glob patterns. Messages from matching nicks are dropped. E.g. `["*bot*", "root"]`.                                                                                                                                                                 |
| `network_blacklist` | `[]`    | Glob patterns. Messages from matching network names are dropped.                                                                                                                                                                                   |
| `max_per_minute`    | `0`     | Global cap on notifications sent across **all** channels and private messages in a rolling 60-second window. `0` = disabled. Use it with `cooldown` against bursts when many channels highlight at once.                                           |
| `cooldown`          | `0`     | Minimum seconds between two notifications for the same channel or private message. `0` = disabled. Checked when a rule matches; a rule can override it.                                                                                            |
| `digest_window`     | `0`     | Seconds to batch messages for the same channel or private message into one notification. `0` = send at once. A rule can override it. See [Digest mode](#digest-mode-for-a-busy-channel).                                                           |
| `highlight_words`   | `[]`    | Extra words or glob patterns that count as a highlight besides your nick, matched anywhere in the text: `prod*` matches "production".                                                                                                              |

A [mute file](#mute-and-snooze) is checked before all of them. Your nick counts as a
highlight when it appears as a word, as in The Lounge itself: the nick `al` highlights
"al: ping" and "thanks @al", not "also".

`ignore_services` uses the same list as
[thelounge-patched](https://github.com/mbologna/thelounge-patched), whose
service-queries patch sends these messages to the server window instead of a query
window and reads the same `THELOUNGE_SERVICE_NICKS`. The plugin reads the variable from
The Lounge's process, so set it once on the container or service. A `nick@server`
sender, such as `Q@CServe.quakenet.org`, matches by its nick.

### Rules

```json
"rules": [ <rule>, <rule>, ... ]
```

Rules are evaluated **in order** and the **first matching rule wins**. If no rule
matches, no notification is sent. The default is
`[{ "highlight": true }, { "pm": true }]`: highlights and private messages.

A rule is a JSON object. All its conditions must hold; a rule with no conditions matches
every message. Glob patterns accept `*` (any sequence) and `?` (any one character) and
ignore case.

#### Rule conditions

| Key            | Type               | Description                                                                                                                                                                                               |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel`      | string \| string[] | Glob pattern(s) for the channel name. If set, the rule only matches channel messages in a matching channel.                                                                                               |
| `pm`           | boolean            | `true` → only private messages. `false` → only channel messages. Omit to match both.                                                                                                                      |
| `highlight`    | boolean            | `true` → only messages that contain your nick or a `highlight_words` entry.                                                                                                                               |
| `network`      | string \| string[] | Glob pattern(s) for the network name.                                                                                                                                                                     |
| `nick`         | string \| string[] | Glob pattern(s) for the **sender** nick.                                                                                                                                                                  |
| `contains`     | string \| string[] | Glob pattern(s) matched anywhere in the message text, after IRC formatting is removed. One match is enough. E.g. `["*deploy*", "*alert*"]`. Patterns match substrings: `"*down*"` matches "shutdown" too. |
| `message_type` | string             | `"privmsg"` → only regular messages, `"action"` → only `/me` actions. Omit to match both.                                                                                                                 |

#### Rule action and overrides

| Key             | Default    | Description                                                                                                                                                                               |
| --------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action`        | `"notify"` | `"notify"` sends a notification. `"suppress"` stops evaluation and sends nothing.                                                                                                         |
| `title`         | _(global)_ | Title template for this rule. Omit to use `title_pm` (private messages) or `title_chan` (channels).                                                                                       |
| `body`          | _(global)_ | Body template for this rule. Omit to use the global `body`.                                                                                                                               |
| `cooldown`      | _(global)_ | Cooldown in seconds for messages this rule matches. `0` always notifies. The timer restarts on each notification sent; skipped messages don't restart it.                                 |
| `priority`      | _(global)_ | Priority for this rule; same values as the global `priority`.                                                                                                                             |
| `apprise_url`   | _(global)_ | Send this rule's notifications to another Apprise endpoint or key. Validated like the global one. Token, headers, `timeout`, `retries`, `retry_delay` and fallback instances stay global. |
| `digest_window` | _(global)_ | Batching window in seconds for this rule. `0` always sends at once.                                                                                                                       |

Put `suppress` rules before catch-all `notify` rules, and specific conditions before
broad ones.

## Examples

### Highlights and private messages (the default)

```json
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

### Every message in a channel

```json
"rules": [
  { "channel": "#announcements" },
  { "highlight": true },
  { "pm": true }
]
```

### Every message in several channels

```json
"rules": [
  { "channel": ["#announcements", "#alerts", "#ops"] },
  { "highlight": true },
  { "pm": true }
]
```

### Highlights only in some channels

```json
"rules": [
  { "channel": "#dev", "highlight": true },
  { "channel": "#ops", "highlight": true },
  { "pm": true }
]
```

### A custom template for one rule

```json
"rules": [
  { "channel": "#alerts", "title": "🚨 ALERT [{network}]", "body": "{nick}: {message}" },
  { "highlight": true },
  { "pm": true }
]
```

### A noisy channel suppressed before a catch-all

```json
"rules": [
  { "channel": "#random", "action": "suppress" },
  { "channel": "#*", "highlight": true },
  { "pm": true }
]
```

### Bots silenced everywhere

```json
"nick_blacklist": ["*bot*", "root"],
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

`nick_blacklist` is a pre-filter, so no rule can override it. To silence a bot in one
channel only, use a `suppress` rule with `nick` and `channel`. Services are already
skipped in private messages by `ignore_services`.

### A rule per network

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

`prod*` matches "production", "prod-alert" and so on.

### Keyword alerts in a channel

```json
"rules": [
  { "channel": "#ops", "contains": ["*down*", "*alert*", "deploy*"] },
  { "highlight": true },
  { "pm": true }
]
```

Any message in `#ops` containing "down" or "alert", or starting with "deploy", notifies,
on top of the usual highlights and private messages.

### Per-rule cooldown: a throttled channel, private messages always through

```json
"rules": [
  { "pm": true, "cooldown": 0 },
  { "channel": "#general", "highlight": true, "cooldown": 300 },
  { "highlight": true }
]
```

Private messages always notify at once. Highlights in `#general` notify at most once
every 5 minutes. Other highlights use the global `cooldown`.

### Only `/me` actions

```json
"rules": [
  { "channel": "#dev", "message_type": "action" },
  { "highlight": true },
  { "pm": true }
]
```

In `#dev` only actions notify (`* alice pushes to main`), not regular messages.
Highlights and private messages work as usual.

### Priority for a critical channel

```json
"priority": "low",
"rules": [
  { "channel": "#incidents", "contains": "*CRITICAL*", "priority": "high" },
  { "highlight": true },
  { "pm": true }
]
```

Notifications are low priority, except messages in `#incidents` containing "CRITICAL",
which are high.

### A global rate limit

```json
"max_per_minute": 10,
"rules": [
  { "highlight": true },
  { "pm": true }
]
```

However many channels highlight at once, at most 10 notifications go out in any
60 seconds. Combine it with `cooldown` for a per-channel limit too.

### Digest mode for a busy channel

```json
"digest_window": 30,
"rules": [
  { "channel": "#general" },
  { "pm": true, "digest_window": 0 },
  { "highlight": true }
]
```

The first message matched in `#general` starts a 30-second window. Every message the
rule matches there before it ends goes into one notification, titled with the count
(`[Libera] #general (12 messages)`) and listing the first 20 messages followed by
`… and N more`. A batch counts once against `max_per_minute`. Private messages set
`digest_window` back to `0` and notify at once; other highlights use the global window.

Batches are held in memory: a batch that hasn't been sent is lost when The Lounge stops.
A batch whose window ends while notifications are muted is dropped.

### A channel routed to another Apprise endpoint

```json
"apprise_url": "https://apprise.example.com/notify/general",
"rules": [
  { "channel": "#incidents", "apprise_url": "https://apprise.example.com/notify/oncall", "priority": "high" },
  { "highlight": true },
  { "pm": true }
]
```

`#incidents` goes to a separate Apprise key, for example one wired to a pager or SMS
service; everything else uses the default `apprise_url`.

### Apprise behind an authenticating proxy

```json
"apprise_url": "https://apprise.example.com/notify/chatnotifications",
"apprise_token": "s3cr3t-bearer-token",
"timeout": 5000,
"retries": 3
```

## Running Apprise API

The quickest way to run the Apprise API server:

```bash
docker run -p 8000:8000 caronc/apprise:latest
```

Save your notification URLs in Apprise under a key, such as `chatnotifications`, through
its web interface or API, then set `apprise_url` to
`"http://apprise:8000/notify/chatnotifications"`. The
[Apprise wiki](https://github.com/caronc/apprise/wiki) lists the supported services.

## Mute and snooze

A file named `apprise-push.mute` next to the configuration
(`$THELOUNGE_HOME/apprise-push.mute`) silences all notifications without editing
`apprise-push.json`. It is watched like the configuration, so a change applies within a
second.

| File content                                       | Effect                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| _(no file)_                                        | Not muted.                                                           |
| _(empty file)_                                     | Muted until the file is removed.                                     |
| A number, e.g. `30`                                | Muted for that many **minutes** from when the file was last written. |
| An ISO 8601 timestamp, e.g. `2026-10-08T06:00:00Z` | Muted until that time.                                               |

```bash
# Snooze for 30 minutes
echo 30 > ~/.thelounge/apprise-push.mute

# Mute until the file is removed
touch ~/.thelounge/apprise-push.mute

# Resume now
rm ~/.thelounge/apprise-push.mute
```

The plugin reads the file again on every change and at startup. A snooze counts from the
file's modification time, so restarting The Lounge doesn't extend it. The log says when a
mute starts, when a snooze ends and when the file is removed. While muted, every message
is skipped with `→ skip (muted)` in the debug log, before any other filter or rule runs.

## Metrics

The plugin counts outcomes in memory: `notified`, `suppressed`, `skipped` and
`sendFailed`. The counters reset when The Lounge restarts. With `"debug": true` it logs them
every 5 minutes:

```
[apprise-push] metrics: { notified: 42, suppressed: 3, skipped: 118, sendFailed: 1 }
```

There is no metrics endpoint or export. The counters answer questions such as whether
Apprise is failing or the rules match nothing.

## Debugging

With `"debug": true` in the configuration, the plugin logs each message's outcome to The
Lounge's standard output:

```
[apprise-push] chan "#dev" from "alice" hl=true → notify
[apprise-push] → "[Libera] #dev" / "alice: hey yourname, take a look"
[apprise-push] Apprise http://apprise:8000 → HTTP 200

[apprise-push] chan "#general" from "bob" hl=false → skip (cooldown)
[apprise-push] chan "#random" from "eve" hl=false → skip (no_match)
[apprise-push] PM "dave" from "dave" hl=false → skip (away_only)
[apprise-push] PM "NickServ" from "NickServ" hl=false → skip (service)
[apprise-push] chan "#spam" from "bot" hl=false → suppress (rule)
```

| Output                       | Meaning                                                  |
| ---------------------------- | -------------------------------------------------------- |
| `→ notify`                   | A rule matched and a notification was sent or batched    |
| `→ skip (muted)`             | `apprise-push.mute` is present and in effect             |
| `→ skip (service)`           | A private message from a service, with `ignore_services` |
| `→ skip (away_only)`         | `away_only` is on and a browser tab is connected         |
| `→ skip (nick_blacklist)`    | The sender matched `nick_blacklist`                      |
| `→ skip (network_blacklist)` | The network matched `network_blacklist`                  |
| `→ skip (rate_limit)`        | `max_per_minute` was reached in this 60-second window    |
| `→ skip (cooldown)`          | Within the cooldown for this channel or private message  |
| `→ skip (no_match)`          | No rule matched                                          |
| `→ suppress (rule)`          | A rule with `"action": "suppress"` matched               |

## Troubleshooting

### No notifications at all

1. Set `"debug": true` and check that messages reach the plugin and what it decides.
2. Check that `apprise_url` is reachable from the server:
   `curl -X POST <apprise_url> -H "Content-Type: application/json" -d '{"title":"test","body":"test"}'`.
3. Look for `[apprise-push] started` in The Lounge's log at startup. Without it, the
   configuration file was missing, failed to parse or had no `apprise_url`.
4. `→ skip (no_match)` means no rule matched. The default rules notify only on highlights
   and private messages; add a broader rule if needed.

### A service's private messages no longer notify

`ignore_services` is on by default. Set `"ignore_services": false` to notify for them
again, for example for MemoServ's new-memo messages.

### `{time}` shows the wrong time zone

Set `"timezone"` to an
[IANA time zone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). An
invalid name falls back to the system time zone, with a warning when the file loads.

### Notifications stop after a while

With `cooldown` set, the debug log shows `→ skip (cooldown)` until enough time has
passed. The cooldown is per channel and per private message, and restarts only when a
notification is sent.

### Changes to the configuration are ignored

Some network file systems and container volume mounts don't deliver `fs.watch` events;
restart The Lounge after editing. If the new file has a JSON syntax error, the plugin
keeps the previous configuration and logs an error.

### Apprise requests fail after the retries

Raise `timeout` if the Apprise server is slow to answer, and check its logs. The plugin
logs the HTTP status of the failure; `"debug": true` logs every attempt.

### `Apprise answered HTTP 404 for …` in the log

The key in that URL has no configuration on that Apprise instance. Add it in Apprise, or
fix the key in `apprise_url` (or the rule's `apprise_url`). With `apprise_fallback_bases`,
every instance needs the key. `401` or `403` points at `apprise_token` or
`apprise_headers`. The first such error of the day also goes to `alert_key`
(`system-alerts` by default); if that key is missing too, the log shows
`could not send the config-error alert`.

## How it works

The Lounge's plugin API (`onServerStart`) has no per-message hook and no access to the
connected clients and networks. To receive messages, the plugin wraps
`Network.prototype.createIrcFramework`, which The Lounge calls once per network
connection, and attaches a `message` listener to the irc-framework client it creates,
before any message can arrive. It attaches again on every reconnect, and wraps the
method only once per process. Notices and messages from the server are ignored.

This depends on an internal, undocumented part of The Lounge. If the module or method is
missing, the plugin logs an error and stays inactive; The Lounge keeps running. After
upgrading The Lounge, if notifications stop, look in its startup log for
`[apprise-push] network.js not found in module cache — plugin inactive` or
`[apprise-push] Network.prototype.createIrcFramework not found — plugin inactive`.

## Development

```bash
npm install          # development tools (ESLint, Prettier)
npm test             # node:test unit tests
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # what CI runs
```

The code is in small modules under [`lib/`](lib), each with its tests in `test/`:
`config.js` (defaults, glob compilation, validation, the service list), `highlight.js`,
`rules.js` (pre-filters and rules), `template.js` (placeholders and truncation),
`apprise.js` (HTTP delivery, retries, fallbacks, alerts), `digest.js` (batching),
`mute.js` (the mute file) and `metrics.js` (counters). [`index.js`](index.js) connects
them to The Lounge.

## Why not an existing tool

- The Lounge's built-in Web Push sends a browser or PWA notification to each subscribed
  device. It has no rules, templates, cooldown or nick blacklist, and can't deliver
  through Apprise (to Telegram and others) with fallback instances.
- [thelounge-plugin-ntfy](https://github.com/cy1der/thelounge-plugin-ntfy) sends to ntfy,
  not Apprise, and has a single maintainer.

Checked 2026-11-23.

## Versioning

Releases follow SemVer: [auto-release](https://github.com/mbologna/auto-release) tags
`vX.Y.Z` from the Conventional Commit types on `main` (`feat` minor; `fix`, `perf`,
`revert` patch; a breaking change major) on Monday's scheduled CI run, or a manual run.
The tag starts `publish.yml`, which sets the package version from the tag
(`npm version`) and publishes it to npm with Trusted Publishing. The tag decides the
version; `version` in `package.json` is brought up to the latest release by hand, so a
release that forgets it still publishes the right version. See the
[versioning standard](https://github.com/mbologna/.github/blob/main/VERSIONING.md).

## Related projects

- [thelounge-patched](https://github.com/mbologna/thelounge-patched): the official The
  Lounge image with fixes waiting to land upstream, including the service-queries patch
  that `ignore_services` matches.
- [thelounge-digest](https://github.com/mbologna/thelounge-digest): a scheduled digest of
  chosen channels from The Lounge's logs, sent through Apprise.
- [thelounge-theme-chat](https://github.com/mbologna/thelounge-theme-chat): a light and
  dark theme for The Lounge with message grouping and coloured nick avatars.

## Licence

[MIT](LICENSE) © Michele Bologna
