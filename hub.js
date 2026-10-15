#!/usr/bin/env node
"use strict";
/**
 * Agent meet hub — WebSocket presence + durable mailbox.
 * Anti-deadlock: agents MUST NOT both park waiting for each other.
 * Default chat is fire-and-forget into mailbox; only poll/watch when human asks.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

let WebSocketServer;
try {
  ({ WebSocketServer } = require("ws"));
} catch {
  console.error("Missing dependency: ws. Run: npm install ws");
  process.exit(1);
}

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const MAILBOX = path.join(ROOT, "mailbox.jsonl");
const CURSOR_DIR = path.join(ROOT, "mailbox-cursors");
const LOG_PATH = path.join(ROOT, "logs", "hub.log");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, msg);
  } catch {}
  process.stdout.write(msg);
}

function appendMail(entry) {
  fs.mkdirSync(path.dirname(MAILBOX), { recursive: true });
  fs.appendFileSync(MAILBOX, JSON.stringify(entry) + "\n");
}

function readMailSince(sinceTs, forRole) {
  if (!fs.existsSync(MAILBOX)) return [];
  const lines = fs.readFileSync(MAILBOX, "utf8").trim().split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (sinceTs && m.ts <= sinceTs) continue;
    if (forRole && m.to && m.to !== forRole && m.to !== "*") continue;
    if (forRole && m.from === forRole && m.to !== forRole) {
      // still include own sends optionally? skip for inbox view
      if (m.to && m.to !== forRole) continue;
    }
    out.push(m);
  }
  return out;
}

function cursorPath(role) {
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  return path.join(CURSOR_DIR, `${role}.json`);
}

function getCursor(role) {
  try {
    return JSON.parse(fs.readFileSync(cursorPath(role), "utf8")).since || "";
  } catch {
    return "";
  }
}

function setCursor(role, since) {
  fs.writeFileSync(cursorPath(role), JSON.stringify({ since, updatedAt: new Date().toISOString() }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const cfg = loadConfig();
const PORT = cfg.hubPort || 8765;
const hubRole = cfg.hubRole || "pc";

/** @type {Map<string, import('ws').WebSocket>} */
const peers = new Map();
/** @type {WeakMap<import('ws').WebSocket, object>} */
const meta = new WeakMap();

function wsSend(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function deliverChat(msg) {
  appendMail(msg);
  if (msg.to && peers.has(msg.to)) {
    wsSend(peers.get(msg.to), msg);
  } else if (!msg.to || msg.to === "*") {
    for (const [, ws] of peers) wsSend(ws, msg);
  }
  // turn bookkeeping hint for clients (not enforced as lock)
  if (msg.expect_reply) {
    wsSend(peers.get(msg.to), {
      type: "turn",
      holder: msg.to,
      from: msg.from,
      timeout_sec: msg.timeout_sec || 120,
      note: "ONLY you should answer. Sender must NOT park. Default: no mutual wait.",
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        role: "hub",
        hubRole,
        port: PORT,
        online: [...peers.keys()],
        antiDeadlock:
          "Mailbox is source of truth. Agents must not both park. expect_reply only transfers turn to peer; sender stays idle unless human says wait.",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/peers") {
      sendJson(res, 200, {
        online: [...peers.entries()].map(([role, ws]) => ({
          role,
          ...meta.get(ws),
          readyState: ws.readyState,
        })),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/say") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.text) {
        sendJson(res, 400, { ok: false, error: "text required" });
        return;
      }
      const msg = {
        type: "chat",
        from: body.from || "unknown",
        to: body.to || null,
        text: body.text,
        expect_reply: !!body.expect_reply,
        timeout_sec: body.timeout_sec || 120,
        ts: new Date().toISOString(),
      };
      deliverChat(msg);
      sendJson(res, 200, { ok: true, msg, rule: "fire-and-forget unless human explicitly waits" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/mailbox") {
      const forRole = url.searchParams.get("for") || "";
      const sinceParam = url.searchParams.get("since");
      const since = sinceParam != null ? sinceParam : forRole ? getCursor(forRole) : "";
      const mark = url.searchParams.get("mark") !== "0";
      const lines = readMailSince(since, forRole || null).filter((m) => m.type === "chat");
      // inbox: messages TO me (or broadcast), not from me
      const inbox = forRole
        ? lines.filter((m) => m.from !== forRole && (!m.to || m.to === forRole || m.to === "*"))
        : lines;
      if (forRole && mark && inbox.length) {
        setCursor(forRole, inbox[inbox.length - 1].ts);
      }
      sendJson(res, 200, { ok: true, since, messages: inbox });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  meta.set(ws, {});
  wsSend(ws, {
    type: "welcome",
    hub: "lan-bridge-hub",
    hubRole,
    protocol: "mailbox-v1",
    antiDeadlock: [
      "Do NOT both agents park waiting for each other.",
      "Default: say() is fire-and-forget; peer reads /mailbox when activated.",
      "expect_reply=true only means peer should answer when free — sender stays idle.",
      "Only wait with timeout if the HUMAN explicitly asks you to wait.",
    ],
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      wsSend(ws, { type: "error", error: "invalid json" });
      return;
    }

    if (msg.type === "hello") {
      const role = String(msg.role || "").toLowerCase();
      if (!role) {
        wsSend(ws, { type: "error", error: "role required" });
        return;
      }
      const old = peers.get(role);
      if (old && old !== ws) {
        try {
          old.close(4000, "replaced");
        } catch {}
      }
      peers.set(role, ws);
      meta.set(ws, { role, hostname: msg.hostname, ip: msg.ip });
      wsSend(ws, { type: "hello_ack", role, online: [...peers.keys()] });
      for (const [r, pws] of peers) {
        if (r !== role) wsSend(pws, { type: "peer_joined", role, online: [...peers.keys()] });
      }
      return;
    }

    if (msg.type === "chat") {
      const info = meta.get(ws) || {};
      const out = {
        type: "chat",
        from: msg.from || info.role || "unknown",
        to: msg.to || null,
        text: msg.text,
        expect_reply: !!msg.expect_reply,
        timeout_sec: msg.timeout_sec || 120,
        ts: new Date().toISOString(),
      };
      deliverChat(out);
      wsSend(ws, { type: "chat_ack", ...out });
      return;
    }

    if (msg.type === "ping") {
      wsSend(ws, { type: "pong", ts: new Date().toISOString() });
      return;
    }

    wsSend(ws, { type: "error", error: "unknown type", supported: ["hello", "chat", "ping"] });
  });

  ws.on("close", () => {
    const info = meta.get(ws) || {};
    if (info.role && peers.get(info.role) === ws) {
      peers.delete(info.role);
      for (const [, pws] of peers) {
        wsSend(pws, { type: "peer_left", role: info.role, online: [...peers.keys()] });
      }
    }
  });
});

server.listen(PORT, cfg.bind || "0.0.0.0", () => {
  log(`hub listening ${cfg.bind || "0.0.0.0"}:${PORT} hubRole=${hubRole} host=${os.hostname()}`);
});
