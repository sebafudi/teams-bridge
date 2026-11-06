# teams-bridge

Your Microsoft Teams messages, for you and your agents, without installing anything in the Teams
tenant, without polling Teams, and without making you look online.

A small daemon receives your messages over the same push channel the Teams web app uses, stores
them in SQLite and runs rules on them:

- **Notifications**: messages that matter (DMs, @mentions, group messages a model judges to need
  you) become one-line summaries on Telegram, ntfy, a webhook or any command you choose, after a
  short delay. They are skipped if you read the message in Teams meanwhile, marked "read" when you
  read it later, and updated when someone else answers ("↪ Alex replied: looks handled").
- **Agents**: a CLI and an MCP server to read chats, follow an event stream with a cursor, and
  subscribe to rule matches; rule actions can start agent sessions or run commands.
- **Drafts, never direct sends**: agents can only propose a message; you approve or edit it on a
  page linked from a notification.

It never sends "active" signals, never registers presence and never moves your read markers, so
your status and unread counts come only from your real devices.

> **Unofficial.** This uses the internal endpoints of the Teams web client with your own sign-in
> token. Microsoft does not document or support them, they can change without notice, and your
> organization's policies may not allow tools like this. Check before you use it at work. It is
> read-only toward Teams except for messages you approve yourself.

## Requirements

- macOS or Linux, Node.js 24 or newer (built-in `node:sqlite` and `WebSocket`; no npm packages).
- Chrome, Chromium, Edge or Brave, for the sign-in and the daily token renewal (headless).
- Optional: the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI (`claude`, signed
  in) for summaries and model-judged rules; without it, rules with `classify` notify unfiltered.
- Optional: a notification channel (Telegram, ntfy, webhook or a command); without one,
  notifications are events for agents.

## Quick start

```bash
git clone https://github.com/sebafudi/teams-bridge && cd teams-bridge
./install.sh                 # copies to ~/.local/lib/teams-bridge, links ~/.local/bin/teams-bridge,
                             # installs a systemd (Linux) or launchd (macOS) user service
teams-bridge login           # a browser window opens on Teams: sign in once, it closes by itself
teams-bridge status
```

