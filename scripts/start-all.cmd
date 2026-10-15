@echo off
cd /d "%USERPROFILE%\lan-bridge"
start "lan-bridge-daemon" /MIN node daemon.js
start "lan-bridge-worker" /MIN node worker.js
start "lan-bridge-hub" /MIN node hub.js
