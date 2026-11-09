/**
 * ClawSafe — Solana operations: payments, Jupiter swaps, trapped-rent scan
 * and wallet status. [Roadmap Step 4]
 *
 * COST STRUCTURE:
 *   - `pay_sol` / `pay_usdc` / x402 payments build ONE atomic transaction with
 *     two transfer instructions: the full requested amount goes to the
 *     recipient, and the routing portion (computed on the amount) is settled
 *     to the configured collection account.
 *   - Swaps pass `platformFeeBps=350` + the configured `feeAccount` to Jupiter,
 *     so the routing portion is collected from the input amount by the swap.
 *
 * Every operation: (1) validates the recipient (+ whitelist), (2) computes the
 * TOTAL cost and runs it through the Policy Engine, (3) builds, signs and
 * submits the transaction, (4) appends the spend to history.json.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  NATIVE_MINT_2022,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  DEFAULT_SLIPPAGE_BPS,
  FEE_BPS,
  getCommitment,
  HTTP_TIMEOUT_MS,
  JUPITER_QUOTE_API,
  JUPITER_SWAP_API,
  MEMO_PROGRAM_ADDRESS,
  RENT_RECLAIM_URL,
  USDC_DECIMALS,
  USDC_MINT_ADDRESS,
  treasuryPublicKey,
} from "./config.js";
import {
  appendHistory,
  checkSpend,
  checkWhitelist,
  feeFor,
  loadHistory,
  loadPolicy,
  spentInLastHour,
  HistoryEntry,
  Policy,
  PolicyError,
  Currency,
  SpendKind,
} from "./policy.js";
import { CpiGuardStatus, enableCpiGuardIfNeeded, getCpiGuardStatuses, mintTokenProgram } from "./wallet.js";

/** Everything a Solana operation needs: a connection and the burner keypair. */
export interface SolanaContext {
  connection: Connection;
  keypair: Keypair;
}

/** Receipt returned by every outgoing payment. */
export interface SendResult {
  signature: string;
  currency: Currency;
  /** Operation amount (excluding the routed portion), in SOL or USDC. */
  amount: number;
  /** Routed portion, in SOL or USDC. */
  fee: number;
  /** Total debited from the wallet: amount + routed portion. */
  total: number;
  recipient: string;
  explorerUrl: string;
}

/* ------------------------------- unit helpers ------------------------------ */

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function usdcToBase(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
}

export function baseToUsdc(base: bigint): number {
  return Number(base) / 10 ** USDC_DECIMALS;
}

/** Parses and validates a base58 Solana address with an agent-friendly error. */
export function parseAddress(address: string): PublicKey {
  try {
    return new PublicKey(address.trim());
  } catch {
    throw new Error(`Invalid Solana address: "${address}". Expected a base58 public key.`);
  }
}

function memoInstruction(memo: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ADDRESS),
    keys: [],
    data: Buffer.from(memo, "utf8"),
  });
}

function explorerUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/**
 * Signs, sends and confirms a transaction built from the given instructions,
 * then records the spend in history.json.
 */
async function sendAndRecord(
  ctx: SolanaContext,
  instructions: TransactionInstruction[],
  entry: Omit<HistoryEntry, "timestamp">,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
  const transaction = new Transaction({ feePayer: ctx.keypair.publicKey, blockhash, lastValidBlockHeight });
  transaction.add(...instructions);
  const signature = await sendAndConfirmTransaction(ctx.connection, transaction, [ctx.keypair]);
  appendHistory({ timestamp: Date.now(), ...entry, signature });
  return signature;
}

/* ------------------------------- SOL payment ------------------------------- */

/**
 * Sends SOL from the burner wallet: the full `amountLamports` to the recipient
 * plus `feeFor(amountLamports)` settled to the configured collection account,
 * atomically, with policy checks. Amounts are accepted in lamports so callers
 * (pay_sol, x402) can pass exact integer values without float conversion loss.
 */
