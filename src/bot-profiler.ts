import fs from "node:fs";
import path from "node:path";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

// ============================================================
// BOT PROFILER / ALPHA FORENSICS
// ------------------------------------------------------------
// READ-ONLY: this file never signs or sends a transaction.
// It profiles a public Solana wallet to answer:
//   - how quickly it buys after token creation
//   - how long it holds
//   - whether the same creators repeat
//   - which wallets repeatedly buy BEFORE it
//   - whether the same signer / transfer recipient repeats
//   - optional Birdeye first-buyer + funder enrichment
//
// Run from the existing solana-copy-bot folder:
//   node --env-file=signal-sniper-v2.env --import tsx src/bot-profiler.ts
//
// Optional env overrides are listed in BOT-PROFILER-README.txt.
// ============================================================

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const RPC_URL = requiredEnv("RPC_URL");
const TARGET_WALLET = (
  process.env.PROFILE_TARGET_WALLET ||
  process.env.TARGET_WALLET ||
  "4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh"
).trim();

const PROFILE_TX_LIMIT = clampInt(process.env.PROFILE_TX_LIMIT, 200, 20, 1000);
const PROFILE_DEEP_MINTS = clampInt(process.env.PROFILE_DEEP_MINTS, 12, 0, 50);
const PROFILE_FIRST_BUYERS = clampInt(process.env.PROFILE_FIRST_BUYERS, 20, 3, 100);
const PROFILE_MINT_SIG_SCAN_LIMIT = clampInt(process.env.PROFILE_MINT_SIG_SCAN_LIMIT, 700, 50, 3000);
const PROFILE_CREATE_LOOKBACK_SEC = clampInt(process.env.PROFILE_CREATE_LOOKBACK_SEC, 180, 30, 3600);
const PROFILE_POST_BUY_SEC = clampInt(process.env.PROFILE_POST_BUY_SEC, 3, 0, 60);
const PROFILE_RPC_BATCH = clampInt(process.env.PROFILE_RPC_BATCH, 35, 5, 100);
const PROFILE_BATCH_DELAY_MS = clampInt(process.env.PROFILE_BATCH_DELAY_MS, 120, 0, 5000);
const PROFILE_OUT_DIR = (process.env.PROFILE_OUT_DIR || "profiler-output").trim();
const BIRDEYE_API_KEY = (process.env.BIRDEYE_API_KEY || "").trim();
const BIRDEYE_ENABLED = BIRDEYE_API_KEY.length > 0;

// ============================================================
// TYPES
// ============================================================

type SigInfo = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
};

type Trade = {
  signature: string;
  slot: number;
  blockTime: number;
  txIndex: number | null;
  venue: "Pump.fun" | "PumpSwap";
  mint: string;
  direction: "BUY" | "SELL";
  rawDelta: bigint;
  decimals: number;
  tokenAmount: number;
  walletSolDelta: number;
  feeSol: number;
  computeBudgetIxCount: number;
  signers: string[];
  extraSigners: string[];
  outboundTransfers: Array<{ to: string; sol: number }>;
};

type MintPosition = {
  mint: string;
  trades: Trade[];
  firstBuy: Trade | null;
  firstSellAfterBuy: Trade | null;
  closeTrade: Trade | null;
  holdSeconds: number | null;
  buyCount: number;
  sellCount: number;
  boughtTokens: number;
  soldTokens: number;
  estimatedBuySol: number;
  estimatedSellSol: number;
};

type EarlyBuyer = {
  wallet: string;
  firstSignature: string;
  slot: number;
  blockTime: number;
  txIndex: number | null;
  tokenAmount: number;
  source: "onchain" | "birdeye";
  tags: string[];
};

type DeepMint = {
  mint: string;
  targetFirstBuySignature: string;
  targetFirstBuySlot: number;
  targetFirstBuyTime: number;
  creationSignature: string | null;
  creationSlot: number | null;
  creationTime: number | null;
  creator: string | null;
  creatorSource: "onchain-inferred" | "birdeye" | null;
  createToTargetMs: number | null;
  sameSlotAsCreate: boolean | null;
  createTxIndex: number | null;
  targetTxIndex: number | null;
  sameSlotTxDistance: number | null;
  targetBuyerRank: number | null;
  buyersBeforeTarget: string[];
  firstBuyers: EarlyBuyer[];
  creatorFunder: string | null;
  creatorFunderAmountSol: number | null;
  creatorFundingTx: string | null;
  birdeyeNotes: string[];
  scanNotes: string[];
};

// ============================================================
// BASIC HELPERS
// ============================================================

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(address: string, n = 5): string {
  if (address.length <= n * 2 + 3) return address;
  return `${address.slice(0, n)}...${address.slice(-n)}`;
}

