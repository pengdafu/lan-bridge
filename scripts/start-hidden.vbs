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