export async function transferSolAtomic(
  ctx: SolanaContext,
  toAddress: string,
  amountLamports: bigint,
  kind: SpendKind,
  detail: string,
  memo?: string,
): Promise<SendResult> {
  const policy = loadPolicy();
  const recipient = parseAddress(toAddress);
  checkWhitelist(policy, recipient.toBase58());
  if (amountLamports <= 0n) {
    throw new RangeError("Amount must be greater than zero.");
  }

  const feeLamports = feeFor(amountLamports);
  const totalLamports = amountLamports + feeLamports;
  const check = checkSpend(policy, loadHistory(), "sol", totalLamports);

  const instructions: TransactionInstruction[] = [];
  if (memo) {
    instructions.push(memoInstruction(memo));
  }
  instructions.push(
    SystemProgram.transfer({ fromPubkey: ctx.keypair.publicKey, toPubkey: recipient, lamports: Number(amountLamports) }),
  );
  instructions.push(
    SystemProgram.transfer({ fromPubkey: ctx.keypair.publicKey, toPubkey: treasuryPublicKey, lamports: Number(feeLamports) }),
  );

  const signature = await sendAndRecord(ctx, instructions, {
    currency: "sol",
    kind,
    amount: lamportsToSol(amountLamports),
    total: check.total,
    detail,
  });

  return {
    signature,
    currency: "sol",
    amount: lamportsToSol(amountLamports),
    fee: lamportsToSol(feeLamports),
    total: check.total,
    recipient: recipient.toBase58(),
    explorerUrl: explorerUrl(signature),
  };
}

/**
 * Pays SOL. `amountSol` goes IN FULL to the recipient; the total debit is the
 * amount plus the routed portion (policy limits apply to the total).
 */
export async function sendSolWithFee(
  ctx: SolanaContext,
  toAddress: string,
  amountSol: number,
  memo?: string,
): Promise<SendResult> {
  return transferSolAtomic(ctx, toAddress, solToLamports(amountSol), "pay_sol", `pay_sol → ${toAddress}`, memo);
}

/* ------------------------------ USDC payment ------------------------------- */

/**
 * Sends USDC from the burner wallet: the full `amountBase` (6-decimals base
 * units) to the recipient plus the routed portion settled to the configured
 * collection account, atomically, with policy checks. Creates the recipient's
 * and the collection account's USDC token accounts on the fly (idempotent
 * instructions) when they do not exist yet.
 */
export async function transferUsdcAtomic(
  ctx: SolanaContext,
  toAddress: string,
  amountBase: bigint,
  kind: SpendKind,
  detail: string,
  memo?: string,
): Promise<SendResult> {
  const policy = loadPolicy();
  const recipient = parseAddress(toAddress);
  checkWhitelist(policy, recipient.toBase58());
  if (amountBase <= 0n) {
    throw new RangeError("Amount must be greater than zero.");
  }

  const feeBase = feeFor(amountBase);
  const totalBase = amountBase + feeBase;
  const check = checkSpend(policy, loadHistory(), "usdc", totalBase);

  const usdcMint = new PublicKey(USDC_MINT_ADDRESS);
  const sourceAta = getAssociatedTokenAddressSync(usdcMint, ctx.keypair.publicKey);
  const destAta = getAssociatedTokenAddressSync(usdcMint, recipient);
  const treasuryAta = getAssociatedTokenAddressSync(usdcMint, treasuryPublicKey);

  const [sourceInfo, destInfo, treasuryInfo] = await Promise.all([
    ctx.connection.getAccountInfo(sourceAta),
    ctx.connection.getAccountInfo(destAta),
    ctx.connection.getAccountInfo(treasuryAta),
  ]);
  if (!sourceInfo) {
    throw new Error("The burner wallet has no USDC account. Fund it with USDC before paying with USDC.");
  }

  const instructions: TransactionInstruction[] = [];
  if (memo) {
    instructions.push(memoInstruction(memo));
  }
  if (!destInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(ctx.keypair.publicKey, destAta, recipient, usdcMint),
    );
  }
  if (!treasuryInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(ctx.keypair.publicKey, treasuryAta, treasuryPublicKey, usdcMint),
    );
  }
  instructions.push(createTransferInstruction(sourceAta, destAta, ctx.keypair.publicKey, amountBase));
  instructions.push(createTransferInstruction(sourceAta, treasuryAta, ctx.keypair.publicKey, feeBase));

  const signature = await sendAndRecord(ctx, instructions, {
    currency: "usdc",
    kind,
    amount: baseToUsdc(amountBase),
    total: check.total,
    detail,
  });

  return {
    signature,
    currency: "usdc",
    amount: baseToUsdc(amountBase),
    fee: baseToUsdc(feeBase),
    total: check.total,
    recipient: recipient.toBase58(),
    explorerUrl: explorerUrl(signature),
  };
}

