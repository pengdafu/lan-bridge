' Launch lan-bridge processes with no console window (no taskbar flicker).
Option Explicit
Dim sh, root, nodeCmd
Set sh = CreateObject("WScript.Shell")
root = sh.ExpandEnvironmentStrings("%USERPROFILE%\lan-bridge")
nodeCmd = "node"

' 0 = hidden window, False = do not wait
sh.Run "cmd /c cd /d """ & root & """ && " & nodeCmd & " daemon.js", 0, False
sh.Run "cmd /c cd /d """ & root & """ && " & nodeCmd & " worker.js", 0, False
sh.Run "cmd /c cd /d """ & root & """ && " & nodeCmd & " hub.js", 0, False
' After reboot: always clear Mac proxy (WinINET/env/git/tcp-relay persist otherwise).
' Human/agent must run `lanbridge.js proxy on` manually when intranet is needed.
sh.Run "cmd /c cd /d """ & root & """ && " & nodeCmd & " lanbridge.js proxy off > logs\proxy-off-boot.log 2>&1", 0, False
