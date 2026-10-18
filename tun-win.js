"use strict";
/**
 * Windows TUN via sing-box → Mac SOCKS5.
 * True process-agnostic egress (Node / Electron / MySQL / browsers).
 * Requires Administrator once per `proxy on` (UAC).
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { createWriteStream } = require("fs");
const { pipeline } = require("stream/promises");

const ROOT = __dirname;
const BIN_DIR = path.join(ROOT, "bin");
const TUN_DIR = path.join(ROOT, "tun");
const SING_BOX = path.join(BIN_DIR, "sing-box.exe");
const CONFIG_PATH = path.join(TUN_DIR, "sing-box.json");
const PID_FILE = path.join(TUN_DIR, "sing-box.pid");
const LOG_FILE = path.join(TUN_DIR, "sing-box.log");
const DOWNLOAD_URL =
  "https://github.com/SagerNet/sing-box/releases/download/v1.14.3/sing-box-1.14.3-windows-amd64.zip";

function socksTarget(cfg) {
  const host =
    (cfg.socks && cfg.socks.host) ||
    (cfg.peers.mac && cfg.peers.mac.host) ||
    "192.168.31.92";
  const port = (cfg.socks && cfg.socks.port) || 1080;
  const httpPort = (cfg.socks && cfg.socks.httpPort) || 1087;
  return { host, port, httpPort };
}

function writeSingBoxConfig(cfg) {
  const t = socksTarget(cfg);
  fs.mkdirSync(TUN_DIR, { recursive: true });
  // 192.168 + loopback + Mac proxy host stay DIRECT (avoid TUN routing loop).
  // Everything else (incl. 10.0.0.0/8 company intranet + public) → Mac SOCKS.
  const config = {
    log: { level: "info", timestamp: true },
    dns: {
      servers: [
        {
          type: "udp",
          tag: "dns-mac",
          server: "8.8.8.8",
          detour: "mac",
        },
        { type: "local", tag: "dns-local" },
      ],
      final: "dns-mac",
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        address: ["172.19.0.1/30"],
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        stack: "mixed",
      },
    ],
    outbounds: [
      {
        type: "socks",
        tag: "mac",
        server: t.host,
        server_port: t.port,
        version: "5",
      },
      { type: "direct", tag: "direct" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { protocol: "dns", action: "hijack-dns" },
        {
          ip_cidr: [`${t.host}/32`, "192.168.0.0/16", "127.0.0.0/8"],
          outbound: "direct",
        },
      ],
      final: "mac",
      auto_detect_interface: true,
      default_domain_resolver: "dns-local",
    },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return { configPath: CONFIG_PATH, target: t };
}

function downloadWithProxy(url, dest, proxyUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const proxy = new URL(proxyUrl);
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${u.hostname}:443`,
      timeout: 60000,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      const tlsReq = https.request(
        {
          host: u.hostname,
          path: u.pathname + u.search,
          method: "GET",
          socket,
          servername: u.hostname,
          headers: { "User-Agent": "lan-bridge" },
        },
        (tlsRes) => {
          if (tlsRes.statusCode >= 300 && tlsRes.statusCode < 400 && tlsRes.headers.location) {
            tlsRes.resume();
            downloadWithProxy(tlsRes.headers.location, dest, proxyUrl).then(resolve, reject);
            return;
          }
          if (tlsRes.statusCode !== 200) {
            reject(new Error(`HTTP ${tlsRes.statusCode}`));
            tlsRes.resume();
            return;
          }
          const out = createWriteStream(dest);
          pipeline(tlsRes, out).then(resolve, reject);
        }
      );
      tlsReq.on("error", reject);
      tlsReq.end();
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("CONNECT timeout"));
    });
    req.end();
  });
}

async function ensureSingBox(cfg) {
  if (fs.existsSync(SING_BOX)) return { ok: true, path: SING_BOX, downloaded: false };
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const t = socksTarget(cfg);
  const proxyUrl = `http://${t.host}:${t.httpPort}`;
  const zipPath = path.join(BIN_DIR, "sing-box.zip");
  await downloadWithProxy(DOWNLOAD_URL, zipPath, proxyUrl);
  // Expand-Archive via PowerShell
  const expand = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${BIN_DIR}\\sing-box-extract'; ` +
        `$exe = Get-ChildItem -Path '${BIN_DIR}\\sing-box-extract' -Recurse -Filter sing-box.exe | Select-Object -First 1; ` +
        `Copy-Item -Force $exe.FullName '${SING_BOX}'; ` +
        `Remove-Item -Recurse -Force '${BIN_DIR}\\sing-box-extract'; Remove-Item -Force '${zipPath}'`,
    ],
    { encoding: "utf8" }
  );
  if (expand.status !== 0 || !fs.existsSync(SING_BOX)) {
    return {
      ok: false,
      error: `sing-box extract failed: ${(expand.stderr || expand.stdout || "").trim()}`,
    };
  }
  return { ok: true, path: SING_BOX, downloaded: true };
}

function isTunRunning() {
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

function stopTun() {
  const pid = isTunRunning();
  spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { encoding: "utf8" });
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-Process sing-box -ErrorAction SilentlyContinue | Stop-Process -Force; " +
        (pid ? `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; ` : ""),
    ],
    { encoding: "utf8" }
  );
  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
  return { ok: true, stopped: true, pid: pid || null };
}

const TASK_NAME = "LanBridgeTun";

function taskExists() {
  const r = spawnSync("schtasks", ["/Query", "/TN", TASK_NAME], { encoding: "utf8" });
  return r.status === 0;
}

function writeRunTunCmd() {
  const runCmd = path.join(TUN_DIR, "run-tun.cmd");
  fs.writeFileSync(
    runCmd,
    [
      "@echo off",
      `cd /d "${ROOT}"`,
      "taskkill /F /IM sing-box.exe >nul 2>&1",
      `del /f /q "${PID_FILE}" >nul 2>&1`,
      `start /b "" "${SING_BOX}" run -c "${CONFIG_PATH}" > "${LOG_FILE}" 2>&1`,
      "timeout /t 1 /nobreak >nul",
      `for /f "tokens=2 delims=," %%a in ('tasklist /FI "IMAGENAME eq sing-box.exe" /FO CSV /NH') do (echo %%~a>"${PID_FILE}" & goto :done)`,
      ":done",
    ].join("\r\n")
  );
  return runCmd;
}

/**
 * One-time Admin install: scheduled task with highest privileges.
 * After this, `startTun` can launch without UAC each time.
 */
