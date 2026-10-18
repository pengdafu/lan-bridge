#!/bin/bash
# Enable Mac as LAN gateway for company intranet (10/8) so PC MySQL/TCP works.
# Run on Mac (needs sudo once). Company VPN/utun must already reach 10.x.
set -euo pipefail

echo "== before =="
sysctl net.inet.ip.forwarding || true

sudo sysctl -w net.inet.ip.forwarding=1

# Persist across reboot (macOS Ventura+)
FORWARD_PLIST=/Library/LaunchDaemons/com.lanbridge.ipforward.plist
sudo tee "$FORWARD_PLIST" >/dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lanbridge.ipforward</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/sbin/sysctl</string>
    <string>-w</string>
    <string>net.inet.ip.forwarding=1</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF
sudo launchctl bootout system "$FORWARD_PLIST" 2>/dev/null || true
sudo launchctl bootstrap system "$FORWARD_PLIST"
sudo launchctl enable system/com.lanbridge.ipforward

# NAT LAN clients out via default/VPN iface (best-effort; adjust if VPN iface differs)
PF_ANCHOR=/etc/pf.anchors/lanbridge
EXT_IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')
if [[ -z "${EXT_IF:-}" ]]; then
  EXT_IF=$(ifconfig -l | tr ' ' '\n' | grep -E '^(en|utun)' | head -1)
fi
echo "NAT egress iface guess: $EXT_IF"

sudo tee "$PF_ANCHOR" >/dev/null <<EOF
# lan-bridge: NAT home LAN -> company path
nat on $EXT_IF from 192.168.0.0/16 to any -> ($EXT_IF)
pass in quick on en+ proto { tcp udp icmp } from 192.168.0.0/16 to any
pass out quick on $EXT_IF from 192.168.0.0/16 to any
EOF

# Load anchor if not already referenced
if ! grep -q 'lanbridge' /etc/pf.conf 2>/dev/null; then
  echo "WARN: add these lines to /etc/pf.conf then: sudo pfctl -f /etc/pf.conf && sudo pfctl -e"
  echo "  anchor \"lanbridge\""
  echo "  load anchor \"lanbridge\" from \"$PF_ANCHOR\""
else
  sudo pfctl -f /etc/pf.conf
  sudo pfctl -e || true
fi

echo "== after =="
sysctl net.inet.ip.forwarding
echo "Test from Mac: nc -vz 10.2.18.2 3306"
echo "On PC after: lanbridge proxy on  (adds route 10.0.0.0/8 via this Mac)"
