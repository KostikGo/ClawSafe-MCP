/**
 * ClawSafe — Policy Engine: hard spend limits and rolling-window accounting.
 * [Roadmap Step 3]
 *
 * The policy is the financial firewall of the server. Before any outgoing
 * transaction is built or signed, the policy engine computes the FULL cost
 * (operation amount + the configured routing portion) and rejects it when it would exceed:
 *   - the per-transaction limit (`maxPerTx*`), or
 *   - the remaining allowance over a rolling 60-minute window (`maxPerHour*`),
 *     computed from the append-only spend log in history.json.
 * Recipient addresses are additionally checked against `whitelistedAddresses`
 * (when non-empty) and x402 payment domains against `allowedX402Domains`.
 *
 * Every rejection throws a `PolicyError` whose message is written for the
 * AI agent: it states the offending amount, the violated limit and the exact
 * remaining allowance, so the agent can retry with a smaller amount.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ensureDataDir, FEE_BPS, getHistoryPath, getPolicyPath, HOUR_MS, sensitiveFileMode } from "./config.js";

export type Currency = "sol" | "usdc";

/** Which ClawSafe flow produced a spend — recorded in history.json. */
export type SpendKind = "pay_sol" | "pay_usdc" | "swap_tokens" | "x402_paid_fetch";

/** Hard spend limits enforced before every outgoing transaction. */
export interface Policy {
  /** Max SOL per single transaction, routing included. */
  maxPerTxSol: number;
  /** Max SOL over a rolling 60 minutes, routing included. */
  maxPerHourSol: number;
  /** Max USDC per single transaction, routing included. */
  maxPerTxUsdc: number;
  /** Max USDC over a rolling 60 minutes, routing included. */
  maxPerHourUsdc: number;
  /** When non-empty, transfers may only go to these base58 addresses. */
  whitelistedAddresses: string[];
  /** When non-empty, x402 payments may only go to these domains (exact or `*.domain`). */
  allowedX402Domains: string[];
}

/**
 * Conservative defaults so a fresh installation is safe by default:
 * 0.05 SOL/tx, 0.2 SOL/hour, 5 USDC/tx, 20 USDC/hour, no whitelist,
 * no x402 domain restriction.
 */
export const DEFAULT_POLICY: Policy = {
  maxPerTxSol: 0.05,
  maxPerHourSol: 0.2,
  maxPerTxUsdc: 5.0,
  maxPerHourUsdc: 20.0,
  whitelistedAddresses: [],
  allowedX402Domains: [],
};

/** Error surfaced to the AI agent when a policy check fails. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** One executed spend. `total` is what counts against the limits. */
export interface HistoryEntry {
  /** Unix epoch milliseconds. */
  timestamp: number;
  currency: Currency;
  kind: SpendKind;
  /** Operation amount (excluding the routed portion), in SOL or USDC. */
  amount: number;
  /** Total debited from the wallet, routing included — counted against limits. */
  total: number;
  /** Transaction signature, when available. */
  signature?: string;
  /** Free-text context (recipient, swap mints, paid domain…). */
  detail?: string;
}

/** Routing portion of an atomic amount (lamports or token base units), floored. */
export function feeFor(amountSmallest: bigint): bigint {
  return (amountSmallest * BigInt(FEE_BPS)) / 10_000n;
}

/** Total debited for an operation of the given atomic amount: amount + routing portion. */
export function totalWithFee(amountSmallest: bigint): bigint {
  return amountSmallest + feeFor(amountSmallest);
}

/**
 * Loads the policy from disk, creating it with the safe defaults when the
 * file is missing. Unknown or malformed fields fall back to the defaults, so
 * a partially edited policy.json can never silently disable a limit.
 */
