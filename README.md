# lan-bridge

Canonical PC↔Mac LAN bridge (shared codebase).

## Roles

- **File plane** (`:8766`): sandboxed inbox push/pull
- **Job plane** (same port): `locate` | `fetch_path` | `gitlab_fetch` | `agent_prompt`
- **GitLab**: Mac only (SSH to `gitlab.futunn.com`). PC uses `lanbridge gitlab ...` which creates a job on Mac.

## Origin remote

- Repo: `futu/lan-bridge`
- Clone: `https://origin.cursor.com/futu/lan-bridge.git`

PC (Windows) cannot use Origin CLI yet — Mac should push/pull this remote after syncing from the zip bootstrap.

## Install (either machine)

```bash
# 1) Copy this tree to ~/lan-bridge (or %USERPROFILE%\lan-bridge)
# 2) cp config.example.json config.json   # edit role + peer IPs
# 3) mkdir -p inbox outbox logs work jobs-meta
# 4) Start daemon + worker (keep alive / LaunchAgent / Startup)
node daemon.js
node worker.js
```

CLI:

```bash
node lanbridge.js status
node lanbridge.js peers
node lanbridge.js send <file> <peer>
node lanbridge.js pull <peer>:<relpath>
node lanbridge.js locate <peer> <query>
node lanbridge.js ask <peer> "<prompt>"
node lanbridge.js gitlab <repo> <path> [--ref main]
node lanbridge.js doctor
```

## Auth

Header: `X-Bridge-Token: <token from config.json>`

## Sync rule

**This repo is the single source of truth.** Do not maintain a separate Python/Node fork on Mac/PC.
