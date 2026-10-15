---
name: lan-bridge
description: >-
  Transfer files or request work between PC and Mac on the LAN via lanbridge CLI,
  and meet the peer agent via hub mailbox. Use when the user asks to send/pull
  files, locate on the other machine, fetch company GitLab via Mac, ask the peer
  agent, 连线Mac/PC, meet, lanbridge, or cross-computer sync.
---

# lan-bridge

Shared LAN bridge. Prefer CLI. Do not invent ad-hoc servers.

## How to invoke (IMPORTANT)

Agents often have a short PATH. **Do not assume `lanbridge` is on PATH.**

Prefer one of these (in order):

```bash
# 1) Absolute wrapper (Mac after install)
/Users/admin/lan-bridge/lanbridge <cmd> ...
# or portable:
"$HOME/lan-bridge/lanbridge" <cmd> ...

# 2) Direct node entry (always works if node is available)
cd "$HOME/lan-bridge" && node lanbridge.js <cmd> ...

# Windows
%USERPROFILE%\lan-bridge\lanbridge.cmd <cmd> ...
# or:
cd %USERPROFILE%\lan-bridge && node lanbridge.js <cmd> ...
```

Optional: ensure `~/bin` (symlink to the wrapper) is on PATH for interactive shells.

## Anti-deadlock (agent meet) — MUST follow

Today's failure mode: **both agents park waiting for each other**.

Rules:

1. **Hub is infrastructure** (`hub.js` on `hubRole`, default PC `:8765`). Agents do not "hold the line" for each other.
2. **Default: fire-and-forget.** `say` writes mailbox and returns. **Do not wait.**
3. **Peer reads later:** when that side's human/agent is active, run `inbox`.
4. **Never start `watch` on both sides.** `watch` only if **this** human explicitly says "等对方回复", with `--timeout`, then stop.
5. `--expect-reply` only marks that the peer *should* answer when free — **sender still must not park**.
6. Prefer **jobs** (`ask` / `locate` / `gitlab`) for real work; use meet/say only for short coordination.

## Meet / mailbox

```bash
"$HOME/lan-bridge/lanbridge" meet
"$HOME/lan-bridge/lanbridge" say mac "please pull GitHub and restart worker"
"$HOME/lan-bridge/lanbridge" inbox
# ONLY if human asked to wait:
"$HOME/lan-bridge/lanbridge" watch --timeout 90
```

Hub URL comes from config: `hubRole` + that peer's host + `hubPort` (8765).

## File / jobs

```bash
"$HOME/lan-bridge/lanbridge" send <path> <peer>
"$HOME/lan-bridge/lanbridge" pull <peer>:<relpath>
"$HOME/lan-bridge/lanbridge" locate <peer> <query>
"$HOME/lan-bridge/lanbridge" ask <peer> "<prompt>"
"$HOME/lan-bridge/lanbridge" gitlab <repo> <path> [--ref main]
"$HOME/lan-bridge/lanbridge" doctor
```

GitLab only via Mac (`gitlab_fetch` job).

## Paths

- Code root: `~/lan-bridge` (Windows: `%USERPROFILE%\lan-bridge`)
- Skill copy: `~/.cursor/skills/lan-bridge/SKILL.md` (keep in sync with `skills/lan-bridge/SKILL.md` in repo)
- Config: `~/lan-bridge/config.json` (local, not committed)

## Reboot

PC Startup should run `scripts/start-all.cmd` (daemon + worker + hub).  
Mac LaunchAgents: daemon + worker; hub only if `hubRole=mac` (normally PC hosts hub).
