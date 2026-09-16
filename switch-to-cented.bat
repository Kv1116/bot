@echo off
setlocal
cd /d "%~dp0"
if not exist "signal-sniper-v2.env" (
  echo ERROR: signal-sniper-v2.env not found in this folder.
  pause
  exit /b 1
)
if not exist "src\signal-sniper-v2.ts" (
  echo ERROR: src\signal-sniper-v2.ts not found.
  pause
  exit /b 1
)
copy /Y "signal-sniper-v2.env" "cented-copy.env" >nul
PowerShell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p='cented-copy.env'; $s=Get-Content $p -Raw;" ^
  "$r=@{ '^TARGET_WALLET=.*$'='TARGET_WALLET=CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o'; '^SIGNAL_MIN_TARGET_BUY_SOL=.*$'='SIGNAL_MIN_TARGET_BUY_SOL=0.5'; '^SIGNAL_MAX_TARGET_BUY_SOL=.*$'='SIGNAL_MAX_TARGET_BUY_SOL=5'; '^SIGNAL_LEADER_MIN_BUY_SOL=.*$'='SIGNAL_LEADER_MIN_BUY_SOL=3.0'; '^SIGNAL_CONFIRM_WINDOW_MS=.*$'='SIGNAL_CONFIRM_WINDOW_MS=120000'; '^SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=.*$'='SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=false'; '^SIGNAL_MIN_CUMULATIVE_BUY_SOL=.*$'='SIGNAL_MIN_CUMULATIVE_BUY_SOL=3.5'; '^SIGNAL_MAX_REAL_SOL_RESERVE=.*$'='SIGNAL_MAX_REAL_SOL_RESERVE=35'; '^SIGNAL_FULL_EXIT_ON_TARGET_SELL=.*$'='SIGNAL_FULL_EXIT_ON_TARGET_SELL=true'; '^SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=.*$'='SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=6'; '^SAFE_COPY_HARD_STOP_PERCENT=.*$'='SAFE_COPY_HARD_STOP_PERCENT=7'; '^SAFE_COPY_TAKE_PROFIT_PERCENT=.*$'='SAFE_COPY_TAKE_PROFIT_PERCENT=15'; '^SAFE_COPY_TRAILING_ACTIVATE_PERCENT=.*$'='SAFE_COPY_TRAILING_ACTIVATE_PERCENT=8'; '^SAFE_COPY_TRAILING_PERCENT=.*$'='SAFE_COPY_TRAILING_PERCENT=3'; '^SAFE_COPY_BREAKEVEN_ARM_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_ARM_PERCENT=5'; '^SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=.*$'='SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=1.5'; '^SAFE_COPY_MAX_HOLD_MS=.*$'='SAFE_COPY_MAX_HOLD_MS=600000'; '^USE_ENHANCED_TRANSACTION_STREAM=.*$'='USE_ENHANCED_TRANSACTION_STREAM=true'; '^STATE_FILE=.*$'='STATE_FILE=cented-copy-state.json'; '^BOT_DISPLAY_NAME=.*$'='BOT_DISPLAY_NAME=CENTED COPY TEST' };" ^
  "foreach($k in $r.Keys){$s=[regex]::Replace($s,$k,$r[$k],[System.Text.RegularExpressions.RegexOptions]::Multiline)}; Set-Content -Path $p -Value $s -Encoding UTF8"
if errorlevel 1 (
  echo ERROR: Could not build cented-copy.env
  pause
  exit /b 1
)
echo.
echo Created cented-copy.env from your WORKING V2 env, preserving your RPC and wallet key.
echo Starting Cented copy test...
echo.
node --env-file=cented-copy.env --import tsx src/signal-sniper-v2.ts
pause
