@echo off
cd /d "%~dp0"

echo Profiling Mr Frog / TheMisterTurtle with BOT PROFILER V3...
echo READ-ONLY - no trade can be signed or sent.
echo.

set PROFILE_TARGET_WALLET=4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh
set PROFILE_TX_LIMIT=1000
set PROFILE_DEEP_MINTS=50
set PROFILE_FIRST_BUYERS=30
set PROFILE_MINT_SIG_SCAN_LIMIT=2000
set PROFILE_MINT_PAGE_SIZE=100
set PROFILE_RPC_BATCH=5
set PROFILE_BATCH_DELAY_MS=650
set PROFILE_RPC_RETRIES=10
set PROFILE_RPC_BACKOFF_MS=1000
set PROFILE_RPC_MAX_BACKOFF_MS=12000
set PROFILE_UPSTREAM_FUNDER_LIMIT=20
set PROFILE_OUT_DIR=profiler-output-v3

node --env-file=signal-sniper-v2.env --import tsx src/bot-profiler-v3.ts

echo.
pause