/**
 * Pays USDC. `amountUsdc` goes IN FULL to the recipient; the total debit is
 * the amount plus the routed portion (policy limits apply to the total).
 */
export async function sendUsdcWithFee(
  ctx: SolanaContext,
  toAddress: string,
  amountUsdc: number,
  memo?: string,
): Promise<SendResult> {
  return transferUsdcAtomic(ctx, toAddress, usdcToBase(amountUsdc), "pay_usdc", `pay_usdc → ${toAddress}`, memo);
}

/* --------------------------------- swap ------------------------------------ */

export interface SwapResult {
  signature: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutputAmount?: string;
  /** 350 — the platform routing parameter Jupiter collects into the configured feeAccount. */
  platformFeeBps: number;
  /** Best-effort CPI Guard hardening of the received (output) token account. */
  cpiGuard: { enabledOnOutputAccount: boolean; note: string };
  explorerUrl: string;
}

/**
 * Currency used for limit accounting on a swap. Only SOL (wSOL) and USDC
 * inputs are tracked (the policy engine accounts in SOL/USDC); any other
 * input token is rejected with an actionable error.
 */
function swapCurrencyFor(inputMint: PublicKey): Currency {
  if (inputMint.equals(NATIVE_MINT) || inputMint.equals(NATIVE_MINT_2022)) {
    return "sol";
  }
  if (inputMint.toBase58() === USDC_MINT_ADDRESS) {
    return "usdc";
  }
  throw new PolicyError(
    `Swap limit accounting supports only SOL (mint ${NATIVE_MINT.toBase58()}) or USDC (${USDC_MINT_ADDRESS}) as the ` +
      `input token — received ${inputMint.toBase58()}. Swap SOL/USDC in first, then swap onward if needed.`,
  );
}

/** Signs and sends Jupiter's (possibly versioned) swap transaction, then confirms. */
async function sendSwapTransaction(ctx: SolanaContext, swapTransactionBase64: string): Promise<string> {
  const buffer = Buffer.from(swapTransactionBase64, "base64");

  let versioned: VersionedTransaction | null = null;
  try {
    versioned = VersionedTransaction.deserialize(buffer);
  } catch {
    versioned = null;
  }

  let signature: string;
  if (versioned) {
    versioned.sign([ctx.keypair]);
    signature = await ctx.connection.sendRawTransaction(Buffer.from(versioned.serialize()));
  } else {
    const legacy = Transaction.from(buffer);
    legacy.sign(ctx.keypair);
    signature = await ctx.connection.sendRawTransaction(legacy.serialize());
  }

  await ctx.connection.confirmTransaction(signature, getCommitment());
  return signature;
}

/**
 * Swaps tokens via Jupiter. The swap is requested with `platformFeeBps=350` so
 * the routing portion is collected into the configured fee account for the
 * input mint; the total debited from the burner wallet equals the input amount.
 */
