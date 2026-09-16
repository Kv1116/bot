@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo        CXKX COPY V5 - FAST SAFE COPY
echo ============================================================
echo LIVE MODE - real trades - test size 0.005 SOL.
echo Keeps cxkx-copy-state.json so any currently tracked position
echo can still be reconciled/closed after restart.
echo.

if not exist "cxkx-copy.env" (
  echo ERROR: cxkx-copy.env not found.
  pause
  exit /b 1
)

if not exist "src\cxkx-copy-v5.ts" (
  echo ERROR: src\cxkx-copy-v5.ts not found.
  pause
  exit /b 1
)

REM ----- Force the intended target.
set TARGET_WALLET=CxkxCQYLWVRStkWwdCcsAX6BWcPnMeKGQ3zm2m6jVjV8

REM ----- Preserve existing tracked live state.
set STATE_FILE=cxkx-copy-state.json

REM ----- Tiny live test size.
set DRY_RUN=false
set BUY_SOL=0.005
set BUY_USD=0.5
set MAX_SOL_PER_TRADE=0.005
set SAFE_COPY_MAX_OPEN_POSITIONS=1
set SAFE_COPY_ONE_BUY_PER_MINT=true

REM ----- Entry quality filters.
REM Recent live winners were all >=0.217 SOL target buys and <=1.65%% premium.
REM We use 0.15 SOL / 2.5%% as a conservative filter without overfitting too hard.
set SIGNAL_MIN_TARGET_BUY_SOL=0.15
set SIGNAL_MAX_TARGET_BUY_SOL=1.5
set SAFE_COPY_MAX_ENTRY_PREMIUM_PERCENT=2.5
set SIGNAL_MIN_REAL_SOL_RESERVE=0.5
set SIGNAL_MAX_REAL_SOL_RESERVE=60
set SIGNAL_REQUIRE_LEADER_FOR_SMALL_BUY=false
set SIGNAL_FULL_EXIT_ON_TARGET_SELL=true

REM ----- Do not chase delayed signals.
set FAST_PUMP_ONLY=true
set USE_ENHANCED_TRANSACTION_STREAM=false
set TARGET_TX_FETCH_TIMEOUT_MS=180
set MAX_BUY_SIGNAL_AGE_MS=700

REM ----- Autonomous exits.
set SAFE_COPY_HARD_STOP_PERCENT=6
set SAFE_COPY_TAKE_PROFIT_PERCENT=9
set SAFE_COPY_TRAILING_ACTIVATE_PERCENT=6
set SAFE_COPY_TRAILING_PERCENT=2.5
set SAFE_COPY_BREAKEVEN_ARM_PERCENT=4
set SAFE_COPY_BREAKEVEN_FLOOR_PERCENT=1.5
set SAFE_COPY_MAX_HOLD_MS=180000

REM ----- SELL reliability.
set SELL_SLIPPAGE=8
set EMERGENCY_SELL_RETRY_ENABLED=true
set EMERGENCY_SELL_MAX_RETRIES=3
set EMERGENCY_SELL_SLIPPAGES=15,25,40
set EMERGENCY_SELL_PRIORITY_FEE_MICROLAMPORTS=350000
set EMERGENCY_SELL_RETRY_DELAY_MS=20

REM ----- Session risk circuit breaker.
set SAFE_COPY_CONSECUTIVE_LOSS_LIMIT=3
set SAFE_COPY_LOSS_PAUSE_MS=300000

echo V5 overrides loaded:
echo   target=Cxkx
echo   BUY=0.005 SOL
echo   min target BUY=0.15 SOL
echo   max entry premium=2.5%%
echo   stale BUY cutoff=700 ms
echo   hard stop=6%%  take profit=9%%
echo   trailing=6%% activate / 2.5%% trail
echo   3 consecutive autonomous losses = 5 minute BUY pause
echo   emergency SELL slippage=15,25,40%%
echo   FAST_PUMP_ONLY=true
echo.

node --env-file=cxkx-copy.env --import tsx src/cxkx-copy-v5.ts

echo.
pause
