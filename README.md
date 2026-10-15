# lan-bridge

Canonical PC↔Mac LAN bridge (shared codebase).

## Roles

- **File plane** (`:8766`): sandboxed inbox push/pull
- **Job plane** (same port): `locate` | `fetch_path` | `gitlab_fetch` | `agent_prompt`
- **Meet hub** (`:8765`, hosted by `hubRole`, default `pc`): WebSocket presence + **durable mailbox**
- **GitLab**: Mac only (SSH to `gitlab.futunn.com`). PC uses `lanbridge gitlab ...` which creates a job on Mac.

## Anti-deadlock

Agents must **not** both park waiting for WS replies.

- `lanbridge say` = fire-and-forget into mailbox
- `lanbridge inbox` = read unread (no wait)
- `lanbridge watch` = optional, **one side only**, only when human asks to wait
- Real work → `ask` / `locate` / `gitlab` jobs (poll job status, not mutual chat wait)

## Git remote (canonical)

- `https://github.com/pengdafu/lan-bridge.git`

```bash
git clone https://github.com/pengdafu/lan-bridge.git ~/lan-bridge
# or: git pull --rebase origin main
```

## Install (either machine)

```bash
# 1) Copy this tree to ~/lan-bridge (or %USERPROFILE%\lan-bridge)
# 2) cp config.example.json config.json   # edit role + peer IPs
# 3) mkdir -p inbox outbox logs work jobs-meta
# 4) npm install
# 5) Start daemon + worker (+ hub if you are hubRole)
node daemon.js
node worker.js
node hub.js   # only on hubRole machine (default pc)
# Windows helper: scripts\start-all.cmd
```

CLI:

```bash
node lanbridge.js status
node lanbridge.js peers
node lanbridge.js meet
node lanbridge.js say <peer> <text>
node lanbridge.js inbox
node lanbridge.js send <file> <peer>
node lanbridge.js pull <peer>:<relpath>
node lanbridge.js locate <peer> <query>
node lanbridge.js ask <peer> "<prompt>"
node lanbridge.js gitlab <repo> <path> [--ref main]
node lanbridge.js doctor
```

Quick two-agent link (no mutual wait):

1. PC (hubRole) runs `hub.js` (autostart).
2. Either agent: `lanbridge say <peer> "..."` then continue work / end turn.
3. Other agent (when human activates): `lanbridge inbox` and act.


## Auth

Header: `X-Bridge-Token: <token from config.json>`

## Sync rule

**This repo is the single source of truth.** Do not maintain a separate Python/Node fork on Mac/PC.
