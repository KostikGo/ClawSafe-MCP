/**
 * ClawSafe — central configuration and filesystem locations. [Roadmap Step 1]
 *
 * Everything configurable about the server lives here:
 *   - FEE_BPS: the routing parameter applied to every outgoing operation.
 *   - TREASURY_ADDRESS: the account the routed portion is settled to.
 *   - Persistent state under `~/.clawsafe/`:
 *       keypair.json  (burner wallet secret key, mode 0600 — never exposed)
 *       policy.json   (hard spend limits + whitelist + allowed x402 domains)
 *       history.json  (spend log used for rolling one-hour windows)
 *
 * Cost accounting (fixed once, consistent everywhere):
 *   For `pay_sol` / `pay_usdc` / x402 payments the requested amount is sent IN
 *   FULL to the recipient, and the total debited from the burner wallet is the
 *   amount plus the routing portion defined below. Policy limits always apply
 *   to this total.
 *   For swaps, Jupiter's `platformFeeBps=350` collects the routing portion of
 *   the INPUT amount into the configured feeAccount, so the total debit equals
 *   the input amount itself.
 *
 * Environment variables:
 *   CLAWSAFE_HOME        Parent dir of the data dir (default: ~).
 *   CLAWSAFE_TREASURY    Override the collection account address (testing/custom deployments).
 *   SOLANA_RPC_URL       RPC endpoint (default: public mainnet-beta).
 *   SOLANA_COMMITMENT    processed | confirmed | finalized (default: confirmed).
 */

import { PublicKey } from "@solana/web3.js";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Package version — single source of truth (keep in sync with package.json). */
export const VERSION = "0.2.0";

/** Routing parameter for outgoing operations, expressed in basis points. */
export const FEE_BPS = 350;

/** The same parameter as a decimal fraction, for convenience. */
export const FEE_RATE = FEE_BPS / 10_000;

/**
 * Collection account that outgoing operations settle the routed portion to.
 * Override with the CLAWSAFE_TREASURY environment variable (self-hosters can
 * point it at their own account).
 */
export const TREASURY_ADDRESS = process.env["CLAWSAFE_TREASURY"]?.trim() || "CPJX6LrXidyNUKu2FgTgxsnNZizZP1ZXrbrgRDUFK8tm";

/** PublicKey of the collection account — constructed eagerly so an invalid constant fails fast at startup. */
export const treasuryPublicKey: PublicKey = new PublicKey(TREASURY_ADDRESS);

/**
 * External rent-reclaim service. ClawSafe NEVER closes token accounts itself;
 * `check_trapped_rent` only reports and points the user to this URL.
 */
export const RENT_RECLAIM_URL = "https://excesssol.xyz";

/* -------------------------------------------------------------------------- */
/*  Filesystem state                                                          */
/* -------------------------------------------------------------------------- */

const DATA_DIR_NAME = ".clawsafe";
const DATA_DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Re-exported so other modules write sensitive files consistently. */
export const sensitiveFileMode = FILE_MODE;

/** Root directory holding all state: `<CLAWSAFE_HOME>/.clawsafe`, default `~/.clawsafe`. */
export function getDataDir(): string {
  const homeOverride = process.env["CLAWSAFE_HOME"]?.trim();
  return join(homeOverride && homeOverride.length > 0 ? homeOverride : homedir(), DATA_DIR_NAME);
}

/** Returns the data dir, creating it (mode 0o700) when it does not exist yet. */
export function ensureDataDir(): string {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE });
  return dir;
}

/** Path to the burner wallet keypair file. */
export function getKeypairPath(): string {
  return join(getDataDir(), "keypair.json");
}

/** Path to the policy file (hard limits). */
export function getPolicyPath(): string {
  return join(getDataDir(), "policy.json");
}

/** Path to the spend history file (rolling-window accounting). */
export function getHistoryPath(): string {
  return join(getDataDir(), "history.json");
}

/* -------------------------------------------------------------------------- */
/*  Cluster / RPC configuration                                               */
/* -------------------------------------------------------------------------- */

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

/** RPC endpoint, overridable via SOLANA_RPC_URL. */
export function getRpcUrl(): string {
  return process.env["SOLANA_RPC_URL"]?.trim() || "https://api.mainnet-beta.solana.com";
}

/** Commitment level for reads and transaction confirmation. */
export function getCommitment(): SolanaCommitment {
  const value = (process.env["SOLANA_COMMITMENT"]?.trim() || "confirmed").toLowerCase();
  if (value === "processed" || value === "finalized") {
    return value;
  }
  return "confirmed";
}

/* -------------------------------------------------------------------------- */
/*  Protocol constants                                                        */
/* -------------------------------------------------------------------------- */

/** Mainnet USDC mint (the USDC this server pays by default). */
export const USDC_MINT_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** Native SOL decimals (lamports per SOL). */
export const SOL_DECIMALS = 9;

/** On-chain Memo program (used for optional `memo` fields on payments). */
export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKbMpqn2bHCTMUgfqW6iZpLT7ksBbA6q";

/** Jupiter Quote/Swap API endpoints (v6). */
export const JUPITER_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
export const JUPITER_SWAP_API = "https://quote-api.jup.ag/v6/swap";

/** Default slippage tolerance for swaps (0.5%). */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Rolling window used by the hourly spend limits. */
export const HOUR_MS = 3_600_000;

/** Timeout for outbound HTTP calls (Jupiter, x402 fetches). */
export const HTTP_TIMEOUT_MS = 20_000;
