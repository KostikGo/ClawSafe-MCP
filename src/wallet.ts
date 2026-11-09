/**
 * ClawSafe — isolated burner (sub-)wallet management + Token-2022 CPI Guard.
 * [Roadmap Step 2]
 *
 * The burner wallet is the *only* wallet the AI agent can ever touch. The
 * user's main wallet never appears anywhere in this process, so a runaway or
 * compromised agent is bounded by the wallet's balance and the policy engine.
 *
 * SECURITY RULES enforced by this module:
 *   1. The secret key is stored on disk at `~/.clawsafe/keypair.json` with
 *      mode 0o600 (owner-only); the directory is created with mode 0o700.
 *   2. The secret key is NEVER returned from any function whose result can
 *      reach an MCP tool response, and it is NEVER written to logs/stdout.
 *      MCP tools only ever receive the public address. Signing happens inside
 *      this process, on the agent's behalf, behind policy checks.
 *   3. The keypair file uses the standard Solana format (JSON array of 64
 *      bytes), so the wallet can be imported into Phantom/Solflare/Backpack
 *      if the user ever wants to move or sweep funds manually.
 *
 * CPI GUARD (Token-2022):
 *   `enableCpiGuardIfNeeded` builds the instructions that turn on the
 *   Token-2022 CPI Guard extension on the burner's token accounts. With the
 *   guard enabled, the account can only be spent through instructions signed
 *   DIRECTLY by the owner — malicious smart contracts can no longer drain the
 *   account via hidden CPI (cross-program invocation) transfers.
 */

import { ensureDataDir, getKeypairPath, sensitiveFileMode } from "./config.js";
import { Keypair, PublicKey, TransactionInstruction, Connection } from "@solana/web3.js";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Result of loading (or creating) the burner wallet. Never contains the secret key. */
export interface WalletInfo {
  /** Base58 public address of the burner wallet — safe to expose to agents and logs. */
  address: string;
  /** True when the wallet was generated during this call, false when it already existed. */
  created: boolean;
  /** Keypair, for in-process signing only. MUST NOT be leaked into tool responses or logs. */
  keypair: Keypair;
}

/**
 * Loads the burner wallet, or generates and persists a fresh one if it does
 * not exist yet. Used by the `init` CLI command.
 */
export function getOrCreateKeypair(): WalletInfo {
  const filePath = getKeypairPath();
  if (existsSync(filePath)) {
    const keypair = readKeypairFile(filePath);
    return { address: keypair.publicKey.toBase58(), created: false, keypair };
  }

  const keypair = Keypair.generate();
  writeKeypairFile(filePath, keypair);
  return { address: keypair.publicKey.toBase58(), created: true, keypair };
}

/**
 * Loads the existing burner wallet. Throws a human-readable error explaining
 * how to create one if the keypair file is missing. Used when the MCP server
 * starts (`serve`), since a wallet must already exist by then.
 */
export function loadKeypair(): Keypair {
  const filePath = getKeypairPath();
  if (!existsSync(filePath)) {
    throw new Error(
      `No burner wallet found at ${filePath}.\n` +
        `Run "clawsafe-mcp init" first to generate one, then fund it with a small amount of SOL.`,
    );
  }
  return readKeypairFile(filePath);
}