async function installTunTask(cfg) {
  const ensured = await ensureSingBox(cfg);
  if (!ensured.ok) return ensured;
  writeSingBoxConfig(cfg);
  fs.mkdirSync(TUN_DIR, { recursive: true });
  const runCmd = writeRunTunCmd();

  const installPs1 = path.join(TUN_DIR, "install-task.ps1");
  // Use single-quoted paths in PS to avoid escape hell
  fs.writeFileSync(
    installPs1,
    `
$ErrorActionPreference = 'Stop'
$taskName = '${TASK_NAME}'
$runCmd = '${runCmd.replace(/'/g, "''")}'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ("/c `"" + $runCmd + "`"")
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
Write-Output "INSTALLED"
`
  );

  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${installPs1.replace(
        /'/g,
        "''"
      )}')`,
    ],
    { encoding: "utf8", timeout: 180000 }
  );

  if (!taskExists()) {
    return {
      ok: false,
      error:
        "Scheduled task install failed — accept the UAC prompt, or right-click scripts\\install-tun-task.cmd → Run as administrator. " +
        ((r.stderr || r.stdout || "").trim() || ""),
    };
  }
  return { ok: true, task: TASK_NAME, downloaded: ensured.downloaded, runCmd };
}

/**
 * Start sing-box TUN via scheduled task (no UAC if installTunTask done).
 * Falls back to one-shot RunAs if task missing.
 */
async function startTun(cfg) {
  const ensured = await ensureSingBox(cfg);
  if (!ensured.ok) return ensured;
  const running = isTunRunning();
  if (running) return { ok: true, already: true, pid: running };

  stopTun();
  const written = writeSingBoxConfig(cfg);
  fs.mkdirSync(TUN_DIR, { recursive: true });

  if (!taskExists()) {
    const inst = await installTunTask(cfg);
    if (!inst.ok) {
      return {
        ok: false,
        error: inst.error,
        hint: "Run once: scripts\\install-tun-task.cmd as Administrator",
        configPath: written.configPath,
      };
    }
  }

  writeRunTunCmd();
  const start = spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { encoding: "utf8" });
  for (let i = 0; i < 40; i++) {
    const pid = isTunRunning();
    if (pid) {
      return {
        ok: true,
        pid,
        configPath: written.configPath,
        target: written.target,
        downloaded: ensured.downloaded,
        task: TASK_NAME,
      };
    }
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 250"], {
      encoding: "utf8",
    });
  }

  let logTail = "";
  try {
    logTail = fs.readFileSync(LOG_FILE, "utf8").slice(-800);
  } catch {}
  return {
    ok: false,
    error:
      "TUN start failed after task run. " +
      ((start.stderr || start.stdout || "").trim() || logTail || "no log"),
    configPath: written.configPath,
  };
}

function tunStatus() {
  const pid = isTunRunning();
  return {
    running: Boolean(pid),
    pid: pid || null,
    binary: fs.existsSync(SING_BOX),
    taskInstalled: taskExists(),
    task: TASK_NAME,
    configPath: fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : null,
  };
}

module.exports = {
  startTun,
  stopTun,
  tunStatus,
  installTunTask,
  writeSingBoxConfig,
  ensureSingBox,
  SING_BOX,
  CONFIG_PATH,
  TASK_NAME,
};
