@echo off
REM One-time Admin: install Scheduled Task LanBridgeTun (Highest privileges).
cd /d "%USERPROFILE%\lan-bridge"
node -e "require('./tun-win').installTunTask(require('./config.json')).then(r=>{console.log(JSON.stringify(r,null,2)); if(!r.ok){console.error(r.error); process.exit(1)}})"
if errorlevel 1 (
  echo INSTALL FAILED
  pause
  exit /b 1
)
echo INSTALL OK - now run: node lanbridge.js proxy on
pause
