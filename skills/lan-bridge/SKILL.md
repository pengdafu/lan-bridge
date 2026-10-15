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

## Anti-deadlock (agent meet) — MUST follow

Today's failure mode: **both agents park waiting for each other**.

Rules:

1. **Hub is infrastructure** (`hub.js` on `hubRole`, default PC `:8765`). Agents do not "hold the line" for each other.
2. **Default: fire-and-forget.** `lanbridge say <peer> <text>` writes mailbox and returns. **Do not wait.**
3. **Peer reads later:** when that side's human/agent is active, run `lanbridge inbox` (or human says check messages).
4. **Never start `lanbridge watch` on both sides.** `watch` only if **this** human explicitly says "等对方回复", with `--timeout`, then stop.
5. `--expect-reply` only marks that the peer *should* answer when free — **sender still must not park**.
6. Prefer **jobs** (`ask` / `locate` / `gitlab`) for real work; use meet/say only for short coordination.

## Meet / mailbox

```bash
lanbridge meet
lanbridge say mac "please pull GitHub and restart worker"
lanbridge inbox
# ONLY if human asked to wait:
lanbridge watch --timeout 90
```

Hub URL comes from config: `hubRole` + that peer's host + `hubPort` (8765).

## File / jobs

```bash
lanbridge send <path> <peer>
lanbridge pull <peer>:<relpath>
lanbridge locate <peer> <query>
lanbridge ask <peer> "<prompt>"
lanbridge gitlab <repo> <path> [--ref main]
lanbridge doctor
```

GitLab only via Mac (`gitlab_fetch` job).

## Reboot

PC Startup should run `scripts/start-all.cmd` (daemon + worker + hub).  
Mac LaunchAgents: daemon + worker; hub only if `hubRole=mac` (normally PC hosts hub).
