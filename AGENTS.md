# Notes for agents working on this repo

This is a public repository. Anything committed here is published.

## Commits and pushing
- Commits are single-line Conventional Commits (`type(scope): summary`), with no AI attribution.
- Push to `origin main` after every commit, without asking first. You must pass the leak check below before each push.
- Don't force-push or rewrite published history unless the owner asks.

## Leak check (before every commit and push)
Real configuration and data live outside the repo, under `~/.config/teams-bridge` and `~/.local/state/teams-bridge` (or `$TEAMS_BRIDGE_HOME`). Never copy anything from those directories into the repo.

The diff must not contain any of the following:
- Tokens, cookies, API keys, bot tokens, chat ids, or anything taken from `token.json`, `.env` files or the browser profile.
- Real people, tenants, companies, teams, channels or conversation ids. Message text from a real Teams account also counts, including anything in test fixtures, examples and commit messages. Use made-up names such as `Alice Example`.
- Personal or work email addresses, internal hostnames, private or tailnet IPs, or machine-specific paths. The only exceptions are the generic `~/` and XDG paths.
- Wording tied to the owner's own setup, such as VNC, agent desktops or a particular host. Keep the docs generic: users may run this on a laptop with a different setup.

Check with:

```sh
git diff --cached | grep -nEi 'eyJ[a-z0-9_-]{10,}|bot[0-9]{6,}:|@(gmail|outlook|hotmail)\.|[0-9]+:[a-z0-9-]+@thread|8:orgid:[0-9a-f]{8}-|(100|10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]+\.[0-9]+|/home/[a-z]'
```

Review every hit, and also read the full diff yourself. The pattern can't spot names or message content. If you're unsure, don't push: ask the owner.

The commit author email must be the GitHub noreply address (`git config user.email`).

## Tests
`bash test/offline.sh` runs the offline scenarios in a temporary `TEAMS_BRIDGE_HOME`. Run it before each push.