function fmtSec(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "n/a";
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(2)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(2)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(2)} h`;
  return `${(sec / 86400).toFixed(2)} d`;
}

function median(values: number[]): number | null {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function pct(n: number, d: number): string {
  if (!d) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function safeJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

function normalizeKey(k: any): string {
  if (typeof k === "string") return k;
  if (k?.pubkey) return typeof k.pubkey === "string" ? k.pubkey : String(k.pubkey);
  return String(k ?? "");
}

function txAccountKeys(tx: any): string[] {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.map(normalizeKey);
}

function txSigners(tx: any): string[] {
  const keys = tx?.transaction?.message?.accountKeys || [];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === "object" && k?.signer) out.push(normalizeKey(k));
  }
  if (out.length) return out;

  // Fallback for non-jsonParsed-like responses: first N signatures correspond
  // to required signers, but we usually use jsonParsed so this path is rare.
  const header = tx?.transaction?.message?.header;
  const n = Number(header?.numRequiredSignatures || 0);
  return txAccountKeys(tx).slice(0, n);
}

function logsContainCreate(tx: any): boolean {
  const logs: string[] = tx?.meta?.logMessages || [];
  return logs.some((l) => /Instruction:\s*Create(?:V2|Token)?\b/i.test(l));
}

function venueFromTx(tx: any): "Pump.fun" | "PumpSwap" | null {
  const keys = new Set(txAccountKeys(tx));
  const logs: string[] = tx?.meta?.logMessages || [];
  const joined = logs.join("\n");
  if (keys.has(PUMP_PROGRAM) || joined.includes(PUMP_PROGRAM)) return "Pump.fun";
  if (keys.has(PUMPSWAP_PROGRAM) || joined.includes(PUMPSWAP_PROGRAM)) return "PumpSwap";
  return null;
}

function rawTokenMapForOwner(meta: any, owner: string): Map<string, { raw: bigint; decimals: number }> {
  const out = new Map<string, { raw: bigint; decimals: number }>();
  const add = (entry: any, sign: bigint) => {
    if (!entry || entry.owner !== owner || !entry.mint) return;
    const amount = entry.uiTokenAmount?.amount;
    if (amount === undefined) return;
    const decimals = Number(entry.uiTokenAmount?.decimals || 0);
    const prev = out.get(entry.mint) || { raw: 0n, decimals };
    prev.raw += sign * BigInt(String(amount));
    prev.decimals = decimals;
    out.set(entry.mint, prev);
  };
  for (const x of meta?.preTokenBalances || []) add(x, -1n);
  for (const x of meta?.postTokenBalances || []) add(x, 1n);
  return out;
}

function tokenOwnerDeltasForMint(meta: any, mint: string): Map<string, { raw: bigint; decimals: number }> {
  const out = new Map<string, { raw: bigint; decimals: number }>();
  const add = (entry: any, sign: bigint) => {
    if (!entry || entry.mint !== mint || !entry.owner) return;
    const amount = entry.uiTokenAmount?.amount;
    if (amount === undefined) return;
    const decimals = Number(entry.uiTokenAmount?.decimals || 0);
    const prev = out.get(entry.owner) || { raw: 0n, decimals };
    prev.raw += sign * BigInt(String(amount));
    prev.decimals = decimals;
    out.set(entry.owner, prev);
  };
  for (const x of meta?.preTokenBalances || []) add(x, -1n);
  for (const x of meta?.postTokenBalances || []) add(x, 1n);
  return out;
}

function rawToUi(raw: bigint, decimals: number): number {
  const divisor = 10 ** Math.min(decimals, 18);
  return Number(raw) / divisor;
}

function extractAllInstructions(tx: any): any[] {
  const outer = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap((x: any) => x?.instructions || []);
  return [...outer, ...inner];
}

function outboundSystemTransfers(tx: any, source: string): Array<{ to: string; sol: number }> {
  const transfers: Array<{ to: string; sol: number }> = [];
  for (const ix of extractAllInstructions(tx)) {
    const programId = normalizeKey(ix?.programId);
    const program = String(ix?.program || "");
    const parsed = ix?.parsed;
    if (!(programId === SYSTEM_PROGRAM || program === "system")) continue;
    if (!parsed || parsed.type !== "transfer") continue;
    const info = parsed.info || {};
    if (info.source !== source) continue;
    const lamports = Number(info.lamports ?? 0);
    if (lamports <= 0) continue;
    transfers.push({ to: String(info.destination || ""), sol: lamports / LAMPORTS_PER_SOL });
  }
  return transfers;
}

function computeBudgetCount(tx: any): number {
  let count = 0;
  for (const ix of extractAllInstructions(tx)) {
    if (normalizeKey(ix?.programId) === COMPUTE_BUDGET_PROGRAM) count++;
  }
  return count;
}

// ============================================================
// RPC
// ============================================================

let rpcId = 1;

async function rpcCall<T = any>(method: string, params: any[]): Promise<T> {
  const body = { jsonrpc: "2.0", id: rpcId++, method, params };
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

async function rpcBatch<T = any>(calls: Array<{ method: string; params: any[] }>): Promise<Array<T | null>> {
  if (!calls.length) return [];
  const startId = rpcId;
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: startId + i, method: c.method, params: c.params }));
  rpcId += calls.length;

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC batch HTTP ${res.status}: ${await res.text()}`);
  const json: any[] = await res.json();
  const byId = new Map<number, any>();
  for (const item of json) byId.set(Number(item.id), item);
  return calls.map((_c, i) => {
    const item = byId.get(startId + i);
    if (!item || item.error) return null;
    return (item.result ?? null) as T | null;
  });
}

async function getSignatures(address: string, limit: number): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  while (out.length < limit) {
    const pageLimit = Math.min(1000, limit - out.length);
    const opts: any = { limit: pageLimit, commitment: "confirmed" };
    if (before) opts.before = before;
    const page = await rpcCall<any[]>("getSignaturesForAddress", [address, opts]);
    if (!page.length) break;
    out.push(...page.map((x) => ({
      signature: String(x.signature),
      slot: Number(x.slot),
      blockTime: x.blockTime == null ? null : Number(x.blockTime),
      err: x.err,
    })));
    before = page[page.length - 1].signature;
    if (page.length < pageLimit) break;
    if (PROFILE_BATCH_DELAY_MS) await sleep(PROFILE_BATCH_DELAY_MS);
  }
  return out.slice(0, limit);
}

