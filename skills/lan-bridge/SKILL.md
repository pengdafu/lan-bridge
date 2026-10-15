---
name: lan-bridge
description: >-
  Transfer files or request work between PC and Mac on the LAN via lanbridge CLI.
  Use when the user asks to send/pull/copy a file to/from Mac or PC, locate a file
  on the other machine, fetch from company GitLab via Mac, run a prompt job on the
  peer agent, 传到Mac, 从Mac拉, lanbridge, or cross-computer sync.
---

# lan-bridge

Shared LAN bridge. Prefer CLI; do not invent ad-hoc HTTP servers.

## Peers

- `pc` / `mac` (see `config.json`)
- Token handled by CLI

## Commands

```bash
lanbridge status
lanbridge peers
lanbridge doctor
lanbridge send <local_path> <peer>
lanbridge pull <peer>:<remote_relpath> [local_dir]
lanbridge locate <peer> <query>
lanbridge ask <peer> "<prompt>"
lanbridge gitlab <repo> <path> [--ref <branch>]
```

If not on PATH: `node %USERPROFILE%\lan-bridge\lanbridge.js ...` (Windows) or `node ~/lan-bridge/lanbridge.js ...` (Mac).

## When path is unknown

1. `lanbridge locate mac <name>` — peer searches and returns hits + optional first file
2. Or `lanbridge ask mac "Find and send <description>"` — peer agent CLI job

## GitLab (PC → Mac only)

PC cannot reach company GitLab. Always:

```bash
lanbridge gitlab group/repo path/to/file [--ref main]
```

This posts a `gitlab_fetch` job to Mac; Mac clones over SSH and publishes into inbox for pull-back.

## Reboot

Both sides must auto-start `daemon.js` + `worker.js`. Run `lanbridge doctor` after boot.