Then start the service as `install.sh` printed (`systemctl --user enable --now teams-bridge` on
Linux, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.sebafudi.teams-bridge.plist`
on macOS), or run `teams-bridge daemon` in a terminal. Running `./install.sh` again updates the
code and restarts the service.

**Notifications** (optional): pick one or more channels, see [Notification channels](#notification-channels).
`teams-bridge notify-test` checks them.

**Agents**: copy `skills/teams-bridge` to your agent's skills folder (e.g. `~/.claude/skills/`),
and register the MCP server: `claude mcp add --scope user teams-bridge -- teams-bridge mcp`.

## Configuration

Everything lives in your home folder, outside the code:

| What | Where |
|---|---|
| Settings | `~/.config/teams-bridge/config.json` (see `config.example.json`) |
| Rules | `~/.config/teams-bridge/rules.d/*.json` (defaults from `rules.example/`) |
| Telegram credentials (if you use it) | `~/.config/teams-bridge/telegram.env`, or `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in the environment |
| Notes for your agents | `~/.config/teams-bridge/AGENT_NOTES.md` (optional; the skill tells agents to read it) |
| Token, database, logs | `~/.local/state/teams-bridge/` (0700; the token file is 0600) |
| Browser profile with the Teams login | `~/.local/state/teams-bridge/browser-profile` |

`XDG_CONFIG_HOME` / `XDG_STATE_HOME` are respected. `TEAMS_BRIDGE_HOME=/some/dir` puts everything in
one folder (config at the top, state in `state/`).

`config.json` only needs what you change. The main settings (defaults in `lib/core.mjs`):

| Key | Default | Meaning |
|---|---|---|
| `owner.name`, `owner.about` | name from your sign-in, empty | how model prompts refer to you; `about` is one line of context ("backend developer on the payments team") |
| `notify.delayMinutes` | 3 | wait before notifying; skipped if you read it meanwhile |
| `notify.summary` | `llm` | `plain` sends no message text and makes no model call |
| `notify.maxPerHour` | 20 | hard cap |
| `notify.channels` | `telegram` if configured, else none | `telegram`, `ntfy`, `webhook`, `command`; several are allowed |
| `llm.command`, `llm.model` | `claude`, `haiku` | model CLI and model |
| `llm.maxCallsPerHour` | 200 | budget for live traffic (rule replays have their own, 300) |
| `browser.path` | found automatically | Chrome/Chromium/Edge binary |
| `browser.profile` | state folder | browser profile with the Teams login |
| `browser.cdpPort` | none | use an already running browser with this profile and `--remote-debugging-port` |
| `login.hint` | `Run: teams-bridge login` | text of the "sign-in needed" alert, e.g. a link to a remote desktop |
| `drafts.host`, `drafts.port`, `drafts.baseUrl` | `127.0.0.1`, 6095, derived | approval pages |
| `spawn.defaultVia` | none | `t3` or `agent`, for rules that leave out `spawn.via` |
| `places` | `{}` | named groups of chats for rules (`"@team"`) |

## Notification channels

Notifications are written once and sent to every channel in `notify.channels`. Channels that can
edit a message (Telegram, webhook, command) also get the later updates: "↪ X replied" with a
verdict, and "read in Teams". Without any channel, notifications are `notify_sent` events with
their text, for agents that subscribe; drafts then cannot be proposed, because the approval link
would reach nobody.

**Telegram**: create a bot with @BotFather, send it a message, then put the token and your chat id
in `~/.config/teams-bridge/telegram.env` (mode 600). Another program can keep polling the same bot.

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

**ntfy** (push to the [ntfy](https://ntfy.sh) phone and desktop apps, no account needed):

```json
{ "notify": { "channels": ["ntfy"], "ntfy": { "topic": "a-long-random-name-only-you-know" } } }
```

Anyone who knows a topic on the public ntfy.sh server can read it, and summaries describe your work
messages. Use a long random topic, a self-hosted server (`url`, `token`), or `notify.summary: "plain"`.
ntfy messages are not updated later.

**Webhook** (Slack/Discord/Home Assistant bridges, your own server):

```json
{ "notify": { "channels": ["webhook"], "webhook": { "url": "https://example.com/teams", "headers": { "Authorization": "Bearer ..." } } } }
```

**Command** (anything else; argv, no shell):

```json
{ "notify": { "channels": ["command"], "command": { "argv": ["node", "/path/to/teams-bridge/examples/notify-desktop.mjs"] } } }
```

`examples/notify-desktop.mjs` shows desktop notifications (macOS Notification Center, Linux
`notify-send`).

Webhook and command both receive this JSON (POST body or stdin):

```json
{ "event": "send", "ref": null, "reply_to": null, "silent": false,
  "text": "💬 Team Chat · group chat\nFrom: Alex\nAsks whether the refund job can be rerun today.\n...",
  "html": "💬 <b>Team Chat</b> · group chat\n...",
  "buttons": [{ "text": "Review, edit or approve", "url": "http://127.0.0.1:6095/d/..." }] }
```

`event` is `send` or `edit`. Answer a `send` with JSON `{"id": "..."}` (response body or the last
line on stdout) to receive that id as `ref` with later edits of the same message, and as
`reply_to` for follow-ups (the ⚠️ "a reply may need you" ping). A command must exit 0 within 30
seconds; a webhook must answer 2xx within 20 seconds.

### Remote machine, no screen

The daemon is happy on a headless server. Only `teams-bridge login` needs a window: run it once
where you can see a browser (a remote desktop or VNC session on that machine), or point
`browser.profile` and `browser.cdpPort` at a browser you already keep signed in there.

## How Teams delivers messages (and how this copies it)

Measured in the Teams web client (v2, `teams.cloud.microsoft`, November 2026):

1. MSAL in the page holds tokens per API. The one that matters is the **ic3** token
   (`aud https://ic3.teams.office.com`, app `5e3ce6c0-...` = Teams web), valid about **24 hours**.
   It authorizes the chat service, the registrar and the push channel.
2. The client opens a WebSocket to **Trouter** (`wss://go.trouter.teams.microsoft.com/v4/c?...`),
   a socket.io v0.9-style protocol: server `1::`, client `5:::{"name":"user.authenticate",...}`
   with the bearer, server `trouter.connected` with its push URL (`surl`), reconnect URL and
   `connectparams`. Pings are `5:N+::{"name":"ping"}`.
3. It **registers** that push URL with `POST /registrar/prod/V2/registrations`
   (template `TeamsCDLWebWorker_2.7`, TTL 3600 s, renewed hourly).
4. The server then pushes `3:::{id, method, url: .../messaging, body}` frames; each gets a
   `3:::{id, status: 200}` ack. Bodies are chat service events: `NewMessage` (full message,
   sender, mentions), `ConversationUpdate` (with the owner's **consumption horizon**: the last
   message the owner read, synced across all devices), `ThreadActivity/MemberConsumptionHorizonUpdate`
   (someone else read up to a message), typing notices, thread updates.
5. On (re)connect the server reports `trouter.message_loss`; the client then reads the chats once.

What the web client does that this does **not**: send `user.activity {"state":"active"}` on the
socket, register a presence endpoint (`PUT /ups/.../me/endpoints`), subscribe to presence, open
chats (which moves the read marker). So the owner's presence and read state come only from their
real devices.

Normal traffic: one socket with a ping every 30 s, one registration per 50 min, one conversation
list call per reconnect (at most every 10 min), and a title lookup the first time a chat is seen.

## Conversation ids

Chats and meetings are `19:...@thread.v2` / `19:meeting_...`, 1:1 chats `19:<a>_<b>@unq.gbl.spaces`,
channels `19:...@thread.tacv2`. Channel replies arrive as `<channel>;messageid=<root post id>`; the
bridge stores the channel as the conversation and the root as `reply_to`. `48:notes` is the owner's
Notes chat; other `48:` ids (`48:notifications`, `48:mentions`) are Teams' own feeds, kind
`system`, ignored by rules unless a rule lists `system`.

## Token renewal

`lib/token-refresh.mjs` opens Teams once in a new tab of a browser that already runs with the login
profile and remote debugging (`browser.cdpPort`), otherwise in a headless Chromium/Chrome/Edge on
that profile (normal user agent, because Teams rejects `HeadlessChrome`). Before the app starts it removes the cached ic3 access token, so MSAL
fetches a new one with its refresh token and the Microsoft session cookies. While the page loads,
CDP `Fetch` blocks every presence, push channel, registrar and read-marker URL and every write that
is not sign-in. The first ic3 bearer the app sends is saved to `~/.local/state/teams-bridge/token.json`
(0600) and the tab is closed, usually within 10 seconds. The daemon runs this 3 hours before
expiry; if Microsoft wants an interactive login, the owner gets an alert (`login.hint`) and
runs `teams-bridge login`, which does the same in a visible window.

## Pipeline

```
Trouter push ─► engine.ingest ─► SQLite (messages, convs, read markers, events)
                     │
                     └► rules: deterministic match ─► optional model classifier (cached) ─► actions
                                                                                  │
                    notify: wait delayMinutes ─► skip if read elsewhere ─► summary to the channels
                                                 ├► edit when someone else replies (model verdict)
                                                 └► edit to "read" when the read marker passes it
```

- Replies: when someone other than the people in a notification answers in the same chat (in a
  channel: the same thread), the notification records it and, about a minute later, a model call
  judges the replies: ✅ looks handled, 👀 still needs you, ⚠️ check the reply (looks wrong, risky,
  or promises something on the owner's behalf), ❔ not sure. The notification is edited silently
  with "↪ X replied" and the verdict; only ⚠️ sends a short threaded ping. Events: `notify_reply`,
  `notify_reply_assessed`.

- Rules: JSON in `~/.config/teams-bridge/rules.d/`; defaults in `rules.example/` (DMs, @mentions,
  and group messages a model judges to need the owner).
- Model calls: `claude -p` with no tools, settings, MCP or session, structured output, and two
  hourly budgets (live traffic, and rule replays, so a replay never starves live classification). Used for rule classifiers and the one-sentence summary (`notify.summary: "plain"`
  turns summaries off).
- Channels: `lib/notify.mjs` (Telegram uses only `sendMessage` and `editMessageText`, so another
  program can keep polling the same bot undisturbed).

## Files

| Path | What |
|---|---|
| `lib/daemon.mjs` | Trouter client, registration, reconnects, timers |
| `lib/engine.mjs` | ingest, catch-up, rules evaluation, notification lifecycle |
| `lib/rules.mjs` | rule schema, validation, matching |
| `lib/llm.mjs` | classifier and summary calls |
| `lib/teams.mjs` | token, chat service calls, message normalization |
| `lib/token-refresh.mjs` | ic3 token renewal through Chromium + CDP |
| `lib/notify.mjs`, `lib/telegram.mjs` | notification channels (Telegram, ntfy, webhook, command) |
| `examples/notify-desktop.mjs` | command channel example: desktop notifications |
| `lib/drafts.mjs` | drafts, approval page server |
| `lib/spawn.mjs` | event -> T3 Code thread or `agent spawn` run |
| `lib/context.mjs` | the context block every model sees (conversation, team, members, thread, mentions) |
| `lib/presence.mjs` | read and set the owner's status and note |
| `lib/api.mjs`, `lib/mcp.mjs` | shared operations, MCP server |
| `lib/cli.mjs`, `bin/teams-bridge` | CLI |
| `bin/teams-bridge` | CLI wrapper (finds Node 24) |
| `install.sh` | copies to `~/.local/lib/teams-bridge`, links the CLI, installs the systemd/launchd service and default rules |
| `skills/teams-bridge/SKILL.md` | agent skill: how agents read, subscribe and propose drafts |
| `test/offline.sh` | scenario tests |

## Subscriptions and reactions

Rules decide what matters; subscriptions deliver it. A subscription (`subscriptions` table) is a
named cursor over the event log filtered by rule ids, event kinds and/or conversations; reading
advances the cursor, so consumers survive restarts without duplicates. Delivery fits each harness:
`teams-bridge watch NAME` streams one line per event (Claude Code's Monitor tool, `tail`-style
consumers), `teams-bridge wait NAME` blocks until something arrives and exits (background jobs in
any harness), MCP `teams_wait` long-polls, and the MCP server declares Claude Code's experimental
`claude/channel` capability so `teams_subscribe {push: true}` or `teams-bridge mcp --channel NAME`
pushes events as `notifications/claude/channel` (Claude Code Channels research preview; needs
`--dangerously-load-development-channels server:teams-bridge` in an interactive session).
Without any live session, rule actions react directly: `exec` runs an argv command with the event
JSON on stdin (start whatever agent you use from there), and `spawn` has two built-in launchers:
a T3 Code thread (`t3 thread start` with the newest `~/.t3/runtime/versions/*/t3`, follow-ups in
the same chat go to the same thread via `t3 thread send`, and any other new messages there, the
owner's included, are forwarded in 90-second batches so the session can see that someone already
answered and adjust; event `session_forward`) or an `agent spawn` command on PATH. All are capped per hour,
and `when_label` lets one classifier call branch into different actions (research vs bug fix).

## Drafts and approval

Agents never post. `draft create` (CLI or MCP) stores a draft and sends the owner a
notification with a link (a URL button on Telegram) to `<drafts.baseUrl>/d/<token>`, served by the daemon (on 127.0.0.1 unless
`drafts.host` says otherwise; to approve from a phone, bind it to a private network such as a VPN
and set `baseUrl`, never to the public internet). Drafts need a notification channel. The page shows the latest messages of the chat, an editable text and
Approve/Reject. The token is 144 random bits; the form also carries a per-draft nonce; approval
claims the draft atomically (no double send); exactly the approved text is posted; drafts expire
after 24 hours; at most 10 are sent per day. URL buttons are used instead of callback buttons so
the bot's update stream stays free for other programs. The approval page is a guard against
mistakes, not a sandbox: anything running as your user can read the database. `lib/teams.mjs` has only two write paths:
`sendToOwnNotes` and `postApprovedDraft`.

## Status (presence)

The token refresh also keeps the **presence** token (`aud https://presence.teams.microsoft.com/`,
about 20 hours; renewal follows whichever token expires first). `lib/presence.mjs` uses the same
calls as the Teams status menu: `POST {ups}/presence/getpresence/` to read, `PUT
{ups}/me/forceavailability/` with `{availability, activity, desiredExpirationTime?}` to force a
status (`Offline`/`OffWork` is "Appear offline"), `PUT {ups}/me/publishnote` for the note.
There is no delete for a forced status on this API (DELETE and empty values are rejected), so
`presence reset` re-applies the current one with an expiry five seconds away.

