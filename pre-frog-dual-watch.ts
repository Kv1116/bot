import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ============================================================
// PRE-FROG DUAL LIVE WATCH
// READ-ONLY: never signs or sends transactions.
// ============================================================

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const RPC_URL = requiredEnv("RPC_URL");
const RPC_WS = (process.env.RPC_WS || "").trim() || undefined;

const DEFAULT_UPSTREAMS = [
  {
    name: "Cxkx",
    wallet: "CxkxCQYLWVRStkWwdCcsAX6BWcPnMeKGQ3zm2m6jVjV8",
  },
  {
    name: "Maze",
    wallet: "7j7AA3HZR2zEjwAQEKPFh2qucLY4fqZpB9iodf39w8xW",
  },
];

const FROG_WALLET = (
  process.env.FROG_WALLET ||
  "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh"
).trim();

const CORRELATION_WINDOW_SEC = clampInt(
  process.env.CORRELATION_WINDOW_SEC,
  15 * 60,
  10,
  24 * 60 * 60,
);

const FETCH_RETRIES = clampInt(
  process.env.WATCH_FETCH_RETRIES,
  14,
  1,
  50,
);

const FETCH_RETRY_MS = clampInt(
  process.env.WATCH_FETCH_RETRY_MS,
  90,
  20,
  5000,
);

const OUT_DIR = (
  process.env.PRE_FROG_OUT_DIR || "pre-frog-dual-output"
).trim();

const CSV_PATH = path.resolve(OUT_DIR, "pre-frog-dual.csv");
const JSONL_PATH = path.resolve(OUT_DIR, "pre-frog-dual.jsonl");

type Direction = "BUY" | "SELL";

type SourceDef = {
  name: string;
  wallet: string;
};

type TradeEvent = {
  label: "UPSTREAM" | "MR_FROG";
  sourceName: string;
  wallet: string;
  direction: Direction;
  venue: "Pump.fun" | "PumpSwap";
  mint: string;
  tokenAmount: number;
  walletSolDelta: number | null;
  slot: number;
  blockTime: number | null;
  signature: string;
  seenAtMs: number;
};

type UpstreamSignal = {
  event: TradeEvent;
  expiresAtMs: number;
};

const upstreams: SourceDef[] = loadUpstreams();
for (const s of upstreams) new PublicKey(s.wallet);
new PublicKey(FROG_WALLET);

fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(CSV_PATH)) {
  fs.writeFileSync(
    CSV_PATH,
    [
      "seen_iso",
      "label",
      "source_name",
      "wallet",
      "direction",
      "venue",
      "mint",
      "token_amount",
      "wallet_sol_delta",
      "slot",
      "signature",
      "lead_seconds_vs_upstream",
      "lead_slots_vs_upstream",
      "upstream_source",
      "upstream_wallet",
      "upstream_signature",
      "same_mint_upstream_count",
    ].join(",") + "\n",
  );
}

const processedSignatures = new Set<string>();

// mint -> upstream wallet -> signal
const armedByMint = new Map<string, Map<string, UpstreamSignal>>();

let upstreamBuyCount = 0;
let frogBuyCount = 0;
let frogMatchedCount = 0;
let dualSignalCount = 0;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
  wsEndpoint: RPC_WS,
  disableRetryOnRateLimit: false,
});