export function loadPolicy(): Policy {
  const filePath = getPolicyPath();
  if (!existsSync(filePath)) {
    savePolicy(DEFAULT_POLICY);
    return { ...DEFAULT_POLICY };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Policy file ${filePath} is not valid JSON. Delete it to regenerate the safe defaults.`);
  }

  const stored = (parsed ?? {}) as Partial<Policy>;
  const policy: Policy = {
    maxPerTxSol: nonNegativeNumber(stored.maxPerTxSol, DEFAULT_POLICY.maxPerTxSol),
    maxPerHourSol: nonNegativeNumber(stored.maxPerHourSol, DEFAULT_POLICY.maxPerHourSol),
    maxPerTxUsdc: nonNegativeNumber(stored.maxPerTxUsdc, DEFAULT_POLICY.maxPerTxUsdc),
    maxPerHourUsdc: nonNegativeNumber(stored.maxPerHourUsdc, DEFAULT_POLICY.maxPerHourUsdc),
    whitelistedAddresses: Array.isArray(stored.whitelistedAddresses)
      ? stored.whitelistedAddresses.filter((entry): entry is string => typeof entry === "string")
      : [...DEFAULT_POLICY.whitelistedAddresses],
    allowedX402Domains: Array.isArray(stored.allowedX402Domains)
      ? stored.allowedX402Domains.filter((entry): entry is string => typeof entry === "string")
      : [...DEFAULT_POLICY.allowedX402Domains],
  };
  return policy;
}

/** Persists the policy with owner-only permissions in a human-readable format. */
export function savePolicy(policy: Policy): void {
  ensureDataDir();
  const filePath = getPolicyPath();
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(policy, null, 2) + "\n", { encoding: "utf8", mode: sensitiveFileMode });
  renameSync(temporaryPath, filePath);
}

/**
 * Loads the spend history. A missing file means "nothing spent yet".
 * A CORRUPT file is a hard failure (rather than silently forgetting past
 * spends), because forgetting history could let the agent bust its hourly
 * limit. The error tells the user how to inspect or reset accounting.
 */
export function loadHistory(): HistoryEntry[] {
  const filePath = getHistoryPath();
  if (!existsSync(filePath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(
      `History file ${filePath} is not valid JSON. Policy limits cannot be ` +
        `enforced safely with a corrupt history. Inspect and back it up, or delete it to reset accounting.`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`History file ${filePath} must contain an array of spend entries.`);
  }

  return (parsed as unknown[]).map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const timestamp = Number(record["timestamp"]);
    const total = Number(record["total"]);
    const currency = record["currency"];
    if (!Number.isFinite(timestamp) || !Number.isFinite(total) || (currency !== "sol" && currency !== "usdc")) {
      throw new Error(
        `History file ${filePath} has a corrupt entry at position ${index}. Back it up or delete it to reset accounting.`,
      );
    }
    const historyEntry: HistoryEntry = {
      timestamp,
      currency,
      kind: (record["kind"] as SpendKind) ?? "pay_sol",
      amount: Number.isFinite(Number(record["amount"])) ? Number(record["amount"]) : total,
      total,
    };
    if (typeof record["signature"] === "string") {
      historyEntry.signature = record["signature"];
    }
    if (typeof record["detail"] === "string") {
      historyEntry.detail = record["detail"];
    }
    return historyEntry;
  });
}

/** Appends a spend to history.json atomically (temp file + rename, mode 0600). */
export function appendHistory(entry: HistoryEntry): void {
  const history = loadHistory();
  history.push(entry);
  ensureDataDir();
  const filePath = getHistoryPath();
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(history, null, 2) + "\n", { encoding: "utf8", mode: sensitiveFileMode });
  renameSync(temporaryPath, filePath);
}

/**
 * Total amount (routing included) already spent in the rolling one-hour window
 * for the given currency. Pure function — easy to unit test.
 */
export function spentInLastHour(history: HistoryEntry[], currency: Currency, now: number = Date.now()): number {
  const windowStart = now - HOUR_MS;
  return history
    .filter((entry) => entry.currency === currency && entry.timestamp >= windowStart)
    .reduce((sum, entry) => sum + entry.total, 0);
}

export interface SpendCheck {
  /** Total cost checked, in human units (SOL or USDC), routing included. */
  total: number;
  /** Amount already spent in the rolling hour BEFORE this payment. */
  spentInWindow: number;
  /** Hourly allowance remaining BEFORE this payment. */
  remainingBefore: number;
  /** Hourly allowance that would remain AFTER this payment. */
  remainingAfter: number;
}

/**
 * Checks the full cost of an operation (already including the routed portion)
 * against the per-transaction and rolling-hour limits. Throws `PolicyError`
 * with an agent-friendly message on violation; otherwise returns the
 * accounting.
 *
 * @param totalSmallest Full cost in atomic units (lamports for SOL, base
 *                       units for USDC) — i.e. `totalWithFee(amount)`.
 */
export function checkSpend(
  policy: Policy,
  history: HistoryEntry[],
  currency: Currency,
  totalSmallest: bigint,
  now: number = Date.now(),
): SpendCheck {
  if (totalSmallest <= 0n) {
    throw new PolicyError("Amount must be greater than zero.");
  }

  const decimals = currency === "sol" ? 9 : 6;
  const divisor = 10n ** BigInt(decimals);
  const total = Number(totalSmallest) / Number(divisor);
  if (!Number.isFinite(total)) {
    throw new PolicyError("Invalid amount: could not be represented.");
  }

  const limit = currency === "sol" ? policy.maxPerTxSol : policy.maxPerTxUsdc;
  const hourLimit = currency === "sol" ? policy.maxPerHourSol : policy.maxPerHourUsdc;
  const unit = currency === "sol" ? "SOL" : "USDC";

  if (Number(totalSmallest) > Math.round(limit * Number(divisor))) {
    throw new PolicyError(
      `Spending limit exceeded: the total cost of ${formatAmount(total, unit)} exceeds the per-transaction limit ` +
        `of ${formatAmount(limit, unit)}. Lower the amount or edit ~/.clawsafe/policy.json to raise the limit.`,
    );
  }

  const spentInWindow = spentInLastHour(history, currency, now);
  const remainingBefore = Math.max(hourLimit - spentInWindow, 0);
  if (spentInWindow + total > hourLimit) {
    throw new PolicyError(
      `Spending limit exceeded: the total cost of ${formatAmount(total, unit)} would bring the rolling-hour spend to ` +
        `${formatAmount(spentInWindow + total, unit)}, above the ${formatAmount(hourLimit, unit)}/hour limit ` +
        `(remaining right now: ${formatAmount(remainingBefore, unit)}). Wait, spend less, or edit ~/.clawsafe/policy.json to raise the limit.`,
    );
  }

  return {
    total,
    spentInWindow,
    remainingBefore,
    remainingAfter: remainingBefore - total,
  };
}

/** Throws when the recipient is not whitelisted (whitelist empty = allow all). */
export function checkWhitelist(policy: Policy, address: string): void {
  if (policy.whitelistedAddresses.length > 0 && !policy.whitelistedAddresses.includes(address)) {
    throw new PolicyError(
      `Recipient ${address} is not on the whitelist. Allowed recipients: ` +
        `${policy.whitelistedAddresses.join(", ")}. Edit ~/.clawsafe/policy.json to change whitelistedAddresses.`,
    );
  }
}

/** True when the domain may receive x402 payments (empty list = allow all domains). */
export function isAllowedX402Domain(policy: Policy, hostname: string): boolean {
  if (policy.allowedX402Domains.length === 0) {
    return true;
  }
  return policy.allowedX402Domains.some(
    (allowed) => allowed === hostname || (allowed.startsWith("*.") && hostname.endsWith(allowed.slice(1))),
  );
}

function formatAmount(value: number, unit: string): string {
  return `${value.toFixed(unit === "SOL" ? 6 : 2)} ${unit}`;
}

/** Accepts a finite, non-negative number; otherwise returns the provided default. */
function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}