async function getTransactions(signatures: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (let i = 0; i < signatures.length; i += PROFILE_RPC_BATCH) {
    const chunk = signatures.slice(i, i + PROFILE_RPC_BATCH);
    const results = await rpcBatch<any>(
      chunk.map((sig) => ({
        method: "getTransaction",
        params: [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
      })),
    );
    results.forEach((tx, j) => {
      if (tx) out.set(chunk[j], tx);
    });
    process.stdout.write(`\r[RPC] transactions ${Math.min(i + chunk.length, signatures.length)}/${signatures.length}`);
    if (PROFILE_BATCH_DELAY_MS) await sleep(PROFILE_BATCH_DELAY_MS);
  }
  process.stdout.write("\n");
  return out;
}

async function getBlockSignatureIndexes(slots: number[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(slots)].filter(Number.isFinite);
  for (let i = 0; i < unique.length; i += PROFILE_RPC_BATCH) {
    const chunk = unique.slice(i, i + PROFILE_RPC_BATCH);
    const results = await rpcBatch<any>(
      chunk.map((slot) => ({
        method: "getBlock",
        params: [slot, { commitment: "confirmed", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 }],
      })),
    );
    results.forEach((block, j) => {
      if (!block?.signatures) return;
      block.signatures.forEach((sig: string, idx: number) => out.set(sig, idx));
    });
    if (PROFILE_BATCH_DELAY_MS) await sleep(PROFILE_BATCH_DELAY_MS);
  }
  return out;
}

// ============================================================
// TARGET HISTORY PARSING
// ============================================================

function parseTargetTrades(sigInfos: SigInfo[], txMap: Map<string, any>): Trade[] {
  const sigById = new Map(sigInfos.map((x) => [x.signature, x]));
  const trades: Trade[] = [];

  for (const [signature, tx] of txMap.entries()) {
    const venue = venueFromTx(tx);
    if (!venue || !tx?.meta || tx.meta.err) continue;

    const blockTime = Number(tx.blockTime ?? sigById.get(signature)?.blockTime ?? 0);
    const slot = Number(tx.slot ?? sigById.get(signature)?.slot ?? 0);
    if (!blockTime || !slot) continue;

    const keys = txAccountKeys(tx);
    const walletIndex = keys.indexOf(TARGET_WALLET);
    const preLamports = walletIndex >= 0 ? Number(tx.meta.preBalances?.[walletIndex] ?? 0) : 0;
    const postLamports = walletIndex >= 0 ? Number(tx.meta.postBalances?.[walletIndex] ?? 0) : 0;
    const walletSolDelta = (postLamports - preLamports) / LAMPORTS_PER_SOL;
    const feeSol = Number(tx.meta.fee || 0) / LAMPORTS_PER_SOL;

    const tokenDeltas = rawTokenMapForOwner(tx.meta, TARGET_WALLET);
    for (const [mint, delta] of tokenDeltas.entries()) {
      if (mint === WSOL_MINT || delta.raw === 0n) continue;
      const direction: "BUY" | "SELL" = delta.raw > 0n ? "BUY" : "SELL";
      const signers = txSigners(tx);
      trades.push({
        signature,
        slot,
        blockTime,
        txIndex: null,
        venue,
        mint,
        direction,
        rawDelta: delta.raw,
        decimals: delta.decimals,
        tokenAmount: Math.abs(rawToUi(delta.raw, delta.decimals)),
        walletSolDelta,
        feeSol,
        computeBudgetIxCount: computeBudgetCount(tx),
        signers,
        extraSigners: signers.filter((s) => s !== TARGET_WALLET),
        outboundTransfers: outboundSystemTransfers(tx, TARGET_WALLET),
      });
    }
  }

  trades.sort((a, b) => a.slot - b.slot || a.blockTime - b.blockTime || a.signature.localeCompare(b.signature));
  return trades;
}

function buildPositions(trades: Trade[]): MintPosition[] {
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) {
    if (!byMint.has(t.mint)) byMint.set(t.mint, []);
    byMint.get(t.mint)!.push(t);
  }

  const positions: MintPosition[] = [];
  for (const [mint, xs0] of byMint.entries()) {
    const xs = [...xs0].sort((a, b) => a.slot - b.slot || a.blockTime - b.blockTime);
    const firstBuy = xs.find((x) => x.direction === "BUY") || null;
    const firstSellAfterBuy = firstBuy
      ? xs.find((x) => x.direction === "SELL" && x.blockTime >= firstBuy.blockTime) || null
      : null;

    let running = 0n;
    let started = false;
    let closeTrade: Trade | null = null;
    for (const x of xs) {
      if (x.direction === "BUY") {
        running += x.rawDelta > 0n ? x.rawDelta : -x.rawDelta;
        started = true;
      } else if (started) {
        running -= x.rawDelta < 0n ? -x.rawDelta : x.rawDelta;
        if (running <= 0n) {
          closeTrade = x;
          break;
        }
      }
    }

    const holdSeconds = firstBuy && (closeTrade || firstSellAfterBuy)
      ? (Number((closeTrade || firstSellAfterBuy)!.blockTime) - firstBuy.blockTime)
      : null;

    const buys = xs.filter((x) => x.direction === "BUY");
    const sells = xs.filter((x) => x.direction === "SELL");
    const boughtTokens = buys.reduce((s, x) => s + x.tokenAmount, 0);
    const soldTokens = sells.reduce((s, x) => s + x.tokenAmount, 0);

    // SOL deltas include fees/tips, so these are estimates only.
    const estimatedBuySol = buys.reduce((s, x) => s + Math.max(0, -x.walletSolDelta), 0);
    const estimatedSellSol = sells.reduce((s, x) => s + Math.max(0, x.walletSolDelta), 0);

    positions.push({
      mint,
      trades: xs,
      firstBuy,
      firstSellAfterBuy,
      closeTrade,
      holdSeconds,
      buyCount: buys.length,
      sellCount: sells.length,
      boughtTokens,
      soldTokens,
      estimatedBuySol,
      estimatedSellSol,
    });
  }

  positions.sort((a, b) => (b.firstBuy?.blockTime || 0) - (a.firstBuy?.blockTime || 0));
  return positions;
}

