"use strict";
/**
 * Windows proxy via Mac SOCKS.
 * Default: PAC split — only company domains via Mac; everything else DIRECT.
 * Full SOCKS-for-all breaks browsers on Windows; use --all only for experiments.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const net = require("net");

const ROOT = __dirname;

function socksTarget(cfg) {
  const host =
    (cfg.socks && cfg.socks.host) ||
    (cfg.peers.mac && cfg.peers.mac.host) ||
    "192.168.31.92";
  const port = (cfg.socks && cfg.socks.port) || 1080;
  const httpPort = (cfg.socks && cfg.socks.httpPort) || 1087;
  return {
    host,
    port,
    httpPort,
    url: `socks5://${host}:${port}`,
    httpUrl: `http://${host}:${httpPort}`,
    ie: `socks=${host}:${port}`,
  };
}

function companySuffixes(cfg) {
  return (
    (cfg.socks && cfg.socks.domains) || [
      ".futunn.com",
      ".futu5.com",
      ".futuhk.com",
      ".futusam.com",
      ".futuoa.com",
      ".server.com",
      ".fc.local",
      "futunn.com",
      "futuoa.com",
      "server.com",
      "gitlab.futunn.com",
      "fservice.server.com",
      "fservice.futuoa.com",
    ]
  );
}

function writePac(cfg, t) {
  const domains = companySuffixes(cfg);
  // Prefer HTTP proxy so browser sends hostname to Mac (remote DNS).
  // Also: if PC DNS cannot resolve host → try Mac proxy (covers unknown intranet names).
  const checks = domains
    .map((d) => {
      const bare = d.startsWith(".") ? d.slice(1) : d;
      const star = d.startsWith(".") ? `*${d}` : `*.${d}`;
      return `    shExpMatch(host, "${bare}") || shExpMatch(host, "${star}")`;
    })
    .join(" ||\n");
  const via = `PROXY ${t.host}:${t.httpPort}; SOCKS5 ${t.host}:${t.port}; DIRECT`;
  const pac = `// lan-bridge PAC — company / unresolvable hosts via Mac, else DIRECT
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) ||
      shExpMatch(host, "localhost") ||
      shExpMatch(host, "127.*") ||
      shExpMatch(host, "10.*") ||
      shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "172.16.*") ||
      shExpMatch(host, "172.17.*") ||
      shExpMatch(host, "172.18.*") ||
      shExpMatch(host, "172.19.*") ||
      shExpMatch(host, "172.2*.*") ||
      shExpMatch(host, "172.30.*") ||
      shExpMatch(host, "172.31.*")) {
    return "DIRECT";
  }
  // Never send public giants to Mac
  if (shExpMatch(host, "*.google.com") || shExpMatch(host, "google.com") ||
      shExpMatch(host, "*.github.com") || shExpMatch(host, "github.com") ||
      shExpMatch(host, "*.githubusercontent.com") ||
      shExpMatch(host, "*.baidu.com") || shExpMatch(host, "baidu.com") ||
      shExpMatch(host, "*.microsoft.com") || shExpMatch(host, "*.office.com") ||
      shExpMatch(host, "*.live.com") || shExpMatch(host, "*.bing.com") ||
      shExpMatch(host, "*.cloudflare.com") || shExpMatch(host, "*.gstatic.com")) {
    return "DIRECT";
  }
  if (
${checks}
  ) {
    return "${via}";
  }
  // Intranet names often NXDOMAIN on home router — try Mac
  if (!isResolvable(host)) {
    return "${via}";
  }
  return "DIRECT";
}
`;
  const pacPath = path.join(ROOT, "proxy.pac");
  fs.writeFileSync(pacPath, pac);
  const url = `http://127.0.0.1:${cfg.port || 8766}/proxy.pac`;
  return { pacPath, url };
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

function refreshWinInet() {
  return ps(`
Add-Type -Namespace I -Name WinINet -MemberDefinition @'
[DllImport("wininet.dll", SetLastError=true)]
public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
'@
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
[void][I.WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
'REFRESH_OK'
`);
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

async function proxyOn(cfg, { all = false } = {}) {
  const t = socksTarget(cfg);
  const up = await probeTcp(t.host, t.port);
  if (!up) {
    return {
      ok: false,
      error: `SOCKS not reachable ${t.host}:${t.port}. Is Mac lanbridge-socks running?`,
      target: t,
    };
  }

  // Always set host-scoped git for GitLab
  spawnSync(
    "git",
    ["config", "--global", "http.https://gitlab.futunn.com.proxy", t.url],
    { encoding: "utf8" }
  );

  if (all) {
    // Dangerous: full SOCKS — browsers often lose public net
    const bypass = "localhost;127.*;10.*;192.168.*;<local>";
    ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path $path -Name ProxyServer -Value '${t.ie}'
Set-ItemProperty -Path $path -Name ProxyOverride -Value '${bypass}'
Remove-ItemProperty -Path $path -Name AutoConfigURL -ErrorAction SilentlyContinue
`);
    refreshWinInet();
    setUserEnv("ALL_PROXY", t.url);
    setUserEnv("HTTPS_PROXY", t.url);
    setUserEnv("HTTP_PROXY", t.url);
    return {
      ok: true,
      mode: "all-socks",
      warning: "ALL traffic via SOCKS — public sites may break. Prefer default PAC mode.",
      target: t,
    };
  }

  // Safe default: PAC split tunnel
  const pac = writePac(cfg, t);
  ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 0 -Type DWord
Remove-ItemProperty -Path $path -Name ProxyServer -ErrorAction SilentlyContinue
Set-ItemProperty -Path $path -Name AutoConfigURL -Value '${pac.url}'
`);
  refreshWinInet();
  // Do NOT set global ALL_PROXY (would break public curl/npm)
  setUserEnv("ALL_PROXY", "");
  setUserEnv("HTTPS_PROXY", "");
  setUserEnv("HTTP_PROXY", "");
  setUserEnv("all_proxy", "");

  return {
    ok: true,
    mode: "pac-split",
    target: t,
    pac: pac.url,
    note: "Company domains via Mac SOCKS; other sites DIRECT. Restart browser if needed.",
  };
}

async function proxyOff(cfg) {
  ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 0 -Type DWord
Remove-ItemProperty -Path $path -Name ProxyServer -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $path -Name AutoConfigURL -ErrorAction SilentlyContinue
`);
  refreshWinInet();
  spawnSync("netsh", ["winhttp", "reset", "proxy"], { encoding: "utf8" });
  setUserEnv("ALL_PROXY", "");
  setUserEnv("HTTPS_PROXY", "");
  setUserEnv("HTTP_PROXY", "");
  setUserEnv("all_proxy", "");
  spawnSync("git", ["config", "--global", "--unset", "http.https://gitlab.futunn.com.proxy"], {
    encoding: "utf8",
  });
  return { ok: true, mode: "off" };
}

async function proxyStatus(cfg) {
  const t = socksTarget(cfg);
  const reachable = await probeTcp(t.host, t.port);
  const ie = ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$p = Get-ItemProperty $path
\"enable=$($p.ProxyEnable) server=$($p.ProxyServer) pac=$($p.AutoConfigURL)\"
`);
  return {
    ok: true,
    target: t,
    socksReachable: reachable,
    ie: ie.out,
    env: {
      ALL_PROXY: process.env.ALL_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
    },
  };
}

module.exports = { proxyOn, proxyOff, proxyStatus, socksTarget };