/** Reads and validates a Solana keypair file (JSON array of exactly 64 bytes). */
function readKeypairFile(filePath: string): Keypair {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read keypair file ${filePath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Keypair file ${filePath} is not valid JSON. Delete it and run "clawsafe-mcp init".`);
  }

  // Accept both the standard raw array `[0,1,...]` and `{ secretKey: [...] }` shapes.
  const candidate: unknown = Array.isArray(parsed) ? parsed : (parsed as { secretKey?: unknown } | null)?.["secretKey"];
  if (!Array.isArray(candidate) || candidate.length !== 64) {
    throw new Error(
      `Keypair file ${filePath} must contain an array of exactly 64 bytes. Delete it and run "clawsafe-mcp init".`,
    );
  }

  const secretBytes = Uint8Array.from(candidate as number[]);
  if (secretBytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`Keypair file ${filePath} contains invalid bytes. Delete it and run "clawsafe-mcp init".`);
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(secretBytes);
  } catch {
    throw new Error(`Keypair file ${filePath} is not a valid Solana keypair. Delete it and run "clawsafe-mcp init".`);
  }
  return keypair;
}

/**
 * Persists a keypair atomically: the file is created with mode 0o600, written
 * to a temporary sibling and then renamed into place, so readers never observe
 * a half-written key.
 */
function writeKeypairFile(filePath: string, keypair: Keypair): void {
  ensureDataDir();
  ensureOwnerOnly(dirname(filePath));

  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(Array.from(keypair.secretKey), null, 2), {
    encoding: "utf8",
    mode: sensitiveFileMode,
  });
  chmodSync(temporaryPath, sensitiveFileMode);
  renameSync(temporaryPath, filePath);
}

/** Best-effort tightening of directory permissions to 0o700 (no-op on filesystems without POSIX modes). */
function ensureOwnerOnly(dirPath: string): void {
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Not all platforms/filesystems support chmod (e.g. some Windows configurations). Ignore.
  }
}

/* -------------------------------------------------------------------------- */
/*  Token-2022 CPI Guard                                                       */
/* -------------------------------------------------------------------------- */

import {
  getAssociatedTokenAddressSync,
  createEnableCpiGuardInstruction,
  createReallocateInstruction,
  ExtensionType,
  getExtensionData,
  getNewAccountLenForExtensionLen,
  getTypeLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/** Size of the base SPL account layout (Token and Token-2022). TLV extensions follow. */
const ACCOUNT_BASE_SIZE = 165;

/** Per-account CPI Guard state, used by `get_allowance_status`. */
export interface CpiGuardStatus {
  /** Mint of the token account. */
  mint: string;
  /** Token account address. */
  account: string;
  /** True when the Token-2022 CPI Guard extension is enabled. */
  enabled: boolean;
}

/** Returns the token program (Token or Token-2022) that owns the given mint. */
export async function mintTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) {
    throw new Error(`Mint ${mint.toBase58()} was not found on chain (wrong cluster or address?).`);
  }
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Reads the CPI Guard extension from raw Token-2022 account data.
 * Returns true/false when the extension is present, `null` when it is absent.
 */
export function parseCpiGuardExtension(data: Buffer | Uint8Array): boolean | null {
  if (!data || data.length <= ACCOUNT_BASE_SIZE) {
    return null;
  }
  const tlvData = Buffer.isBuffer(data) ? data.subarray(ACCOUNT_BASE_SIZE) : Buffer.from(data.subarray(ACCOUNT_BASE_SIZE));
  const extension = getExtensionData(ExtensionType.CpiGuard, tlvData);
  if (!extension || extension.length < 1) {
    return null;
  }
  return extension[0] === 1;
}

/**
 * Builds the instructions needed to enable the Token-2022 CPI Guard on the
 * owner's account for the given mint:
 *   - nothing when the mint is a classic SPL token (CPI Guard is Token-2022 only),
 *   - nothing when the account does not exist yet (created later, e.g. on first receive),
 *   - nothing when the guard is already enabled,
 *   - otherwise a Reallocate (only when the account needs more space) plus the
 *     EnableCpiGuard instruction.
 *
 * The caller bundles these into a transaction it already builds/signs.
 */
export async function enableCpiGuardIfNeeded(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<TransactionInstruction[]> {
  const programId = await mintTokenProgram(connection, mint);
  if (!programId.equals(TOKEN_2022_PROGRAM_ID)) {
    return [];
  }

  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
  const info = await connection.getAccountInfo(ata, "confirmed");
  if (!info) {
    // The account does not exist yet — nothing to guard here. It will be
    // created on first receive; enable the guard afterwards.
    return [];
  }

  if (parseCpiGuardExtension(info.data) === true) {
    return [];
  }

  const instructions: TransactionInstruction[] = [];
  const requiredLen = getNewAccountLenForExtensionLen(
    info,
    ata,
    ExtensionType.CpiGuard,
    getTypeLen(ExtensionType.CpiGuard),
    programId,
  );
  if (requiredLen > info.data.length) {
    instructions.push(createReallocateInstruction(ata, owner, [ExtensionType.CpiGuard], owner, [], programId));
  }
  instructions.push(createEnableCpiGuardInstruction(ata, owner, [], programId));
  return instructions;
}

/**
 * Reports the CPI Guard state of every Token-2022 account owned by the wallet.
 * Used by the `get_allowance_status` tool.
 */
export async function getCpiGuardStatuses(connection: Connection, owner: PublicKey): Promise<CpiGuardStatus[]> {
  const response = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID });
  const statuses: CpiGuardStatus[] = [];
  for (const { pubkey, account } of response.value) {
    const mint = (account.data.parsed as { info?: { mint?: string } } | undefined)?.info?.mint;
    const raw = await connection.getAccountInfo(pubkey, "confirmed");
    statuses.push({
      mint: mint ?? "unknown",
      account: pubkey.toBase58(),
      enabled: parseCpiGuardExtension(raw?.data ?? Buffer.alloc(0)) === true,
    });
  }
  return statuses;
}