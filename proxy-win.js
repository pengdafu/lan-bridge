"use strict";
/**
 * Windows ALL-egress via Mac SOCKS (system proxy + WinHTTP + env hints).
 * Note: apps that ignore system proxy still need TUN/Proxifier later.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");

function socksTarget(cfg) {
  const host =
    (cfg.socks && cfg.socks.host) ||
    (cfg.peers.mac && cfg.peers.mac.host) ||
    "192.168.31.92";
  const port = (cfg.socks && cfg.socks.port) || 1080;
  return { host, port, url: `socks5://${host}:${port}`, ie: `socks=${host}:${port}` };
}

function ps(command) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" }
  );
  return {
    status: r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
  };
}

function probeTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      resolve(false);
    });
  });
}

function setUserEnv(name, value) {
  if (value == null || value === "") {
    ps(`[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`);
    try {
      delete process.env[name];
    } catch {}
  } else {
    ps(`[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')`);
    process.env[name] = value;
  }
}

async function proxyOn(cfg) {
  const t = socksTarget(cfg);
  const up = await probeTcp(t.host, t.port);
  if (!up) {
    return {
      ok: false,
      error: `SOCKS not reachable ${t.host}:${t.port}. Is Mac lanbridge-socks running?`,
      target: t,
    };
  }

  // Bypass LAN + common public git hosts so proxy-on does not break GitHub push
  const bypass =
    "localhost;127.*;10.*;192.168.*;<local>;github.com;*.github.com;githubusercontent.com;*.githubusercontent.com";
  const ie = ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path $path -Name ProxyServer -Value '${t.ie}'
Set-ItemProperty -Path $path -Name ProxyOverride -Value '${bypass}'
# refresh WinINet
Add-Type -Namespace I -Name WinINet -MemberDefinition @'
[DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
'@
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
'IE_PROXY_OK'
`);

  const winhttp = spawnSync(
    "netsh",
    ["winhttp", "set", "proxy", `proxy-server=${t.ie}`],
    { encoding: "utf8" }
  );

  setUserEnv("ALL_PROXY", t.url);
  setUserEnv("HTTPS_PROXY", t.url);
  setUserEnv("HTTP_PROXY", t.url);
  setUserEnv("all_proxy", t.url);

  // git host-scoped (safe even with system proxy)
  spawnSync(
    "git",
    ["config", "--global", "http.https://gitlab.futunn.com.proxy", t.url],
    { encoding: "utf8" }
  );

  return {
    ok: true,
    target: t,
    ie: ie.out || ie.err,
    winhttp: { status: winhttp.status, out: (winhttp.stdout || winhttp.stderr || "").trim() },
    note: "System SOCKS + WinHTTP + user env set. Restart terminals for env. Some apps need TUN later.",
  };
}

async function proxyOff(cfg) {
  const ie = ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 0 -Type DWord
Remove-ItemProperty -Path $path -Name ProxyServer -ErrorAction SilentlyContinue
Add-Type -Namespace I -Name WinINet -MemberDefinition @'
[DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
'@
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
'IE_PROXY_OFF'
`);
  const winhttp = spawnSync("netsh", ["winhttp", "reset", "proxy"], { encoding: "utf8" });
  setUserEnv("ALL_PROXY", "");
  setUserEnv("HTTPS_PROXY", "");
  setUserEnv("HTTP_PROXY", "");
  setUserEnv("all_proxy", "");
  spawnSync("git", ["config", "--global", "--unset", "http.https://gitlab.futunn.com.proxy"], {
    encoding: "utf8",
  });
  return {
    ok: true,
    ie: ie.out || ie.err,
    winhttp: { status: winhttp.status, out: (winhttp.stdout || winhttp.stderr || "").trim() },
  };
}

async function proxyStatus(cfg) {
  const t = socksTarget(cfg);
  const reachable = await probeTcp(t.host, t.port);
  const ie = ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$en = (Get-ItemProperty $path).ProxyEnable
$srv = (Get-ItemProperty $path).ProxyServer
\"enable=$en server=$srv\"
`);
  const winhttp = spawnSync("netsh", ["winhttp", "show", "proxy"], { encoding: "utf8" });
  return {
    ok: true,
    target: t,
    socksReachable: reachable,
    ie: ie.out,
    winhttp: (winhttp.stdout || "").trim(),
    env: {
      ALL_PROXY: process.env.ALL_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    },
  };
}

module.exports = { proxyOn, proxyOff, proxyStatus, socksTarget };
