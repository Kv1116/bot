@echo off
cd /d "%~dp0"
set PROFILE_TARGET_WALLET=4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh
echo Profiling Mr Frog / TheMisterTurtle in READ-ONLY mode...
node --env-file=signal-sniper-v2.env --import tsx src\bot-profiler.ts
pause