// ============================================================
// DEEP PER-MINT ON-CHAIN SCAN
// ============================================================

async function signaturesAroundMint(mint: string, targetTime: number): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  const oldestWanted = targetTime - PROFILE_CREATE_LOOKBACK_SEC;

  while (out.length < PROFILE_MINT_SIG_SCAN_LIMIT) {
    const pageLimit = Math.min(1000, PROFILE_MINT_SIG_SCAN_LIMIT - out.length);
    const opts: any = { limit: pageLimit, commitment: "confirmed" };
    if (before) opts.before = before;
    const page = await rpcCall<any[]>("getSignaturesForAddress", [mint, opts]);
    if (!page.length) break;

    const mapped = page.map((x) => ({
      signature: String(x.signature),
      slot: Number(x.slot),
      blockTime: x.blockTime == null ? null : Number(x.blockTime),
      err: x.err,
    }));
    out.push(...mapped);

    const oldest = mapped[mapped.length - 1]?.blockTime;
    if (oldest != null && oldest <= oldestWanted) break;
    before = mapped[mapped.length - 1].signature;
    if (page.length < pageLimit) break;
    if (PROFILE_BATCH_DELAY_MS) await sleep(PROFILE_BATCH_DELAY_MS);
  }

  return out.filter((x) => {
    const t = x.blockTime ?? 0;
    return t >= targetTime - PROFILE_CREATE_LOOKBACK_SEC && t <= targetTime + PROFILE_POST_BUY_SEC;
  });
}

async function onChainDeepScan(position: MintPosition): Promise<DeepMint> {
  const firstBuy = position.firstBuy!;
  const notes: string[] = [];
  const sigs = await signaturesAroundMint(position.mint, firstBuy.blockTime);
  if (!sigs.length) notes.push("No mint signatures found in configured time window.");

  const txs = await getTransactions(sigs.map((x) => x.signature));
  const slots = [...new Set([...txs.values()].map((tx: any) => Number(tx?.slot || 0)).filter(Boolean))];
  const sigIndexes = await getBlockSignatureIndexes(slots);

  let createTx: any | null = null;
  let createSig: string | null = null;
  let creator: string | null = null;
  let creatorSource: DeepMint["creatorSource"] = null;

  const orderedTxs = [...txs.entries()].sort((a, b) => {
    const ta = Number(a[1]?.blockTime || 0);
    const tb = Number(b[1]?.blockTime || 0);
    const sa = Number(a[1]?.slot || 0);
    const sb = Number(b[1]?.slot || 0);
    const ia = sigIndexes.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const ib = sigIndexes.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || ia - ib || ta - tb;
  });

  for (const [sig, tx] of orderedTxs) {
    if (venueFromTx(tx) === "Pump.fun" && logsContainCreate(tx)) {
      createTx = tx;
      createSig = sig;
      const signers = txSigners(tx);
      creator = signers[0] || null;
      creatorSource = creator ? "onchain-inferred" : null;
      break;
    }
  }

  if (!createTx && orderedTxs.length) {
    // We refuse to call the earliest arbitrary tx a confirmed creation; keep it
    // only as a diagnostic note.
    notes.push("Pump Create instruction not found in scanned window; creation timing may be unknown.");
  }

  const buyers: EarlyBuyer[] = [];
  const seenBuyer = new Set<string>();
  for (const [sig, tx] of orderedTxs) {
    const bt = Number(tx?.blockTime || 0);
    const slot = Number(tx?.slot || 0);
    if (!bt || !slot || bt > firstBuy.blockTime + PROFILE_POST_BUY_SEC) continue;
    const deltas = tokenOwnerDeltasForMint(tx?.meta, position.mint);
    for (const [owner, d] of deltas.entries()) {
      if (d.raw <= 0n || seenBuyer.has(owner)) continue;
      seenBuyer.add(owner);
      buyers.push({
        wallet: owner,
        firstSignature: sig,
        slot,
        blockTime: bt,
        txIndex: sigIndexes.get(sig) ?? null,
        tokenAmount: rawToUi(d.raw, d.decimals),
        source: "onchain",
        tags: [],
      });
    }
  }

  buyers.sort((a, b) => a.slot - b.slot || (a.txIndex ?? 999999) - (b.txIndex ?? 999999) || a.blockTime - b.blockTime);
  const targetBuyerRankIndex = buyers.findIndex((x) => x.wallet === TARGET_WALLET);
  const targetBuyerRank = targetBuyerRankIndex >= 0 ? targetBuyerRankIndex + 1 : null;
  const buyersBeforeTarget = targetBuyerRankIndex > 0
    ? buyers.slice(0, targetBuyerRankIndex).map((x) => x.wallet)
    : [];

  const creationTime = createTx ? Number(createTx.blockTime || 0) || null : null;
  const creationSlot = createTx ? Number(createTx.slot || 0) || null : null;
  const createTxIndex = createSig ? sigIndexes.get(createSig) ?? null : null;
  const targetTxIndex = sigIndexes.get(firstBuy.signature) ?? null;
  const sameSlotAsCreate = creationSlot != null ? creationSlot === firstBuy.slot : null;
  const sameSlotTxDistance = sameSlotAsCreate && createTxIndex != null && targetTxIndex != null
    ? targetTxIndex - createTxIndex
    : null;
  const createToTargetMs = creationTime != null ? (firstBuy.blockTime - creationTime) * 1000 : null;

  return {
    mint: position.mint,
    targetFirstBuySignature: firstBuy.signature,
    targetFirstBuySlot: firstBuy.slot,
    targetFirstBuyTime: firstBuy.blockTime,
    creationSignature: createSig,
    creationSlot,
    creationTime,
    creator,
    creatorSource,
    createToTargetMs,
    sameSlotAsCreate,
    createTxIndex,
    targetTxIndex,
    sameSlotTxDistance,
    targetBuyerRank,
    buyersBeforeTarget,
    firstBuyers: buyers.slice(0, PROFILE_FIRST_BUYERS),
    creatorFunder: null,
    creatorFunderAmountSol: null,
    creatorFundingTx: null,
    birdeyeNotes: [],
    scanNotes: notes,
  };
}

