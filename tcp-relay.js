"use strict";
/**
 * Local TCP → Mac SOCKS5 CONNECT relay (Windows).
 * Covers raw TCP (MySQL etc.) that HTTP proxy cannot.
 * Config: socks.tcpForwards = [{ localPort, host, port }]
 */
const net = require("net");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PID_FILE = path.join(ROOT, "logs", "tcp-relay.pid");
const LOG_FILE = path.join(ROOT, "logs", "tcp-relay.log");

function loadCfg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
}

function socksTarget(cfg) {
  const host =
    (cfg.socks && cfg.socks.host) ||
    (cfg.peers.mac && cfg.peers.mac.host) ||
    "192.168.31.92";
  const port = (cfg.socks && cfg.socks.port) || 1080;
  return { host, port };
}

function log(line) {
  const s = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, s);
  } catch {}
  process.stderr.write(s);
}

function socksConnect(socksHost, socksPort, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: socksHost, port: socksPort }, () => {
      // greeting: ver=5, 1 method, no-auth
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let buf = Buffer.alloc(0);
    let phase = "greet";

    const fail = (err) => {
      sock.destroy();
      reject(err);
    };

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (phase === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("socks auth rejected"));
        buf = buf.subarray(2);
        phase = "reply";
        // CONNECT request
        const hostBuf = Buffer.from(destHost, "utf8");
        const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
        req[0] = 0x05;
        req[1] = 0x01; // CONNECT
        req[2] = 0x00;
        req[3] = 0x03; // domain
        req[4] = hostBuf.length;
        hostBuf.copy(req, 5);
        req.writeUInt16BE(destPort, 5 + hostBuf.length);
        sock.write(req);
        return;
      }
      if (phase === "reply") {
        if (buf.length < 4) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          return fail(new Error(`socks connect failed code=${buf[1]}`));
        }
        const atyp = buf[3];
        let need = 4;
        if (atyp === 0x01) need += 4 + 2;
        else if (atyp === 0x03) {
          if (buf.length < 5) return;
          need += 1 + buf[4] + 2;
        } else if (atyp === 0x04) need += 16 + 2;
        else return fail(new Error(`socks bad atyp ${atyp}`));
        if (buf.length < need) return;
        sock.removeAllListeners("data");
        const rest = buf.subarray(need);
        phase = "pipe";
        resolve({ sock, rest });
      }
    });
    sock.on("error", fail);
    sock.setTimeout(15000, () => fail(new Error("socks timeout")));
  });
}

function startForward(localPort, destHost, destPort, socks) {
  const server = net.createServer((client) => {
    socksConnect(socks.host, socks.port, destHost, destPort)
      .then(({ sock, rest }) => {
        sock.setTimeout(0);
        if (rest.length) client.write(rest);
        client.pipe(sock);
        sock.pipe(client);
        const close = () => {
          client.destroy();
          sock.destroy();
        };
        client.on("error", close);
        sock.on("error", close);
        client.on("close", close);
        sock.on("close", close);
      })
      .catch((err) => {
        log(`forward ${localPort}->${destHost}:${destPort} fail: ${err.message}`);
        client.destroy();
      });
  });
  server.listen(localPort, "127.0.0.1", () => {
    log(`listening 127.0.0.1:${localPort} -> ${destHost}:${destPort} via ${socks.host}:${socks.port}`);
  });
  server.on("error", (err) => log(`listen ${localPort} error: ${err.message}`));
  return server;
}

function defaultForwards(cfg) {
  if (cfg.socks && Array.isArray(cfg.socks.tcpForwards) && cfg.socks.tcpForwards.length) {
    return cfg.socks.tcpForwards;
  }
  // Sensible company defaults (override in config.json)
  return [
    { localPort: 13306, host: "10.2.18.2", port: 3306 },
  ];
}

function runDaemon() {
  const cfg = loadCfg();
  const socks = socksTarget(cfg);
  const forwards = defaultForwards(cfg);
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`tcp-relay start pid=${process.pid} socks=${socks.host}:${socks.port}`);
  for (const f of forwards) {
    startForward(f.localPort, f.host, f.port, socks);
  }
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

function isRunning() {
  try {
    if (!fs.existsSync(PID_FILE)) return false;
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

function stopRelay() {
  const pid = isRunning();
  if (!pid) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    return { ok: true, stopped: false };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  return { ok: true, stopped: true, pid };
}

function startRelayDetached() {
  const running = isRunning();
  if (running) return { ok: true, already: true, pid: running };
  const { spawn } = require("child_process");
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, "tcp-relay.js"), "run"], {
    detached: true,
    stdio: "ignore",
    cwd: ROOT,
    windowsHide: true,
  });
  child.unref();
  // pid file written by child; brief wait
  return { ok: true, started: true, spawnPid: child.pid };
}

if (require.main === module) {
  const cmd = process.argv[2] || "run";
  if (cmd === "run") runDaemon();
  else if (cmd === "start") console.log(JSON.stringify(startRelayDetached(), null, 2));
  else if (cmd === "stop") console.log(JSON.stringify(stopRelay(), null, 2));
  else if (cmd === "status") console.log(JSON.stringify({ ok: true, pid: isRunning() || null }, null, 2));
  else {
    console.error("usage: node tcp-relay.js run|start|stop|status");
    process.exit(1);
  }
}

module.exports = { startRelayDetached, stopRelay, isRunning, defaultForwards };
