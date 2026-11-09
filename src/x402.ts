/**
 * ClawSafe — x402 (HTTP 402 Payment Required) client. [Roadmap Step 5]
 *
 * `paidFetch` lets the AI agent consume pay-per-request APIs without human
 * involvement:
 *   1. Perform the HTTP request as usual.
 *   2. If the server answers `402 Payment Required` with machine-readable
 *      payment requirements — either an x402 v2 JSON body
 *      (`paymentRequirements: [{ scheme: "solana", network, asset, amount,
 *      payTo, … }]`) or a URL-encoded `PAYMENT-REQUIRED` header — then:
 *        a. verify the domain against `allowedX402Domains` (when set),
 *        b. verify the invoice amount against the policy limits,
 *        c. pay it with the burner wallet through the same Solana layer used
 *           by pay_sol/pay_usdc (full invoice amount to the recipient,
 *           logged in history.json),
 *        d. replay the request with the Solana transaction signature attached
 *           in the `PAYMENT-SIGNATURE` (and `X-PAYMENT`) header.
 *   3. Return the useful response payload together with the payment receipt.
 *
 * Hard rules: the payment is attempted exactly once; a still-402 retry is an
 * error, never a loop. An invoice for a different resource is refused.
 */

import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { HTTP_TIMEOUT_MS, USDC_MINT_ADDRESS } from "./config.js";
import { isAllowedX402Domain, loadPolicy, Currency } from "./policy.js";
import { transferSolAtomic, transferUsdcAtomic, SolanaContext } from "./solana.js";

/** Error surfaced to the agent when an x402 flow cannot be completed. */
export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402Error";
  }
}

/** One payment requirement extracted from a 402 response. */
export interface PaymentRequirement {
  scheme: string;
  network?: string;
  /** "SOL", "USDC", or a mint address. */
  asset: string;
  /** Requested amount in the asset's smallest unit (lamports / micro-USDC). */
  amount: bigint;
  payTo: string;
  resource?: string;
  maxAmountRequired?: bigint;
  description?: string;
}

/** Which ClawSafe asset an x402 asset string maps to (null = unsupported). */
export function supportedAsset(asset: string | undefined | null): { currency: Currency; decimals: number } | null {
  const value = (asset ?? "").trim();
  const lower = value.toLowerCase();
  if (lower === "sol" || lower === "wsol" || value === NATIVE_MINT.toBase58()) {
    return { currency: "sol", decimals: 9 };
  }
  if (lower === "usdc" || value === USDC_MINT_ADDRESS) {
    return { currency: "usdc", decimals: 6 };
  }
  return null;
}

function parseAmount(raw: string): bigint {
  let amount: bigint;
  try {
    amount = BigInt(raw.trim());
  } catch {
    throw new X402Error(`Invalid x402 amount: "${raw}" is not an integer in the asset's smallest unit.`);
  }
  if (amount <= 0n) {
    throw new X402Error(`Invalid x402 amount: ${raw}. The amount must be greater than zero.`);
  }
  return amount;
}

function toRequirement(record: Record<string, unknown>): PaymentRequirement | null {
  const amount = record["amount"];
  const asset = record["asset"];
  const payTo = record["payTo"] ?? record["to"];
  if (amount == null || asset == null || payTo == null) {
    return null;
  }
  try {
    return {
      scheme: record["scheme"] != null ? String(record["scheme"]) : "solana",
      network: record["network"] != null ? String(record["network"]) : undefined,
      asset: String(asset),
      amount: parseAmount(String(amount)),
      payTo: String(payTo),
      resource: record["resource"] != null ? String(record["resource"]) : undefined,
      maxAmountRequired: record["maxAmountRequired"] != null ? parseAmount(String(record["maxAmountRequired"])) : undefined,
      description: record["description"] != null ? String(record["description"]) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts the Solana payment requirement from a 402 response. Supports the
 * x402 v2 JSON body (`{ x402Version, paymentRequirements: [...] }`) and a
 * URL-encoded `PAYMENT-REQUIRED` header (`amount=…&asset=…&to=…`). Throws
 * X402Error when nothing payable is found.
 */
export function parsePaymentRequirements(bodyText: string | null, paymentRequiredHeader: string | null): PaymentRequirement {
  const candidates: PaymentRequirement[] = [];

  if (paymentRequiredHeader) {
    const params = new URLSearchParams(paymentRequiredHeader);
    const amount = params.get("amount");
    const asset = params.get("asset");
    const payTo = params.get("to") ?? params.get("payTo");
    if (amount && asset && payTo) {
      const requirement = toRequirement({
        amount,
        asset,
        payTo,
        scheme: params.get("scheme") ?? "solana",
        network: params.get("network") ?? undefined,
        resource: params.get("resource") ?? undefined,
        description: params.get("description") ?? undefined,
        maxAmountRequired: params.get("maxAmountRequired") ?? undefined,
      });
      if (requirement) {
        candidates.push(requirement);
      }
    }
  }

  if (bodyText) {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Body is not JSON — the header variant may still apply.
    }
    const requirements = (parsed as { paymentRequirements?: unknown } | null)?.paymentRequirements;
    if (Array.isArray(requirements)) {
      for (const entry of requirements) {
        if (entry && typeof entry === "object") {
          const requirement = toRequirement(entry as Record<string, unknown>);
          if (requirement) {
            candidates.push(requirement);
          }
        }
      }
    }
  }

  if (candidates.length === 0) {
    throw new X402Error(
      "The server responded 402 Payment Required but provided no machine-readable x402 payment details " +
        "(expected a JSON body with paymentRequirements, or a PAYMENT-REQUIRED header).",
    );
  }

  const payable = candidates.filter(
    (requirement) =>
      supportedAsset(requirement.asset) !== null &&
      (requirement.scheme ? requirement.scheme.toLowerCase() === "solana" : true) &&
      isSolanaNetwork(requirement.network),
  );

  if (payable.length === 0) {
    const found = candidates.map((requirement) => `${requirement.scheme}/${requirement.asset}`).join(", ");
    throw new X402Error(`The server requests payment via ${found}. ClawSafe only supports Solana (SOL or USDC) x402 payments.`);
  }

  return payable[0];
}

/** Extracts the hostname of a URL (throws X402Error for invalid URLs). */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new X402Error(`Invalid URL: ${url}`);
  }
}

