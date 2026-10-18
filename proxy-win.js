"use strict";
/**
 * Windows egress via Mac proxy.
 * Default: ALL traffic via Mac HTTP :1087 (remote DNS) — covers all intranet,
 * no per-domain whitelist. PAC split is opt-in via --pac.
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
    // IE/WinINET: HTTP proxy (not socks=) — browsers do remote DNS via CONNECT
    ieHttp: `${host}:${httpPort}`,
    ieSocks: `socks=${host}:${port}`,
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
      shExpMatch(host, "192.168.*")) {
    return "DIRECT";
  }
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

function setGitLabProxy(httpUrl) {
  // HTTP proxy — Windows git/libcurl often fails socks5 with "Could not resolve proxy"
  spawnSync(
    "git",
    ["config", "--global", "http.https://gitlab.futunn.com.proxy", httpUrl],
    { encoding: "utf8" }
  );
}

/**
 * @param {object} cfg
 * @param {{ pac?: boolean }} [opts]  pac=true → split tunnel; default = all via Mac
 */
async function proxyOn(cfg, { pac = false } = {}) {
  const t = socksTarget(cfg);
  const upHttp = await probeTcp(t.host, t.httpPort);
  const upSocks = await probeTcp(t.host, t.port);
  if (!upHttp && !upSocks) {
    return {
      ok: false,
      error: `Mac proxy not reachable ${t.host}:${t.httpPort}/:${t.port}. Is lanbridge-socks running?`,
      target: t,
    };
  }

  setGitLabProxy(t.httpUrl);

  if (pac) {
    const pacInfo = writePac(cfg, t);
    ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 0 -Type DWord
Remove-ItemProperty -Path $path -Name ProxyServer -ErrorAction SilentlyContinue
Set-ItemProperty -Path $path -Name AutoConfigURL -Value '${pacInfo.url}'
`);
    refreshWinInet();
    setUserEnv("ALL_PROXY", "");
    setUserEnv("HTTPS_PROXY", "");
    setUserEnv("HTTP_PROXY", "");
    setUserEnv("all_proxy", "");
    return {
      ok: true,
      mode: "pac-split",
      target: t,
      pac: pacInfo.url,
      note: "Split tunnel. Prefer default (no --pac) for full intranet.",
    };
  }

  // Default: ALL HTTP(S) via Mac. Do NOT bypass 10.* — that is company intranet.
  // Only keep home LAN + loopback direct so lan-bridge / printer still work.
  const bypass = "localhost;127.*;192.168.*;<local>";
  ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $path -Name ProxyEnable -Value 1 -Type DWord
Set-ItemProperty -Path $path -Name ProxyServer -Value '${t.ieHttp}'
Set-ItemProperty -Path $path -Name ProxyOverride -Value '${bypass}'
Remove-ItemProperty -Path $path -Name AutoConfigURL -ErrorAction SilentlyContinue
`);
  refreshWinInet();
  setUserEnv("HTTP_PROXY", t.httpUrl);
  setUserEnv("HTTPS_PROXY", t.httpUrl);
  setUserEnv("ALL_PROXY", t.url);
  setUserEnv("all_proxy", t.url);
  setUserEnv("NO_PROXY", "localhost,127.0.0.1,192.168.0.0/16");
  setUserEnv("no_proxy", "localhost,127.0.0.1,192.168.0.0/16");

  return {
    ok: true,
    mode: "all-via-mac",
    target: t,
    note:
      "All browser/HTTP(S)/git via Mac. Restart browser once. Raw TCP (MySQL) still needs Mac reachability or a TUN later.",
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
  setUserEnv("NO_PROXY", "");
  setUserEnv("no_proxy", "");
  spawnSync("git", ["config", "--global", "--unset", "http.https://gitlab.futunn.com.proxy"], {
    encoding: "utf8",
  });
  return { ok: true, mode: "off" };
}

async function proxyStatus(cfg) {
  const t = socksTarget(cfg);
  const reachable = {
    http: await probeTcp(t.host, t.httpPort),
    socks: await probeTcp(t.host, t.port),
  };
  const ie = ps(`
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$p = Get-ItemProperty $path
\"enable=$($p.ProxyEnable) server=$($p.ProxyServer) pac=$($p.AutoConfigURL) bypass=$($p.ProxyOverride)\"
`);
  return {
    ok: true,
    target: t,
    reachable,
    ie: ie.out,
    env: {
      ALL_PROXY: process.env.ALL_PROXY || null,
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
      HTTP_PROXY: process.env.HTTP_PROXY || null,
    },
  };
}

module.exports = { proxyOn, proxyOff, proxyStatus, socksTarget };