// ============================================================
// OPTIONAL BIRDEYE ENRICHMENT
// ============================================================

async function birdeyeGet(pathname: string, params: Record<string, string | number>): Promise<any> {
  if (!BIRDEYE_ENABLED) throw new Error("BIRDEYE_API_KEY not configured");
  const url = new URL(`https://public-api.birdeye.so${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "X-API-KEY": BIRDEYE_API_KEY,
      "x-chain": "solana",
    },
  });
  if (!res.ok) throw new Error(`Birdeye ${pathname} HTTP ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  if (json?.success === false) throw new Error(`Birdeye ${pathname}: ${JSON.stringify(json)}`);
  return json?.data ?? json;
}

function firstString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function firstNumber(obj: any, keys: string[]): number | null {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function findArrayPayload(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of ["items", "list", "buyers", "data", "results", "funders"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

async function enrichDeepMintWithBirdeye(deep: DeepMint): Promise<void> {
  try {
    const creation = await birdeyeGet("/defi/token_creation_info", { address: deep.mint });
    const creator = firstString(creation, ["creator", "creatorAddress", "creator_address", "owner", "deployer", "deployerAddress", "wallet"]);
    const creationSig = firstString(creation, ["txHash", "tx_hash", "signature", "transaction", "transactionHash"]);
    const unix = firstNumber(creation, ["blockUnixTime", "block_unix_time", "unixTime", "unix_time", "timestamp"]);
    if (creator) {
      deep.creator = creator;
      deep.creatorSource = "birdeye";
    }
    if (creationSig) deep.creationSignature = creationSig;
    if (unix) {
      deep.creationTime = unix;
      deep.createToTargetMs = (deep.targetFirstBuyTime - unix) * 1000;
    }
  } catch (e: any) {
    deep.birdeyeNotes.push(`creation_info failed: ${e?.message || e}`);
  }

  try {
    const fb = await birdeyeGet("/token/v1/first-buyers", {
      token_address: deep.mint,
      offset: 0,
      limit: PROFILE_FIRST_BUYERS,
    });
    const rows = findArrayPayload(fb);
    const parsed: EarlyBuyer[] = [];
    for (const row of rows) {
      const wallet = firstString(row, ["wallet", "walletAddress", "wallet_address", "owner", "ownerAddress", "owner_address", "address"]);
      if (!wallet) continue;
      const sig = firstString(row, ["txHash", "tx_hash", "signature", "firstBuyTx", "first_buy_tx"]) || "";
      const unix = firstNumber(row, ["blockUnixTime", "block_unix_time", "unixTime", "unix_time", "timestamp", "firstBuyTime", "first_buy_time"]) || 0;
      const amount = firstNumber(row, ["firstBuyAmount", "first_buy_amount", "amount", "tokenAmount", "token_amount"]) || 0;
      const tagsRaw = row?.tags ?? row?.walletTags ?? row?.wallet_tags ?? [];
      const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : typeof tagsRaw === "string" ? [tagsRaw] : [];
      parsed.push({ wallet, firstSignature: sig, slot: 0, blockTime: unix, txIndex: null, tokenAmount: amount, source: "birdeye", tags });
    }
    if (parsed.length) {
      deep.firstBuyers = parsed;
      const idx = parsed.findIndex((x) => x.wallet === TARGET_WALLET);
      deep.targetBuyerRank = idx >= 0 ? idx + 1 : deep.targetBuyerRank;
      deep.buyersBeforeTarget = idx > 0 ? parsed.slice(0, idx).map((x) => x.wallet) : deep.buyersBeforeTarget;
    }
  } catch (e: any) {
    deep.birdeyeNotes.push(`first-buyers failed: ${e?.message || e}`);
  }

  if (deep.creator) {
    try {
      const funded = await birdeyeGet("/wallet/v2/funded-by", { wallet: deep.creator });
      const funders = findArrayPayload(funded);
      const f = funders[0] || funded;
      const funder = firstString(f, ["funder", "wallet", "address", "from"]);
      const amountRaw = firstNumber(f, ["amount", "solAmount", "sol_amount"]);
      const sig = firstString(f, ["tx_hash", "txHash", "signature"]);
      if (funder) deep.creatorFunder = funder;
      if (amountRaw != null) {
        // Birdeye may return raw lamports or scaled SOL depending on endpoint version.
        deep.creatorFunderAmountSol = amountRaw > 1_000_000 ? amountRaw / LAMPORTS_PER_SOL : amountRaw;
      }
      if (sig) deep.creatorFundingTx = sig;
    } catch (e: any) {
      deep.birdeyeNotes.push(`creator funded-by failed: ${e?.message || e}`);
    }
  }
}

async function birdeyeFunder(wallet: string): Promise<string | null> {
  if (!BIRDEYE_ENABLED) return null;
  try {
    const funded = await birdeyeGet("/wallet/v2/funded-by", { wallet });
    const rows = findArrayPayload(funded);
    const f = rows[0] || funded;
    return firstString(f, ["funder", "wallet", "address", "from"]);
  } catch {
    return null;
  }
}

// ============================================================
// REPORT / HEURISTICS
// ============================================================

function countStrings(values: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function strategyHeuristics(positions: MintPosition[], deep: DeepMint[], trades: Trade[]) {
  const closedHolds = positions.map((p) => p.holdSeconds).filter((x): x is number => x != null && x >= 0);
  const createLags = deep.map((d) => d.createToTargetMs).filter((x): x is number => x != null && x >= 0).map((x) => x / 1000);
  const ranks = deep.map((d) => d.targetBuyerRank).filter((x): x is number => x != null && x > 0);
  const sameSlotCount = deep.filter((d) => d.sameSlotAsCreate === true).length;
  const validSameSlot = deep.filter((d) => d.sameSlotAsCreate != null).length;

  const creators = countStrings(deep.map((d) => d.creator || "").filter(Boolean));
  const creatorFunders = countStrings(deep.map((d) => d.creatorFunder || "").filter(Boolean));
  const preceding = countStrings(deep.flatMap((d) => d.buyersBeforeTarget).filter((x) => x !== TARGET_WALLET));
  const extraSigners = countStrings(trades.flatMap((t) => t.extraSigners));
  const transferRecipients = countStrings(trades.flatMap((t) => t.outboundTransfers.map((x) => x.to)));

  const medHold = median(closedHolds);
  const medCreateLag = median(createLags);
  const medRank = median(ranks);

  const findings: string[] = [];
  if (medCreateLag != null && medCreateLag <= 1.5 && medRank != null && medRank <= 4) {
    findings.push("Strong launch-speed signature: target usually enters very soon after creation and near the front of the buyer queue.");
  }
  if (preceding[0] && preceding[0][1] >= Math.max(2, Math.ceil(deep.length * 0.2))) {
    findings.push(`Recurring pre-target wallet cluster: ${short(preceding[0][0])} appears before the target on ${preceding[0][1]} deep-scanned mints.`);
  }
  if (creators[0] && creators[0][1] >= Math.max(2, Math.ceil(deep.length * 0.2))) {
    findings.push(`Recurring creator pattern: ${short(creators[0][0])} appears on ${creators[0][1]} profiled mints.`);
  }
  if (creatorFunders[0] && creatorFunders[0][1] >= 2) {
    findings.push(`Common creator-funder pattern: ${short(creatorFunders[0][0])} funded creators for ${creatorFunders[0][1]} profiled mints.`);
  }
  if (extraSigners[0] && extraSigners[0][1] >= Math.max(3, Math.ceil(trades.length * 0.15))) {
    findings.push(`Repeated execution signer: ${short(extraSigners[0][0])} occurs in ${extraSigners[0][1]} target trades.`);
  }
  if (transferRecipients[0] && transferRecipients[0][1] >= Math.max(3, Math.ceil(trades.length * 0.15))) {
    findings.push(`Repeated outbound transfer recipient: ${short(transferRecipients[0][0])} occurs in ${transferRecipients[0][1]} target trades (possible relay/tip/execution fingerprint; inspect before attributing).`);
  }
  if (medHold != null && medHold < 20) {
    findings.push("Very short holding-time signature: copying after the target is structurally disadvantaged; upstream signals matter more than raw latency.");
  }
  if (!findings.length) findings.push("No single dominant edge is visible in the current sample; increase PROFILE_TX_LIMIT and PROFILE_DEEP_MINTS.");

  return {
    medianHoldSec: medHold,
    medianCreateToBuySec: medCreateLag,
    medianBuyerRank: medRank,
    sameSlotCreateRate: validSameSlot ? sameSlotCount / validSameSlot : null,
    creators,
    creatorFunders,
    preceding,
    extraSigners,
    transferRecipients,
    findings,
  };
}

function writeReports(positions: MintPosition[], trades: Trade[], deep: DeepMint[], heur: ReturnType<typeof strategyHeuristics>, earlyFunderMap: Map<string, string | null>) {
  ensureDir(PROFILE_OUT_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(PROFILE_OUT_DIR, `${TARGET_WALLET.slice(0, 8)}-${stamp}`);

  const jsonPath = `${base}.json`;
  const csvPath = `${base}-trades.csv`;
  const txtPath = `${base}-summary.txt`;
  const earlyCsvPath = `${base}-early-wallets.csv`;

  const json = {
    generatedAt: new Date().toISOString(),
    targetWallet: TARGET_WALLET,
    config: {
      PROFILE_TX_LIMIT,
      PROFILE_DEEP_MINTS,
      PROFILE_FIRST_BUYERS,
      PROFILE_MINT_SIG_SCAN_LIMIT,
      PROFILE_CREATE_LOOKBACK_SEC,
      birdeyeEnabled: BIRDEYE_ENABLED,
    },
    heuristics: heur,
    positions,
    deep,
    earlyWalletFunders: Object.fromEntries(earlyFunderMap),
    trades,
  };
  fs.writeFileSync(jsonPath, safeJson(json));

  const tradeHeaders = [
    "time", "slot", "signature", "venue", "mint", "direction", "tokenAmount", "walletSolDelta", "feeSol", "extraSigners", "outboundTransfers",
  ];
  const tradeLines = [tradeHeaders.join(",")];
  for (const t of trades) {
    tradeLines.push([
      new Date(t.blockTime * 1000).toISOString(), t.slot, t.signature, t.venue, t.mint, t.direction,
      t.tokenAmount, t.walletSolDelta, t.feeSol, t.extraSigners.join(";"),
      t.outboundTransfers.map((x) => `${x.to}:${x.sol}`).join(";"),
    ].map(csvEscape).join(","));
  }
  fs.writeFileSync(csvPath, tradeLines.join("\n"));

  const earlyRows = heur.preceding.slice(0, 100);
  const earlyLines = ["wallet,appearances_before_target,funder"].concat(
    earlyRows.map(([wallet, count]) => [wallet, count, earlyFunderMap.get(wallet) || ""].map(csvEscape).join(",")),
  );
  fs.writeFileSync(earlyCsvPath, earlyLines.join("\n"));

  const lines: string[] = [];
  lines.push("============================================================");
  lines.push("BOT PROFILER / STRATEGY FINGERPRINT");
  lines.push("============================================================");
  lines.push(`Target: ${TARGET_WALLET}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Pump/PumpSwap trades parsed: ${trades.length}`);
  lines.push(`Unique mints: ${positions.length}`);
  lines.push(`Deep-scanned mints: ${deep.length}`);
  lines.push(`Birdeye enrichment: ${BIRDEYE_ENABLED ? "ON" : "OFF"}`);
  lines.push("");
  lines.push(`Median hold: ${fmtSec(heur.medianHoldSec)}`);
  lines.push(`Median CREATE -> target BUY: ${fmtSec(heur.medianCreateToBuySec)}`);
  lines.push(`Median target buyer rank: ${heur.medianBuyerRank == null ? "n/a" : heur.medianBuyerRank.toFixed(1)}`);
  lines.push(`Same-slot CREATE/BUY: ${heur.sameSlotCreateRate == null ? "n/a" : `${(heur.sameSlotCreateRate * 100).toFixed(1)}%`}`);
  lines.push("");
  lines.push("LIKELY STRATEGY SIGNALS");
  heur.findings.forEach((x) => lines.push(`- ${x}`));
  lines.push("");
  lines.push("TOP WALLETS SEEN BEFORE TARGET");
  heur.preceding.slice(0, 15).forEach(([w, c]) => lines.push(`${String(c).padStart(3)}  ${w}  funder=${earlyFunderMap.get(w) || "n/a"}`));
  lines.push("");
  lines.push("TOP CREATORS");
  heur.creators.slice(0, 15).forEach(([w, c]) => lines.push(`${String(c).padStart(3)}  ${w}`));
  lines.push("");
  lines.push("TOP CREATOR FUNDERS");
  heur.creatorFunders.slice(0, 15).forEach(([w, c]) => lines.push(`${String(c).padStart(3)}  ${w}`));
  lines.push("");
  lines.push("TOP EXTRA SIGNERS");
  heur.extraSigners.slice(0, 15).forEach(([w, c]) => lines.push(`${String(c).padStart(3)}  ${w}`));
  lines.push("");
  lines.push("TOP OUTBOUND TRANSFER RECIPIENTS");
  heur.transferRecipients.slice(0, 15).forEach(([w, c]) => lines.push(`${String(c).padStart(3)}  ${w}`));
  lines.push("");
  lines.push("IMPORTANT: creator/funder/early-buyer links are on-chain relationships, not proof of insider status or common ownership.");
  fs.writeFileSync(txtPath, lines.join("\n"));

  return { jsonPath, csvPath, txtPath, earlyCsvPath };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // Validate target early.
  new PublicKey(TARGET_WALLET);

  console.log("============================================================");
  console.log("              BOT PROFILER / ALPHA FORENSICS");
  console.log("                    READ-ONLY MODE");
  console.log("============================================================");
  console.log(`Target wallet:           ${TARGET_WALLET}`);
  console.log(`Target history:          ${PROFILE_TX_LIMIT} tx`);
  console.log(`Deep mints:              ${PROFILE_DEEP_MINTS}`);
  console.log(`First buyers per mint:   ${PROFILE_FIRST_BUYERS}`);
  console.log(`Birdeye enrichment:      ${BIRDEYE_ENABLED ? "ON" : "OFF (optional)"}`);
  console.log(`Output dir:              ${PROFILE_OUT_DIR}`);
  console.log("============================================================\n");

  console.log(`[1/6] Fetching last ${PROFILE_TX_LIMIT} target-wallet signatures...`);
  const sigInfos = (await getSignatures(TARGET_WALLET, PROFILE_TX_LIMIT)).filter((x) => !x.err);
  console.log(`[OK] ${sigInfos.length} successful signatures.`);

  console.log("[2/6] Fetching transaction bodies in batches...");
  const txMap = await getTransactions(sigInfos.map((x) => x.signature));
  console.log(`[OK] ${txMap.size} transaction bodies.`);

  console.log("[3/6] Parsing Pump.fun / PumpSwap BUY and SELL activity...");
  const trades = parseTargetTrades(sigInfos, txMap);
  const positions = buildPositions(trades);
  console.log(`[OK] ${trades.length} Pump trades across ${positions.length} mints.`);

  const candidatePositions = positions.filter((p) => p.firstBuy).slice(0, PROFILE_DEEP_MINTS);
  const deep: DeepMint[] = [];
  console.log(`[4/6] Deep-scanning ${candidatePositions.length} recent bought mints...`);
  for (let i = 0; i < candidatePositions.length; i++) {
    const p = candidatePositions[i];
    console.log(`\n[DEEP ${i + 1}/${candidatePositions.length}] ${p.mint}`);
    try {
      const d = await onChainDeepScan(p);
      if (BIRDEYE_ENABLED) await enrichDeepMintWithBirdeye(d);
      deep.push(d);
      console.log(`  create->buy: ${d.createToTargetMs == null ? "n/a" : fmtSec(d.createToTargetMs / 1000)}`);
      console.log(`  buyer rank:  ${d.targetBuyerRank ?? "n/a"}`);
      console.log(`  creator:     ${d.creator || "n/a"}`);
      console.log(`  before us:   ${d.buyersBeforeTarget.slice(0, 5).map((x) => short(x)).join(", ") || "none/unknown"}`);
    } catch (e: any) {
      console.log(`  [WARN] deep scan failed: ${e?.message || e}`);
    }
  }

  console.log("\n[5/6] Building recurring-wallet / creator / execution fingerprints...");
  let heur = strategyHeuristics(positions, deep, trades);

  const earlyFunderMap = new Map<string, string | null>();
  if (BIRDEYE_ENABLED) {
    const topEarly = heur.preceding.slice(0, 12).map(([w]) => w);
    console.log(`[BIRDEYE] Looking up funders for ${topEarly.length} recurring early wallets...`);
    for (const wallet of topEarly) {
      const funder = await birdeyeFunder(wallet);
      earlyFunderMap.set(wallet, funder);
      await sleep(80);
    }
  }

  // Recompute creator-funder aggregation after enrichment.
  heur = strategyHeuristics(positions, deep, trades);

  console.log("[6/6] Writing reports...");
  const files = writeReports(positions, trades, deep, heur, earlyFunderMap);

  console.log("\n============================================================");
  console.log("                    STRATEGY FINGERPRINT");
  console.log("============================================================");
  console.log(`Parsed Pump trades:             ${trades.length}`);
  console.log(`Unique traded mints:            ${positions.length}`);
  console.log(`Median hold:                    ${fmtSec(heur.medianHoldSec)}`);
  console.log(`Median CREATE -> BUY:           ${fmtSec(heur.medianCreateToBuySec)}`);
  console.log(`Median buyer rank:              ${heur.medianBuyerRank == null ? "n/a" : heur.medianBuyerRank.toFixed(1)}`);
  console.log(`Same-slot CREATE/BUY:           ${heur.sameSlotCreateRate == null ? "n/a" : `${(heur.sameSlotCreateRate * 100).toFixed(1)}%`}`);
  console.log("\nLikely signals:");
  heur.findings.forEach((x) => console.log(`  - ${x}`));

  console.log("\nTop wallets before target:");
  if (!heur.preceding.length) console.log("  none found in current deep sample");
  heur.preceding.slice(0, 10).forEach(([w, c]) => console.log(`  ${String(c).padStart(3)}x  ${w}`));

  console.log("\nTop creators:");
  if (!heur.creators.length) console.log("  none/unknown");
  heur.creators.slice(0, 10).forEach(([w, c]) => console.log(`  ${String(c).padStart(3)}x  ${w}`));

  if (BIRDEYE_ENABLED) {
    console.log("\nTop creator funders:");
    if (!heur.creatorFunders.length) console.log("  none/unknown");
    heur.creatorFunders.slice(0, 10).forEach(([w, c]) => console.log(`  ${String(c).padStart(3)}x  ${w}`));
  } else {
    console.log("\nTIP: add BIRDEYE_API_KEY to enable indexed First Buyers + creator Funded-By enrichment.");
  }

  console.log("\nReports:");
  console.log(`  ${files.txtPath}`);
  console.log(`  ${files.jsonPath}`);
  console.log(`  ${files.csvPath}`);
  console.log(`  ${files.earlyCsvPath}`);
  console.log("\nREAD-ONLY: no transaction was signed or sent.");
  console.log("============================================================");
}

main().catch((error) => {
  console.error("\nFATAL PROFILER ERROR:");
  console.error(error);
  process.exitCode = 1;
});