/**
 * Network gate: the x402 `network` string is informational — we always pay on
 * Solana — so we accept anything that does not clearly name a DIFFERENT
 * ecosystem (defense in depth against mislabeled invoices).
 */
export function isSolanaNetwork(network: string | undefined): boolean {
  if (!network) {
    return true;
  }
  const value = network.toLowerCase();
  const otherEcosystems = [
    "ethereum",
    "evm",
    "base",
    "polygon",
    "optimism",
    "arbitrum",
    "zora",
    "gnosis",
    "avax",
    "stellar",
    "bitcoin",
  ];
  return !otherEcosystems.some((ecosystem) => value.includes(ecosystem));
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

export interface PaidFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PaymentReceipt {
  signature: string;
  currency: Currency;
  amount: number;
  fee: number;
  total: number;
  payTo: string;
  explorerUrl: string;
}

export interface PaidFetchResult {
  url: string;
  status: number;
  ok: boolean;
  /** Response payload from the API (parsed JSON when possible, text otherwise). */
  data: unknown;
  /** Present when a 402 payment was made to obtain this response. */
  payment?: PaymentReceipt;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "follow" });
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Fetches a URL. When the server responds `402 Payment Required`, pays the
 * invoice with the burner wallet (subject to the domain allow-list and the
 * policy limits) and replays the request with the payment proof attached.
 * The payment is attempted exactly once.
 */
export async function paidFetch(ctx: SolanaContext, url: string, options: PaidFetchOptions = {}): Promise<PaidFetchResult> {
  const { method = "GET", headers = {}, body } = options;
  const baseInit: RequestInit = { method, headers: { ...headers }, body };

  const response = await fetchWithTimeout(url, baseInit);
  if (response.status !== 402) {
    return { url, status: response.status, ok: response.ok, data: await readBody(response) };
  }

  // --- A payment is required: parse the invoice, verify, pay, retry. ---
  const bodyText = await response.text().catch(() => null);
  const paymentRequiredHeader = response.headers.get("payment-required") ?? response.headers.get("x-payment-required");
  const requirement = parsePaymentRequirements(bodyText, paymentRequiredHeader);

  const hostname = hostnameOf(url);
  const policy = loadPolicy();
  if (!isAllowedX402Domain(policy, hostname)) {
    throw new X402Error(
      `Refusing to pay ${hostname}: it is not listed in allowedX402Domains. Add it to ~/.clawsafe/policy.json if you trust this API.`,
    );
  }

  const asset = supportedAsset(requirement.asset);
  if (!asset) {
    throw new X402Error(`The x402 invoice uses an unsupported asset (${requirement.asset}); only SOL and USDC are supported.`);
  }
  if (requirement.maxAmountRequired != null && requirement.amount > requirement.maxAmountRequired) {
    throw new X402Error("The requested x402 amount exceeds the advertised maxAmountRequired — refusing to pay.");
  }
  if (requirement.resource && normalizeUrl(requirement.resource) !== normalizeUrl(url)) {
    throw new X402Error(
      `The x402 invoice is for resource ${requirement.resource}, not the requested ${url} — refusing to pay.`,
    );
  }

  let payTo: PublicKey;
  try {
    payTo = new PublicKey(requirement.payTo);
  } catch {
    throw new X402Error(`Invalid payTo address in the x402 invoice: ${requirement.payTo}`);
  }

  const description = requirement.description ? ` (${requirement.description})` : "";
  const paid =
    asset.currency === "sol"
      ? await transferSolAtomic(ctx, payTo.toBase58(), requirement.amount, "x402_paid_fetch", `x402 payment to ${hostname}${description}`)
      : await transferUsdcAtomic(ctx, payTo.toBase58(), requirement.amount, "x402_paid_fetch", `x402 payment to ${hostname}${description}`);

  const retry = await fetchWithTimeout(url, {
    ...baseInit,
    headers: { ...headers, "PAYMENT-SIGNATURE": paid.signature, "X-PAYMENT": paid.signature },
  });
  if (retry.status === 402) {
    const detail = await retry.text().catch(() => "");
    throw new X402Error(
      `Payment was sent (${paid.signature}) but ${hostname} still declined with 402. Response: ${detail.slice(0, 300)}`,
    );
  }

  return {
    url,
    status: retry.status,
    ok: retry.ok,
    data: await readBody(retry),
    payment: {
      signature: paid.signature,
      currency: paid.currency,
      amount: paid.amount,
      fee: paid.fee,
      total: paid.total,
      payTo: paid.recipient,
      explorerUrl: paid.explorerUrl,
    },
  };
}