## People and first messages

`people` holds everyone seen sending a message (mri, name, where last seen); search ignores
accents. The directory itself is not searched. A 1:1 conversation id is deterministic:
`19:<oid>_<oid>@unq.gbl.spaces` with the two object ids sorted. A draft with `to` resolves the
person, then asks Teams whether that chat exists and whether any of the owner's messages are in it
(`GET` conversation, then up to 100 messages). No chat (`first_contact`) or none of the owner's
messages (`never_written`) marks the draft, adds a warning to the notification and the page, requires a
confirmation tick, and counts against `drafts.maxFirstContactsPerDay` (3). On approval a
missing chat is created with `POST /v1/threads` (two members, `uniquerosterthread`) if posting to
the deterministic id is refused. That creation path has not been exercised yet, because no
real first message has been sent through it.

## MCP

`teams-bridge mcp` is a dependency-free stdio MCP server (newline-delimited JSON-RPC) over
`lib/api.mjs`: status, conversations, read, unread, events with a cursor, rules list/test/save/enable,
drafts create/list/cancel, presence. Register it with `claude mcp add --scope user teams-bridge -- teams-bridge mcp`
(or the equivalent for your harness).

## Not built (on purpose, for now)

- Attachments, reactions, reply threads beyond what the push carries.

## Tests

`test/offline.sh` runs scenario tests (notification, reply verdict, read edit, unfiltered fallback,
command channel, no channel)
in a throwaway `TEAMS_BRIDGE_HOME` with a fake token and the default rules, with Telegram in dry-run
mode (`TEAMS_BRIDGE_TG_DRY=1` prints instead of sending). It makes a few real model calls through
the Claude Code CLI and never touches Teams or Telegram.
