#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const jobs = require("./jobs");

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, "config.json");
const LOG_PATH = path.join(ROOT, "logs", "daemon.log");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, msg);
  } catch {}
  process.stdout.write(msg);
}

function ipInCidr(ip, cidr) {
  if (!cidr) return false;
  if (cidr.includes("/")) {
    const [base, bitsStr] = cidr.split("/");
    const bits = Number(bitsStr);
    const ipNum = ipv4ToInt(ip);
    const baseNum = ipv4ToInt(base);
    if (ipNum === null || baseNum === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipNum & mask) === (baseNum & mask);
  }
  return ip === cidr;
}

function ipv4ToInt(ip) {
  const m = String(ip)
    .replace(/^::ffff:/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
}

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function authorized(req, cfg) {
  const token = req.headers["x-bridge-token"];
  if (token !== cfg.token) return false;
  const ip = clientIp(req);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const list = cfg.allowCidr || [];
  return list.some((c) => ipInCidr(ip, c));
}

function safeRelPath(rel) {
  const cleaned = decodeURIComponent(String(rel || ""))
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) return null;
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.join(path.sep);
}

function inboxRoot(cfg) {
  return path.resolve(ROOT, cfg.inbox || "inbox");
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function ensureDirs(cfg) {
  fs.mkdirSync(inboxRoot(cfg), { recursive: true });
  fs.mkdirSync(path.resolve(ROOT, cfg.outbox || "outbox"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  jobs.ensureJobDirs(ROOT, cfg);
}

function listDir(abs, relBase) {
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (!st.isDirectory()) {
    return [{ path: relBase, size: st.size, mtime: st.mtime.toISOString(), type: "file" }];
  }
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    const full = path.join(abs, name);
    const st2 = fs.statSync(full);
    const rel = relBase ? `${relBase}/${name}` : name;
    out.push({
      path: rel.replace(/\\/g, "/"),
      size: st2.isFile() ? st2.size : null,
      mtime: st2.mtime.toISOString(),
      type: st2.isDirectory() ? "dir" : "file",
    });
  }
  return out;
}

const cfg = loadConfig();
ensureDirs(cfg);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        role: cfg.role,
        name: cfg.role,
        hostname: os.hostname(),
        port: cfg.port,
        inbox: inboxRoot(cfg),
        jobs: true,
        version: 2,
      });
      return;
    }

    // PAC for browsers (no auth; localhost / LAN only via bind)
    if (method === "GET" && url.pathname === "/proxy.pac") {
      const pacFile = path.join(ROOT, "proxy.pac");
      if (!fs.existsSync(pacFile)) {
        sendJson(res, 404, { ok: false, error: "proxy.pac missing; run lanbridge proxy on" });
        return;
      }
      const body = fs.readFileSync(pacFile);
      res.writeHead(200, {
        "Content-Type": "application/x-ns-proxy-autoconfig",
        "Content-Length": body.length,
        "Cache-Control": "no-cache",
      });
      res.end(body);
      return;
    }

    if (!authorized(req, cfg)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    // ---- jobs API ----
    if (method === "POST" && url.pathname === "/v1/jobs") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      try {
        const job = jobs.createJob(ROOT, cfg, body);
        log(`JOB create ${job.id} type=${job.type} from=${job.from}`);
        sendJson(res, 200, { ok: true, job });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/v1/jobs") {
      sendJson(res, 200, { ok: true, jobs: jobs.listJobs(ROOT) });
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([a-zA-Z0-9_-]+)$/);
    if (jobMatch && method === "GET") {
      const job = jobs.readJob(ROOT, jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      sendJson(res, 200, { ok: true, job });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/files") {
      const rel = safeRelPath(url.searchParams.get("path") || "");
      if (rel === null && url.searchParams.get("path")) {
        sendJson(res, 400, { ok: false, error: "bad path" });
        return;
      }
      const abs = path.join(inboxRoot(cfg), rel || "");
      if (!abs.startsWith(inboxRoot(cfg))) {
        sendJson(res, 400, { ok: false, error: "path escape" });
        return;
      }
      sendJson(res, 200, { ok: true, files: listDir(abs, (rel || "").replace(/\\/g, "/")) });
      return;
    }

    const fileMatch = url.pathname.match(/^\/v1\/files\/(.+)$/);
    if (fileMatch) {
      const rel = safeRelPath(fileMatch[1]);
      if (!rel) {
        sendJson(res, 400, { ok: false, error: "bad path" });
        return;
      }
      const abs = path.join(inboxRoot(cfg), rel);
      if (!abs.startsWith(inboxRoot(cfg))) {
        sendJson(res, 400, { ok: false, error: "path escape" });
        return;
      }

      if (method === "GET") {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          sendJson(res, 404, { ok: false, error: "not found" });
          return;
        }
        const st = fs.statSync(abs);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": st.size,
          "X-File-Name": path.basename(abs),
        });
        fs.createReadStream(abs).pipe(res);
        return;
      }

      if (method === "PUT") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = abs + ".partial";
        const ws = fs.createWriteStream(tmp);
        req.pipe(ws);
        ws.on("finish", () => {
          fs.renameSync(tmp, abs);
          const st = fs.statSync(abs);
          log(`PUT ${rel} size=${st.size} from=${clientIp(req)}`);
          sendJson(res, 200, { ok: true, path: rel.replace(/\\/g, "/"), size: st.size });
        });
        ws.on("error", (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          sendJson(res, 500, { ok: false, error: String(err.message || err) });
        });
        return;
      }
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    log(`error ${err && err.stack ? err.stack : err}`);
    sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

server.listen(cfg.port, cfg.bind || "0.0.0.0", () => {
  log(`lan-bridge daemon v2 listening ${cfg.bind || "0.0.0.0"}:${cfg.port} role=${cfg.role}`);
});