function requiredEnv(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function loadUpstreams(): SourceDef[] {
  const raw = (process.env.UPSTREAM_WALLETS || "").trim();
  if (!raw) return DEFAULT_UPSTREAMS;

  // Format:
  // Name1:wallet1,Name2:wallet2
  const parsed: SourceDef[] = [];
  for (const item of raw.split(",")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;

    const name = trimmed.slice(0, sep).trim();
    const wallet = trimmed.slice(sep + 1).trim();

    if (name && wallet) parsed.push({ name, wallet });
  }

  return parsed.length ? parsed : DEFAULT_UPSTREAMS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtSol(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(6)} SOL`;
}

function venueFromLogs(logs: string[] | null | undefined):
  | "Pump.fun"
  | "PumpSwap"
  | null {
  const arr = logs || [];
  if (arr.some((x) => x.includes(PUMP_PROGRAM))) return "Pump.fun";
  if (arr.some((x) => x.includes(PUMPSWAP_PROGRAM))) return "PumpSwap";
  return null;
}

function tokenDeltasForOwner(
  meta: any,
  owner: string,
): Array<{ mint: string; raw: bigint; decimals: number }> {
  const pre = new Map<string, { raw: bigint; decimals: number }>();
  const post = new Map<string, { raw: bigint; decimals: number }>();

  for (const b of meta?.preTokenBalances || []) {
    if (String(b?.owner || "") !== owner) continue;
    const mint = String(b?.mint || "");
    if (!mint || mint === WSOL_MINT) continue;

    const amount = BigInt(String(b?.uiTokenAmount?.amount || "0"));
    const decimals = Number(b?.uiTokenAmount?.decimals || 0);
    const prev = pre.get(mint);

    pre.set(mint, {
      raw: (prev?.raw || 0n) + amount,
      decimals,
    });
  }

  for (const b of meta?.postTokenBalances || []) {
    if (String(b?.owner || "") !== owner) continue;
    const mint = String(b?.mint || "");
    if (!mint || mint === WSOL_MINT) continue;

    const amount = BigInt(String(b?.uiTokenAmount?.amount || "0"));
    const decimals = Number(b?.uiTokenAmount?.decimals || 0);
    const prev = post.get(mint);

    post.set(mint, {
      raw: (prev?.raw || 0n) + amount,
      decimals,
    });
  }

  const mints = new Set([...pre.keys(), ...post.keys()]);
  const out: Array<{ mint: string; raw: bigint; decimals: number }> = [];

  for (const mint of mints) {
    const a = pre.get(mint);
    const b = post.get(mint);
    const decimals = b?.decimals ?? a?.decimals ?? 0;
    const delta = (b?.raw || 0n) - (a?.raw || 0n);
    if (delta !== 0n) out.push({ mint, raw: delta, decimals });
  }

  return out;
}

function rawToUi(raw: bigint, decimals: number): number {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  const frac = abs % base;
  const fracNum = Number(frac) / Number(base);
  const n = Number(whole) + fracNum;
  return neg ? -n : n;
}

function fullAccountKeys(tx: any): string[] {
  try {
    const message = tx?.transaction?.message;

    if (Array.isArray(message?.accountKeys)) {
      return message.accountKeys.map((x: any) =>
        typeof x === "string" ? x : String(x?.pubkey || x),
      );
    }

    const staticKeys = Array.isArray(message?.staticAccountKeys)
      ? message.staticAccountKeys.map((x: any) => String(x))
      : [];

    const loadedWritable = Array.isArray(tx?.meta?.loadedAddresses?.writable)
      ? tx.meta.loadedAddresses.writable.map((x: any) => String(x))
      : [];

    const loadedReadonly = Array.isArray(tx?.meta?.loadedAddresses?.readonly)
      ? tx.meta.loadedAddresses.readonly.map((x: any) => String(x))
      : [];

    return [...staticKeys, ...loadedWritable, ...loadedReadonly];
  } catch {
    return [];
  }
}

function walletSolDelta(tx: any, wallet: string): number | null {
  const keys = fullAccountKeys(tx);
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;

  const pre = Number(tx?.meta?.preBalances?.[idx]);
  const post = Number(tx?.meta?.postBalances?.[idx]);
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return null;

  return (post - pre) / LAMPORTS_PER_SOL;
}

async function fetchTx(signature: string): Promise<any | null> {
  let delay = FETCH_RETRY_MS;

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx) return tx;
    } catch {}

    await sleep(delay);
    delay = Math.min(1000, Math.ceil(delay * 1.35));
  }

  return null;
}

function cleanupSignals(nowMs: number) {
  for (const [mint, byWallet] of armedByMint.entries()) {
    for (const [wallet, signal] of byWallet.entries()) {
      if (signal.expiresAtMs < nowMs) byWallet.delete(wallet);
    }
    if (!byWallet.size) armedByMint.delete(mint);
  }
}

function getSignalsForMint(mint: string): UpstreamSignal[] {
  cleanupSignals(Date.now());
  return Array.from(armedByMint.get(mint)?.values() || [])
    .sort((a, b) => a.event.seenAtMs - b.event.seenAtMs);
}

function appendEvent(
  event: TradeEvent,
  correlation?: {
    leadSeconds: number;
    leadSlots: number;
    upstreamSource: string;
    upstreamWallet: string;
    upstreamSignature: string;
    sameMintUpstreamCount: number;
  },
) {
  const record = {
    ...event,
    leadSecondsVsUpstream: correlation?.leadSeconds ?? null,
    leadSlotsVsUpstream: correlation?.leadSlots ?? null,
    upstreamSource: correlation?.upstreamSource ?? null,
    upstreamWallet: correlation?.upstreamWallet ?? null,
    upstreamSignature: correlation?.upstreamSignature ?? null,
    sameMintUpstreamCount: correlation?.sameMintUpstreamCount ?? 0,
  };

  fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + "\n");

  fs.appendFileSync(
    CSV_PATH,
    [
      new Date(event.seenAtMs).toISOString(),
      event.label,
      event.sourceName,
      event.wallet,
      event.direction,
      event.venue,
      event.mint,
      event.tokenAmount,
      event.walletSolDelta ?? "",
      event.slot,
      event.signature,
      correlation?.leadSeconds ?? "",
      correlation?.leadSlots ?? "",
      correlation?.upstreamSource ?? "",
      correlation?.upstreamWallet ?? "",
      correlation?.upstreamSignature ?? "",
      correlation?.sameMintUpstreamCount ?? 0,
    ].map(csvEscape).join(",") + "\n",
  );
}

function printTrade(event: TradeEvent) {
  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log(
    `${event.label === "UPSTREAM" ? "UPSTREAM" : "MR FROG"} ${event.sourceName} ${event.direction}`,
  );
  console.log("────────────────────────────────────────────────────────────");
  console.log(`Time.............. ${new Date(event.seenAtMs).toLocaleTimeString()}`);
  console.log(`Wallet............ ${event.wallet}`);
  console.log(`Venue............. ${event.venue}`);
  console.log(`Mint.............. ${event.mint}`);
  console.log(`Token amount...... ${event.tokenAmount}`);
  console.log(`Wallet SOL delta.. ${fmtSol(event.walletSolDelta)}`);
  console.log(`Slot.............. ${event.slot}`);
  console.log(`Signature......... ${event.signature}`);
  console.log(`Solscan........... https://solscan.io/tx/${event.signature}`);
}

async function processSignature(
  label: "UPSTREAM" | "MR_FROG",
  sourceName: string,
  wallet: string,
  signature: string,
  slotFromLog: number,
  seenAtMs: number,
) {
  const dedupeKey = `${wallet}:${signature}`;
  if (processedSignatures.has(dedupeKey)) return;
  processedSignatures.add(dedupeKey);

  const tx = await fetchTx(signature);
  if (!tx || tx?.meta?.err) return;

  const venue = venueFromLogs(tx?.meta?.logMessages);
  if (!venue) return;

  const deltas = tokenDeltasForOwner(tx?.meta, wallet);
  if (!deltas.length) return;

  const solDelta = walletSolDelta(tx, wallet);
  const slot = Number(tx?.slot || slotFromLog || 0);
  const blockTime = tx?.blockTime == null ? null : Number(tx.blockTime);

  for (const delta of deltas) {
    const direction: Direction = delta.raw > 0n ? "BUY" : "SELL";

    const event: TradeEvent = {
      label,
      sourceName,
      wallet,
      direction,
      venue,
      mint: delta.mint,
      tokenAmount: Math.abs(rawToUi(delta.raw, delta.decimals)),
      walletSolDelta: solDelta,
      slot,
      blockTime,
      signature,
      seenAtMs,
    };

    printTrade(event);

    if (label === "UPSTREAM" && direction === "BUY") {
      upstreamBuyCount += 1;

      let byWallet = armedByMint.get(delta.mint);
      if (!byWallet) {
        byWallet = new Map<string, UpstreamSignal>();
        armedByMint.set(delta.mint, byWallet);
      }

      const alreadyHadOther = byWallet.size > 0 && !byWallet.has(wallet);

      byWallet.set(wallet, {
        event,
        expiresAtMs: seenAtMs + CORRELATION_WINDOW_SEC * 1000,
      });

      const signals = getSignalsForMint(delta.mint);

      console.log("");
      console.log(`>>> ${sourceName} PRE-FROG SIGNAL ARMED`);
      console.log(
        `>>> Watching this mint for Mr Frog for ${CORRELATION_WINDOW_SEC}s`,
      );

      if (alreadyHadOther && signals.length >= 2) {
        dualSignalCount += 1;
        console.log("");
        console.log("######################################################");
        console.log("🔥🔥 DUAL UPSTREAM SIGNAL");
        console.log(`SAME MINT bought by ${signals.length} upstream wallets`);
        for (const s of signals) {
          console.log(
            `  ${s.event.sourceName}: ${s.event.wallet} @ ${new Date(s.event.seenAtMs).toLocaleTimeString()}`,
          );
        }
        console.log("######################################################");
      }

      appendEvent(event);
      continue;
    }

    if (label === "MR_FROG" && direction === "BUY") {
      frogBuyCount += 1;

      const signals = getSignalsForMint(delta.mint)
        .filter((s) => s.event.seenAtMs <= seenAtMs);

      if (signals.length) {
        frogMatchedCount += 1;

        console.log("");
        console.log("******************************************************");
        console.log("🔥 PRE-FROG MATCH");
        console.log(
          `${signals.length} upstream wallet(s) bought SAME MINT before Mr Frog`,
        );

        for (const s of signals) {
          const leadSeconds =
            (seenAtMs - s.event.seenAtMs) / 1000;
          const leadSlots =
            slot - s.event.slot;

          console.log(
            `  ${s.event.sourceName}: ${leadSeconds.toFixed(3)}s lead | ${leadSlots} slots`,
          );

          appendEvent(event, {
            leadSeconds,
            leadSlots,
            upstreamSource: s.event.sourceName,
            upstreamWallet: s.event.wallet,
            upstreamSignature: s.event.signature,
            sameMintUpstreamCount: signals.length,
          });
        }

        console.log("******************************************************");
      } else {
        console.log("");
        console.log(
          "No live upstream BUY for this mint inside the correlation window.",
        );
        appendEvent(event);
      }

      console.log(
        `[STATS] upstream BUYs=${upstreamBuyCount} | Frog BUYs=${frogBuyCount} | Frog matches=${frogMatchedCount} | dual signals=${dualSignalCount}`,
      );
      continue;
    }

    appendEvent(event);
  }
}

async function subscribeWallet(
  label: "UPSTREAM" | "MR_FROG",
  sourceName: string,
  wallet: string,
) {
  const pubkey = new PublicKey(wallet);

  return connection.onLogs(
    pubkey,
    (logs, ctx) => {
      const seenAtMs = Date.now();
      void processSignature(
        label,
        sourceName,
        wallet,
        logs.signature,
        ctx.slot,
        seenAtMs,
      ).catch((err) => {
        console.error(
          `[${sourceName}] processing error for ${logs.signature}:`,
          err?.message || err,
        );
      });
    },
    "processed",
  );
}

async function main() {
  console.log("============================================================");
  console.log("              PRE-FROG DUAL LIVE WATCH");
  console.log("                    READ-ONLY MODE");
  console.log("============================================================");

  for (const s of upstreams) {
    console.log(`${s.name.padEnd(18)} ${s.wallet}`);
  }

  console.log(`Mr Frog            ${FROG_WALLET}`);
  console.log(`Correlation window ${CORRELATION_WINDOW_SEC}s`);
  console.log(`CSV                ${CSV_PATH}`);
  console.log(`JSONL              ${JSONL_PATH}`);
  console.log("============================================================");
  console.log("");
  console.log("[>] Checking RPC...");

  const slot = await connection.getSlot("processed");
  console.log(`[OK] RPC slot ${slot}`);

  const subscriptions: number[] = [];

  console.log("[>] Subscribing upstream wallets...");
  for (const s of upstreams) {
    const id = await subscribeWallet("UPSTREAM", s.name, s.wallet);
    subscriptions.push(id);
    console.log(`[OK] ${s.name} subscription ID: ${id}`);
  }

  const frogSub = await subscribeWallet(
    "MR_FROG",
    "MrFrog",
    FROG_WALLET,
  );
  subscriptions.push(frogSub);
  console.log(`[OK] Mr Frog subscription ID: ${frogSub}`);

  console.log("");
  console.log("[WATCHING]");
  console.log("  1 upstream BUY  -> PRE-FROG SIGNAL");
  console.log("  2 upstream BUYs -> DUAL UPSTREAM SIGNAL");
  console.log("  Mr Frog same mint later -> PRE-FROG MATCH");
  console.log("");
  console.log("READ-ONLY: no transaction can be signed or sent.");
  console.log("Press Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("\nStopping subscriptions...");
    for (const id of subscriptions) {
      try {
        await connection.removeOnLogsListener(id);
      } catch {}
    }
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("\nFATAL WATCH ERROR:");
  console.error(err);
  process.exitCode = 1;
});
