# Solana copy-trading bot — Pump.fun BUY

This bot watches the public Solana wallet:

`4DdrfDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh`

When it detects a successful Pump.fun transaction where that wallet receives a new token, it builds a Pump.fun bonding-curve BUY from the bot wallet.

Default copy size: **$10 per BUY**.

## Important

- Start with `DRY_RUN=true`.
- Use a separate wallet with only the amount you are willing to lose.
- Never put your seed phrase in chat.
- The private key is read only from your local `.env`.
- This version intentionally skips tokens that have already graduated to PumpAMM.
- It uses `processed` WebSocket logs to minimize detection latency, but no public-RPC bot can guarantee it will beat Axiom/the original trader.
- Network congestion, priority fees, RPC latency and the target's transaction path can still cause the copy to land later or fail.

## Setup

1. Install Node.js 20+.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env`.
5. Put your fast RPC HTTP and WebSocket endpoints in `.env`.
6. Create a dedicated Solana wallet for the bot.
7. Export its secret key locally as a JSON byte array and put it in `BOT_SECRET_KEY_JSON`.
8. Put a small amount of SOL in that bot wallet.
9. Keep `DRY_RUN=true` and run:

```bash
npm start
```

The bot will print detected buys and build transactions without sending them.

## Go live

Only after you have verified the dry-run output:

```env
DRY_RUN=false
```

Then restart:

```bash
npm start
```

## Speed

The watcher uses Solana's WebSocket `logsSubscribe` mechanism with `processed` commitment and then fetches the transaction. Solana documents `logsSubscribe` as supporting a `mentions` filter for a single address.

For lower latency than ordinary RPC, use a paid low-latency RPC/WebSocket provider. The next optimization is a Yellowstone/Shred feed plus a low-latency transaction relay, but that is a separate infrastructure step.

## Current execution path

Target wallet
→ Solana WebSocket
→ transaction fetch
→ Pump.fun BUY detection
→ Pump SDK bonding-curve state
→ local transaction construction
→ local wallet signature
→ Solana sendTransaction

The official Pump SDK currently exposes `OnlinePumpSdk.fetchBuyState()` and `buyInstructions()` for bonding-curve purchases.
