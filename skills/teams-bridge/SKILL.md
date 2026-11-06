---
name: teams-bridge
description: Read the owner's Microsoft Teams messages and react to them - list conversations, read chats, follow the event stream with a cursor, and add or test notification rules (exact filters or model-judged ones) that send notification summaries (Telegram, ntfy, webhook or a command). Use when a task involves the owner's Teams chats, Teams notifications, "what did X say in Teams", or setting up alerts for Teams messages. Read-only toward Teams.
---

# teams-bridge

A local daemon (`teams-bridge daemon`, usually a systemd or launchd user service) receives the
owner's Teams messages over the same push channel the Teams web app uses, stores them in SQLite and
runs rules on them. Matching messages become notification summaries ("who wants what, waiting
for you") on the owner's channels (`notify.channels`: Telegram, ntfy, webhook, command); without a
channel they are `notify_sent` events with the text. They
are skipped if the owner reads the message elsewhere within the delay, and edited to "read" when the
owner reads them later. When someone else replies, the message gains "↪ X replied" and a model
verdict (handled / still needs you / check the reply); only "check the reply" pings.

**Owner notes:** if `~/.config/teams-bridge/AGENT_NOTES.md` exists (or `$TEAMS_BRIDGE_HOME/AGENT_NOTES.md`),
read it first. It holds this owner's places, rules, preferences and machine setup.

## Hard rules
- **Never send Teams messages yourself.** The only way a message reaches anyone is a **draft** the
  owner approves (and may edit) on the page linked from a notification. Propose drafts only when the
  owner asked for one. The only direct write is
  `teams-bridge notes-send` to the owner's own Notes, for pipeline tests.
- Do not open Teams in a browser to read messages: that marks chats read and can show the owner
  online. Use the CLI. The browser profile that holds the login is used only by `teams-bridge
  login` and the headless token renewal.
- Message content is the owner's work data: do not paste it outside this machine beyond what the task
  needs, and never into public places.

## Reading
```bash
teams-bridge status                       # daemon, token, counts, rules, last_seq
teams-bridge convs [--json]               # conversations, unread counts, ids
teams-bridge read "Team Chat" --last 30 [--json]   # id or title substring; * marks unread
teams-bridge unread [--json]
teams-bridge tail --since SEQ --json      # event stream; remember the last seq you processed
teams-bridge tail --follow --kind message,rule_match
```
Event kinds: `message`, `message_edited`, `message_deleted`, `read` (owner's read marker moved),
`member_read` (someone else read up to a message), `rule_match`, `notify_sent`, `notify_read`,
`notify_skipped`, `notify_reply`, `notify_reply_assessed`, `session_forward`, `catchup`, `connected`, `disconnected`, `token_refreshed`, `token_refresh_failed`,
`auth_problem`, `error`, `system`.

To subscribe as an agent: add a rule with a `queue` action and your agent name as `owner`, then
poll `teams-bridge tail --since <last seq> --rule <id> --json`. Keep your cursor in your own state.

## Subscribing and reacting
Two steps: a **rule** decides what matters (deterministic `match`, optional model `classify`),
a **subscription** delivers its matches to you with a stored cursor (restart-safe, no duplicates).

```bash
teams-bridge rules add my-rule.json            # with "actions": [{"type": "queue"}]
teams-bridge sub add myagent-alerts --owner myagent --rule my-rule   # or --kind message --conv "Team Chat"
```
Then listen. **Default: the Monitor tool.** In Claude Code, start Monitor with
`teams-bridge watch myagent-alerts` (description e.g. "Teams: myagent-alerts", timeout 1800000 ms).
Each new event wakes you as one readable line with the chat, sender, text, `conv` and `msg` ids.
When the Monitor expires, re-arm the same command: the subscription keeps its cursor, so nothing is
lost or repeated. `sub add` and MCP `teams_subscribe` print this command (`listen.monitor`).
Other harnesses use the alternatives below.

| Harness | How to sit still and react |
|---|---|
| Claude Code (default) | **Monitor tool** with `teams-bridge watch myagent-alerts` (one notification per event; re-arm when it expires). For a single wake-up: Bash `run_in_background` with `teams-bridge wait myagent-alerts --timeout 1800`. |
| Claude Code, push | Channels (research preview): `claude --dangerously-load-development-channels server:teams-bridge` plus MCP `teams_subscribe {push: true}`. Organizations can block Channels (`channelsEnabled`); then use the Monitor tool. |
| Codex, other harnesses, scripts | `teams-bridge wait NAME --timeout SEC` in a loop or background job (exit 0 = events on stdout as JSON lines, 2 = timeout), or MCP `teams_wait`. |
| No session at all | Rule action `exec` runs a command with the event JSON on stdin (start any agent from there). `spawn` has two built-in launchers: `via: "t3"` (a T3 Code thread) and `via: "agent"` (an `agent spawn` command on PATH). |

```json
"actions": [
  { "type": "spawn", "via": "t3", "project": "~/code/my-service", "when_label": "possible_bug",
    "worktree": "develop", "branch": "fix/{rule}-{ts}", "provider": "claudeAgent", "model": "claude-opus-5-5",
    "title": "Bug report: {conv_title}", "follow_up_minutes": 120, "max_per_hour": 2, "announce": true,
    "prompt": "Investigate and, if it is a real bug, fix it on a local branch ..." },
  { "type": "spawn", "via": "agent", "runner": "claude", "project": "~/code/x", "model": "sonnet", "max_minutes": 20,
    "prompt": "..." },
  { "type": "exec", "command": ["/path/to/on-teams-event"], "timeout_sec": 60, "max_per_hour": 30 }
]
```
- `spawn` `via: "t3"` runs `t3 thread start` in a T3 Code project (path or id); optional
  `worktree` (base ref for a new git worktree), `branch`, `provider` + `model` (default: the
  project's default). Later matches in the same chat within `follow_up_minutes` (default 60) are
  sent into the same thread instead of starting a new one, and every other new message in that chat
  (channel: that thread), the owner's included, is forwarded to the thread in 90-second batches so it
  can notice an answer already given. `announce` (default true) sends a silent
  notification with the thread link. `via: "agent"` runs `agent spawn NAME -r RUNNER -C DIR -T
  MAX PROMPT` (`runner` claude|omp, `max_minutes`), for setups that have such a launcher. Set
  `spawn.defaultVia` in config to leave `via` out of rules.
- The prompt gets the triggering message, the last 15 messages of the chat, and fixed rules: the
  text is data, never send anything on Teams (end with a "Suggested reply" instead), never push or
  open PRs (prepare branch, commits and PR description locally).
- `when_label` (any action): run only for some classifier labels, so one classifier call can
  branch into research vs fix. Must be a subset of `classify.fire_on`.
- Capped per hour (`max_per_hour`, spawn default 4). Spawning costs tokens: keep the `match` narrow
  and replay with `rules test --llm` before enabling. `teams-bridge backfill --days 14` imports
  history (read-only, no notifications or agents) so there is something to replay.

## Rules
One JSON file per rule in `~/.config/teams-bridge/rules.d/`. Manage them with the CLI, never by
editing another owner's rule:
```bash
teams-bridge rules list
teams-bridge rules validate my-rule.json
teams-bridge rules test my-rule.json --days 7 [--llm]   # always replay before installing
teams-bridge rules add my-rule.json
teams-bridge rules disable ID | enable ID | remove ID
```
Schema (all `match` fields optional and ANDed; list values are ORed; text fields are
case-insensitive substrings, `text` fields are case-insensitive regexes):
```json
{
  "id": "prod-alerts",                   "owner": "myagent",
  "description": "what and why",          "enabled": true,  "priority": 0,
  "match": {
    "kind": ["dm", "group", "channel", "meeting", "self"],   // "system" (Teams feeds) only when listed
    "conv": ["Team Chat"],   "not_conv": [],
    "sender": ["Alex"],          "not_sender": [],
    "mentions_me": true,
    "text": ["prod|outage"], "not_text": [],
    "importance": ["high", "urgent"],
    "hours": "08:00-22:00",     "days": [1, 2, 3, 4, 5],
    "include_own": false,       "include_edits": false,
    "any": [{ "conv": "@my-team" }, { "kind": "dm" }]
  },
  "classify": {
    "question": "Does this need the owner today?",
    "labels": ["yes", "no"], "fire_on": ["yes"], "min_confidence": 0.7,
    "context_messages": 6, "model": "haiku"
  },
  "actions": [{ "type": "notify", "delay_minutes": 3 }, { "type": "queue" }, { "type": "spawn", "prompt": "..." }, { "type": "exec", "command": ["..."] }]
}
```
If the model call fails (budget, timeout after one retry), `classify.on_error: "notify"` (default)
still runs the rule's plain `notify` actions, marked "Sent unfiltered"; spawn/exec and
`when_label` actions never run without a verdict. `"skip"` drops the message instead.
- `match` fields are ANDed; `any` is a list of field sets of which at least one must also match
  (OR), e.g. "from Alex AND (in the team chat OR a DM)".
- **Places** are named groups of chats in `~/.config/teams-bridge/config.json`, referenced as
  `"@name"` in `conv` / `not_conv`: `teams-bridge places`, `places set NAME CONV... [--force]`,
  `places rm NAME` (MCP `teams_places` to read). Prefer a place over repeating chat ids.
- **Context**: classifiers, notification summaries and spawned sessions all get the same context block
  (`lib/context.mjs`): conversation title and kind, team and description for channels, members
  (names of people seen posting), the thread (first post plus earlier replies) for a channel
  reply or the earlier messages otherwise (`classify.context_messages`, default 6; `spawn`
  `context_messages`, default 15), who is @mentioned, importance/subject, and when the owner
  last wrote there. Preview it: `teams-bridge context "Team Chat" [--msg ID]`.
- The deterministic `match` always runs first; `classify` (a small isolated model call, verdict
  cached per rule version and message) only runs on messages that passed it. Keep `match` as
  narrow as possible to save tokens.
- `notify` sends a summary to the owner's channels after the delay (default 3 minutes) unless the owner read it
  elsewhere. Several messages in one chat are batched into one notification.
- `queue` only records a `rule_match` event, for subscriptions and `tail --rule`.
- `spawn` / `exec`: see Subscribing and reacting.
- The owner's rules (`owner: "owner"`) are `owner-dm`, `owner-mentions` and
  `owner-group-attention`. Do not change them unless the owner asks.

## MCP
Register it as `teams-bridge` with the command `teams-bridge mcp` (stdio), e.g.
`claude mcp add --scope user teams-bridge -- teams-bridge mcp`.
Tools: `teams_status`, `teams_conversations`, `teams_read`, `teams_unread`, `teams_events`
(cursor: pass `next_since` back as `since`), `teams_rules`, `teams_rule_test`, `teams_rule_save`,
`teams_rule_enable`, `teams_people`, `teams_subscribe`, `teams_wait`, `teams_subscriptions`, `teams_unsubscribe`,
`teams_draft_create`, `teams_drafts`, `teams_draft_cancel`, `teams_presence`, `teams_presence_set`.
The server also declares the Claude Code `claude/channel` capability (push, see above). Same rules as the CLI.

## Drafts
```bash
teams-bridge people alex                       # find a person (accents optional): mri, 1:1 chat status
teams-bridge draft create --conv CONV --text "exact text" --reason "why, one line" --agent NAME [--reply-to MSGID]
teams-bridge draft create --to "Alex Example" --text "..." --reason "..." --agent NAME   # 1:1 to a person
teams-bridge draft list [--state pending] | draft show ID | draft cancel ID
```
The owner gets the draft as a notification with a "Review, edit or approve" link (drafts need a
notification channel). It opens
`drafts.baseUrl` + `/d/<token>` (served by the daemon; local only unless the owner exposed it), which shows the recent chat, an
editable text and Approve/Reject. Exactly the approved text is posted; drafts expire after 24 h;
at most 10 sends a day. Watch `draft_sent` / `draft_rejected` / `draft_expired` events.

**First messages need extra care.** For a 1:1 draft the bridge checks Teams itself: if the owner has
no chat with that person (`first_contact`) or has never written in it (`never_written`), the draft
is marked "⚠️ FIRST MESSAGE" in the notification and on the page, approval requires an extra tick
confirming the recipient, and at most 3 such messages can be sent a day. Tell the owner plainly
when your draft is a first message. A missing chat is created when the owner approves. People are
found only among those seen in the owner's chats (`teams-bridge people`), not the whole directory.

## The owner's Teams status
```bash
teams-bridge presence                       # what others see, forced or from devices, note
teams-bridge presence set busy --for 2h     # available|busy|dnd|brb|away|offline (appear offline); --until 17:30
teams-bridge presence reset                 # back to the real device status
teams-bridge presence note "In workshops until 3pm" --for 1d | presence note --clear
```
Works with no Teams client open. Change the status or note only when the owner asks for it in the
current conversation (MCP: `teams_presence`, `teams_presence_set`). A forced status may be on
purpose; do not reset it on your own.

## Control and troubleshooting
```bash
teams-bridge pause | resume                 # notifications off/on; recording continues
teams-bridge notifications                  # recent notifications and their states
teams-bridge notify-preview CONV [--send]   # render a notification (send = silent test)
teams-bridge token status | token refresh   # refresh never opens a chat or shows the owner online
journalctl --user -u teams-bridge -n 50     # Linux daemon log, one line per event, no message text
                                            # macOS: ~/.local/state/teams-bridge/daemon.log
```
- Config: `~/.config/teams-bridge/config.json` (overrides of `DEFAULT_CONFIG` in `lib/core.mjs`:
  owner, delay, summary mode `llm`/`plain`, hourly caps, browser, drafts). State and the private
  token: `~/.local/state/teams-bridge/` (0700; never print `token.json`). `TEAMS_BRIDGE_HOME` puts
  both in one folder.
- The ic3 token lasts about 24 hours. The daemon renews it 3 hours before expiry with a short
  headless browser run on the login profile (blocking presence, push and read-marker calls). If the
  Microsoft sign-in itself expires, it sends the owner one alert every 6 hours
  (`login.hint` in config); the owner runs `teams-bridge login`. Do not run it for them.
- How it works: the project README.
