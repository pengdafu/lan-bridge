#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function usage() {
  console.log(`lanbridge — PC<->Mac LAN bridge CLI v2

Usage:
  lanbridge status
  lanbridge peers
  lanbridge send <local_path> <peer> [--to <relpath>]
  lanbridge pull <peer>:<remote_relpath> [local_dir]
  lanbridge locate <peer> <query>
  lanbridge ask <peer> "<prompt>"
  lanbridge gitlab <repo> <path> [--ref <branch>] [--peer mac]
  lanbridge meet                 # check/register with agent hub
  lanbridge say <peer> <text> [--expect-reply]
  lanbridge inbox                # read unread agent mailbox (no wait)
  lanbridge watch [--timeout 60] # ONLY if human asked you to wait
  lanbridge doctor

Anti-deadlock: never both agents park. Prefer say+inbox over watch.
`);
}

function hubBase(cfg) {
  const host =
    cfg.hubHost ||
    (cfg.peers[cfg.hubRole || "pc"] && cfg.peers[cfg.hubRole || "pc"].host) ||
    "127.0.0.1";
  const port = cfg.hubPort || 8765;
  return `http://${host}:${port}`;
}

function request(method, urlStr, { headers = {}, body = null, outPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        if (outPath && res.statusCode >= 200 && res.statusCode < 300) {
          const ws = fs.createWriteStream(outPath);
          res.pipe(ws);
          ws.on("finish", () => resolve({ status: res.statusCode, headers: res.headers, file: outPath }));
          ws.on("error", reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      }
    );
    req.on("error", reject);
    if (body && typeof body.pipe === "function") {
      body.pipe(req);
    } else if (body != null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

function peerBase(cfg, name) {
  const p = cfg.peers[name];
  if (!p) throw new Error(`unknown peer: ${name}`);
  return `http://${p.host}:${p.port || cfg.port}`;
}

function authHeaders(cfg, extra = {}) {
  return { "X-Bridge-Token": cfg.token, ...extra };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postJob(cfg, peer, body) {
  const payload = JSON.stringify({ from: cfg.role, ...body });
  const r = await request("POST", `${peerBase(cfg, peer)}/v1/jobs`, {
    headers: authHeaders(cfg, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    }),
    body: payload,
  });
  if (!(r.status >= 200 && r.status < 300) || !r.json || !r.json.job) {
    throw new Error(`create job failed: ${r.status} ${JSON.stringify(r.json || r.body.toString("utf8"))}`);
  }
  return r.json.job;
}

async function waitJob(cfg, peer, id, timeoutSec) {
  const deadline = Date.now() + (timeoutSec || 600) * 1000;
  while (Date.now() < deadline) {
    const r = await request("GET", `${peerBase(cfg, peer)}/v1/jobs/${id}`, {
      headers: authHeaders(cfg),
    });
    const job = r.json && r.json.job;
    if (!job) throw new Error(`job poll failed: ${r.status}`);
    if (job.status === "done" || job.status === "error") return job;
    await sleep(1500);
  }
  throw new Error("job timeout");
}

async function pullResults(cfg, peer, job, localDir) {
  const outDir = localDir || path.join(ROOT, cfg.inbox || "inbox", "jobs", job.id);
  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  for (const rel of job.result_paths || []) {
    const url = `${peerBase(cfg, peer)}/v1/files/${encodeURI(rel.replace(/\\/g, "/"))}`;
    const outPath = path.join(outDir, path.basename(rel));
    const r = await request("GET", url, { headers: authHeaders(cfg), outPath });
    if (!(r.status >= 200 && r.status < 300)) {
      throw new Error(`pull result failed ${rel}: ${r.status}`);
    }
    saved.push(outPath);
  }
  return saved;
}

async function cmdStatus(cfg) {
  const local = await request("GET", `http://127.0.0.1:${cfg.port}/health`).catch((e) => ({
    error: String(e.message || e),
  }));
  console.log(
    JSON.stringify({ role: cfg.role, root: ROOT, config: CONFIG_PATH, localHealth: local.json || local }, null, 2)
  );
}

async function cmdPeers(cfg) {
  const out = {};
  for (const [name, p] of Object.entries(cfg.peers)) {
    const url = `http://${p.host}:${p.port || cfg.port}/health`;
    try {
      const r = await request("GET", url);
      out[name] = { host: p.host, port: p.port || cfg.port, ok: r.status === 200, health: r.json };
    } catch (e) {
      out[name] = { host: p.host, port: p.port || cfg.port, ok: false, error: String(e.message || e) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

async function cmdSend(cfg, args) {
  const localPath = args[0];
  const peer = args[1];
  if (!localPath || !peer) {
    usage();
    process.exit(1);
  }
  let toRel = path.basename(localPath);
  const toIdx = args.indexOf("--to");
  if (toIdx >= 0) toRel = args[toIdx + 1];
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`local file not found: ${abs}`);
  const size = fs.statSync(abs).size;
  const url = `${peerBase(cfg, peer)}/v1/files/${encodeURI(toRel.replace(/\\/g, "/"))}`;
  const r = await request("PUT", url, {
    headers: authHeaders(cfg, { "Content-Type": "application/octet-stream", "Content-Length": size }),
    body: fs.createReadStream(abs),
  });
  if (r.status >= 200 && r.status < 300) {
    console.log(JSON.stringify({ ok: true, peer, to: toRel, size, result: r.json }, null, 2));
  } else {
    console.error(JSON.stringify({ ok: false, status: r.status, result: r.json || r.body.toString("utf8") }, null, 2));
    process.exit(1);
  }
}

async function cmdPull(cfg, args) {
  const spec = args[0];
  const localDir = args[1] ? path.resolve(args[1]) : path.join(ROOT, cfg.inbox || "inbox");
  if (!spec || !spec.includes(":")) {
    usage();
    process.exit(1);
  }
  const idx = spec.indexOf(":");
  const peer = spec.slice(0, idx);
  const remoteRel = spec.slice(idx + 1);
  fs.mkdirSync(localDir, { recursive: true });
  const outPath = path.join(localDir, path.basename(remoteRel));
  const url = `${peerBase(cfg, peer)}/v1/files/${encodeURI(remoteRel.replace(/\\/g, "/"))}`;
  const r = await request("GET", url, { headers: authHeaders(cfg), outPath });
  if (r.status >= 200 && r.status < 300) {
    console.log(JSON.stringify({ ok: true, peer, remote: remoteRel, saved: outPath, size: fs.statSync(outPath).size }, null, 2));
  } else {
    let detail = null;
    try {
      detail = JSON.parse(fs.readFileSync(outPath, "utf8"));
      fs.unlinkSync(outPath);
    } catch {}
    console.error(JSON.stringify({ ok: false, status: r.status, detail }, null, 2));
    process.exit(1);
  }
}

async function cmdLocate(cfg, args) {
  const peer = args[0];
  const query = args.slice(1).join(" ");
  if (!peer || !query) {
    usage();
    process.exit(1);
  }
  const job = await postJob(cfg, peer, { type: "locate", query, timeout_sec: 120 });
  const done = await waitJob(cfg, peer, job.id, 120);
  const saved = done.status === "done" ? await pullResults(cfg, peer, done) : [];
  console.log(JSON.stringify({ ok: done.status === "done", job: done, saved }, null, 2));
  if (done.status !== "done") process.exit(1);
}

async function cmdAsk(cfg, args) {
  const peer = args[0];
  const prompt = args.slice(1).join(" ").replace(/^"|"$/g, "");
  if (!peer || !prompt) {
    usage();
    process.exit(1);
  }
  const job = await postJob(cfg, peer, { type: "agent_prompt", prompt, timeout_sec: 900 });
  const done = await waitJob(cfg, peer, job.id, 900);
  const saved = done.status === "done" ? await pullResults(cfg, peer, done) : [];
  console.log(JSON.stringify({ ok: done.status === "done", job: done, saved }, null, 2));
  if (done.status !== "done") process.exit(1);
}

async function cmdGitlab(cfg, args) {
  let peer = "mac";
  const peerIdx = args.indexOf("--peer");
  if (peerIdx >= 0) peer = args[peerIdx + 1];
  let ref = "main";
  const refIdx = args.indexOf("--ref");
  if (refIdx >= 0) ref = args[refIdx + 1];
  const filtered = args.filter((_, i) => i !== peerIdx && i !== peerIdx + 1 && i !== refIdx && i !== refIdx + 1);
  const repo = filtered[0];
  const repoPath = filtered[1];
  if (!repo || !repoPath) {
    usage();
    process.exit(1);
  }
  const job = await postJob(cfg, peer, {
    type: "gitlab_fetch",
    repo,
    ref,
    path: repoPath,
    timeout_sec: 600,
  });
  const done = await waitJob(cfg, peer, job.id, 600);
  const saved = done.status === "done" ? await pullResults(cfg, peer, done) : [];
  console.log(JSON.stringify({ ok: done.status === "done", job: done, saved }, null, 2));
  if (done.status !== "done") process.exit(1);
}

async function cmdMeet(cfg) {
  const url = `${hubBase(cfg)}/health`;
  try {
    const h = await request("GET", url);
    console.log(
      JSON.stringify(
        {
          ok: h.status === 200,
          hub: h.json,
          hubUrl: hubBase(cfg),
          tip: "Hub is mailbox+WS. Do not mutual-wait; use say/inbox.",
        },
        null,
        2
      )
    );
    if (h.status !== 200) process.exit(1);
  } catch (e) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(e.message || e),
          hint:
            cfg.role === (cfg.hubRole || "pc")
              ? "Start hub: node hub.js (or Startup script)"
              : `Ask ${cfg.hubRole || "pc"} to start hub on :${cfg.hubPort || 8765}`,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

async function cmdSay(cfg, args) {
  const peer = args[0];
  const expect = args.includes("--expect-reply");
  const text = args
    .slice(1)
    .filter((a) => a !== "--expect-reply")
    .join(" ")
    .trim();
  if (!peer || !text) {
    usage();
    process.exit(1);
  }
  const payload = JSON.stringify({
    from: cfg.role,
    to: peer,
    text,
    expect_reply: expect,
  });
  const r = await request("POST", `${hubBase(cfg)}/say`, {
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    body: payload,
  });
  console.log(JSON.stringify({ ok: r.status === 200, result: r.json, parked: false }, null, 2));
  if (r.status !== 200) process.exit(1);
  // Never park here — anti-deadlock
}

async function cmdInbox(cfg) {
  const r = await request("GET", `${hubBase(cfg)}/mailbox?for=${encodeURIComponent(cfg.role)}`);
  console.log(JSON.stringify(r.json || { ok: false, status: r.status }, null, 2));
  if (r.status !== 200) process.exit(1);
}

async function cmdWatch(cfg, args) {
  let timeout = 60;
  const tIdx = args.indexOf("--timeout");
  if (tIdx >= 0) timeout = Number(args[tIdx + 1] || 60);
  console.error(
    JSON.stringify({
      warning: "watch parks THIS agent only. Peer must NOT also watch. Prefer inbox.",
      timeout_sec: timeout,
    })
  );
  const deadline = Date.now() + timeout * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await request(
      "GET",
      `${hubBase(cfg)}/mailbox?for=${encodeURIComponent(cfg.role)}&since=${encodeURIComponent(last)}&mark=0`
    );
    const msgs = (r.json && r.json.messages) || [];
    if (msgs.length) {
      last = msgs[msgs.length - 1].ts;
      // mark by reading normally
      await request("GET", `${hubBase(cfg)}/mailbox?for=${encodeURIComponent(cfg.role)}`);
      console.log(JSON.stringify({ ok: true, messages: msgs }, null, 2));
      return;
    }
    await sleep(1500);
  }
  console.log(JSON.stringify({ ok: false, error: "watch timeout", tip: "Do not restart a peer watch loop" }, null, 2));
  process.exit(1);
}

async function cmdDoctor(cfg) {
  const report = { checks: [] };
  const push = (name, ok, detail) => report.checks.push({ name, ok, detail });
  push("config", fs.existsSync(CONFIG_PATH), CONFIG_PATH);
  push("inbox", fs.existsSync(path.join(ROOT, cfg.inbox || "inbox")), path.join(ROOT, cfg.inbox || "inbox"));
  try {
    const h = await request("GET", `http://127.0.0.1:${cfg.port}/health`);
    push("local_daemon", h.status === 200 && !!(h.json && h.json.jobs), h.json);
  } catch (e) {
    push("local_daemon", false, String(e.message || e));
  }
  try {
    const h = await request("GET", `${hubBase(cfg)}/health`);
    push("hub", h.status === 200, h.json);
  } catch (e) {
    push("hub", false, String(e.message || e));
  }
  for (const name of Object.keys(cfg.peers)) {
    if (name === cfg.role) continue;
    try {
      const p = cfg.peers[name];
      const h = await request("GET", `http://${p.host}:${p.port || cfg.port}/health`);
      push(`peer_${name}`, h.status === 200, h.json);
      if (h.status === 200) {
        const jr = await request("GET", `http://${p.host}:${p.port || cfg.port}/v1/jobs`, {
          headers: authHeaders(cfg),
        });
        push(`peer_${name}_jobs`, jr.status === 200, jr.json && { count: (jr.json.jobs || []).length });
      }
    } catch (e) {
      push(`peer_${name}`, false, String(e.message || e));
    }
  }
  report.ok = report.checks.every((c) => c.ok);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

async function main() {
  const cfg = loadConfig();
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    usage();
    process.exit(1);
  }
  switch (cmd) {
    case "status":
      await cmdStatus(cfg);
      break;
    case "peers":
      await cmdPeers(cfg);
      break;
    case "send":
      await cmdSend(cfg, args);
      break;
    case "pull":
      await cmdPull(cfg, args);
      break;
    case "locate":
      await cmdLocate(cfg, args);
      break;
    case "ask":
      await cmdAsk(cfg, args);
      break;
    case "gitlab":
      await cmdGitlab(cfg, args);
      break;
    case "meet":
      await cmdMeet(cfg);
      break;
    case "say":
      await cmdSay(cfg, args);
      break;
    case "inbox":
      await cmdInbox(cfg);
      break;
    case "watch":
      await cmdWatch(cfg, args);
      break;
    case "doctor":
      await cmdDoctor(cfg);
      break;
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    default:
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(String(e && e.stack ? e.stack : e));
  process.exit(1);
});