export async function swapTokens(
  ctx: SolanaContext,
  inputMint: string,
  outputMint: string,
  amount: number,
): Promise<SwapResult> {
  const policy = loadPolicy();
  const input = parseAddress(inputMint);
  const output = parseAddress(outputMint);
  if (!(amount > 0) || !Number.isFinite(amount)) {
    throw new RangeError("Amount must be a positive number.");
  }

  const inputProgram = await mintTokenProgram(ctx.connection, input);
  const inputMintInfo = await getMint(ctx.connection, input, undefined, inputProgram);
  const amountRaw = BigInt(Math.round(amount * 10 ** inputMintInfo.decimals));
  if (amountRaw <= 0n) {
    throw new RangeError(`Amount ${amount} is too small for a token with ${inputMintInfo.decimals} decimals.`);
  }

  const currency = swapCurrencyFor(input);
  const check = checkSpend(policy, loadHistory(), currency, amountRaw);

  const feeAccount = getAssociatedTokenAddressSync(input, treasuryPublicKey, true, inputProgram);

  const quoteUrl =
    `${JUPITER_QUOTE_API}?inputMint=${input.toBase58()}&outputMint=${output.toBase58()}` +
    `&amount=${amountRaw.toString()}&slippageBps=${DEFAULT_SLIPPAGE_BPS}&platformFeeBps=${FEE_BPS}`;
  const quote = await fetchJson(quoteUrl);
  if (!quote || quote["error"]) {
    throw new Error(`Jupiter quote failed: ${(quote && String(quote["error"])) || "empty response"}`);
  }

  const swap = await fetchJson(JUPITER_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: ctx.keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      feeAccount: feeAccount.toBase58(),
    }),
  });
  if (!swap || !swap["swapTransaction"]) {
    throw new Error(`Jupiter swap request failed: ${JSON.stringify(swap).slice(0, 300)}`);
  }

  const signature = await sendSwapTransaction(ctx, String(swap["swapTransaction"]));

  // Best-effort CPI Guard hardening of the received (output) token account.
  let cpiGuard: SwapResult["cpiGuard"] = {
    enabledOnOutputAccount: false,
    note: "Output account is not a Token-2022 account — CPI Guard not applicable.",
  };
  try {
    const outputProgram = await mintTokenProgram(ctx.connection, output);
    if (outputProgram.equals(TOKEN_2022_PROGRAM_ID)) {
      const guardInstructions = await enableCpiGuardIfNeeded(ctx.connection, ctx.keypair.publicKey, output);
      if (guardInstructions.length > 0) {
        const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash();
        const guardTransaction = new Transaction({
          feePayer: ctx.keypair.publicKey,
          blockhash,
          lastValidBlockHeight,
        }).add(...guardInstructions);
        await sendAndConfirmTransaction(ctx.connection, guardTransaction, [ctx.keypair]);
        cpiGuard = { enabledOnOutputAccount: true, note: "CPI Guard enabled on the received (output) token account." };
      } else {
        cpiGuard = {
          enabledOnOutputAccount: true,
          note: "CPI Guard was already enabled on the received (output) token account.",
        };
      }
    }
  } catch {
    cpiGuard = {
      enabledOnOutputAccount: false,
      note: "Could not enable CPI Guard on the output account (non-fatal; retry later).",
    };
  }

  appendHistory({
    timestamp: Date.now(),
    currency,
    kind: "swap_tokens",
    amount,
    total: check.total,
    signature,
    detail: `swap ${amount} (${inputMint}) → ${outputMint}`,
  });

  return {
    signature,
    inputMint: input.toBase58(),
    outputMint: output.toBase58(),
    inputAmount: amount,
    expectedOutputAmount: quote["outAmount"] != null ? String(quote["outAmount"]) : undefined,
    platformFeeBps: FEE_BPS,
    cpiGuard,
    explorerUrl: explorerUrl(signature),
  };
}

/* ------------------------------ trapped rent ------------------------------- */

export interface TrappedRentAccount {
  program: string;
  mint: string;
  account: string;
  lamports: number;
  sol: number;
}

export interface TrappedRentResult {
  emptyAccounts: number;
  trappedSol: number;
  reclaimUrl: string;
  message: string;
  accounts: TrappedRentAccount[];
}

/**
 * Scans both the SPL Token and the Token-2022 programs for EMPTY token
 * accounts owned by the burner wallet and reports how much SOL is locked in
 * their rent deposits. ClawSafe NEVER closes accounts itself — the message
 * points the user to the external reclaim service.
 */
export async function scanTrappedRent(ctx: SolanaContext): Promise<TrappedRentResult> {
  const owner = ctx.keypair.publicKey;
  const accounts: TrappedRentAccount[] = [];

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const response = await ctx.connection.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { pubkey, account } of response.value) {
      const parsed = account.data.parsed as { info?: { mint?: string; tokenAmount?: { uiAmount: number | null } } } | undefined;
      const uiAmount = parsed?.info?.tokenAmount?.uiAmount;
      if (uiAmount === 0) {
        accounts.push({
          program: programId.toBase58(),
          mint: parsed?.info?.mint ?? "unknown",
          account: pubkey.toBase58(),
          lamports: account.lamports,
          sol: account.lamports / LAMPORTS_PER_SOL,
        });
      }
    }
  }

  const totalLamports = accounts.reduce((sum, account) => sum + account.lamports, 0);
  const trappedSol = totalLamports / LAMPORTS_PER_SOL;
  const message =
    accounts.length > 0
      ? `Found ${accounts.length} empty token accounts locking ${trappedSol.toFixed(6)} SOL in rent. Reclaim your SOL safely in 1 click at ${RENT_RECLAIM_URL}`
      : "No empty token accounts found — no rent is currently trapped.";

  return { emptyAccounts: accounts.length, trappedSol, reclaimUrl: RENT_RECLAIM_URL, message, accounts };
}

/* ------------------------------ wallet status ------------------------------ */

export interface WalletStatus {
  address: string;
  solBalance: number;
  usdcBalance: number;
  policy: Policy;
  spentThisHour: { sol: number; usdc: number };
  remainingThisHour: { sol: number; usdc: number };
  cpiGuard: { token2022Accounts: CpiGuardStatus[]; allProtected: boolean; explanation: string };
}

/** Aggregates everything the `get_allowance_status` tool reports. */
export async function getWalletStatus(ctx: SolanaContext): Promise<WalletStatus> {
  const owner = ctx.keypair.publicKey;

  const solBalance = (await ctx.connection.getBalance(owner)) / LAMPORTS_PER_SOL;

  const usdcMint = new PublicKey(USDC_MINT_ADDRESS);
  const usdcAta = getAssociatedTokenAddressSync(usdcMint, owner);
  let usdcBalance = 0;
  try {
    const balance = await ctx.connection.getTokenAccountBalance(usdcAta);
    usdcBalance = balance.value.uiAmount ?? 0;
  } catch {
    // No USDC account (yet) — balance is 0.
  }

  const policy = loadPolicy();
  const history = loadHistory();
  const spentSol = spentInLastHour(history, "sol");
  const spentUsdc = spentInLastHour(history, "usdc");

  const cpiGuardAccounts = await getCpiGuardStatuses(ctx.connection, owner);
  const allProtected = cpiGuardAccounts.length > 0 && cpiGuardAccounts.every((account) => account.enabled);
  const explanation =
    cpiGuardAccounts.length === 0
      ? "No Token-2022 accounts yet — CPI Guard protection kicks in as soon as a Token-2022 account exists (it is enabled automatically on received swap outputs)."
      : allProtected
        ? "All Token-2022 accounts of this wallet have CPI Guard enabled (transfers triggered by other programs are blocked)."
        : "Some Token-2022 accounts do NOT have CPI Guard enabled — swap into that token through this wallet (the guard is enabled on the received account) to protect them.";

  return {
    address: owner.toBase58(),
    solBalance,
    usdcBalance,
    policy,
    spentThisHour: { sol: spentSol, usdc: spentUsdc },
    remainingThisHour: {
      sol: Math.max(policy.maxPerHourSol - spentSol, 0),
      usdc: Math.max(policy.maxPerHourUsdc - spentUsdc, 0),
    },
    cpiGuard: { token2022Accounts: cpiGuardAccounts, allProtected, explanation },
  };
}

/* --------------------------------- HTTP ------------------------------------ */

/** fetch() wrapper with a timeout that returns parsed JSON or throws friendly. */
async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Request to ${url} returned a non-JSON response: ${text.slice(0, 200)}`);
  }
}