/**
 * Unit tests: parsing of HTTP 402 Payment Required payment details (the x402
 * protocol). [Roadmap Step 7]
 *
 * No network is used: parsePaymentRequirements is a pure function over the
 * 402 response body and headers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { X402Error, hostnameOf, isSolanaNetwork, parsePaymentRequirements, supportedAsset } from "../src/x402.js";

const PAY_TO = "8rjcjWccf5E7KrMfEDge4Ph8PvD5YahSxaUYepHtubDg";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("parses an x402 v2 JSON body with a Solana payment requirement", () => {
  const body = JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    paymentRequirements: [
      {
        scheme: "solana",
        network: "solana:mainnet-beta",
        asset: "SOL",
        amount: "1000",
        payTo: PAY_TO,
        resource: "https://api.example.com/data",
        description: "one API call",
      },
    ],
  });

  const requirement = parsePaymentRequirements(body, null);
  assert.equal(requirement.scheme, "solana");
  assert.equal(requirement.asset, "SOL");
  assert.equal(requirement.amount, 1000n);
  assert.equal(requirement.payTo, PAY_TO);
  assert.equal(requirement.resource, "https://api.example.com/data");
  assert.equal(requirement.description, "one API call");
});

test("parses a USDC requirement (amount in base units) and accepts the mint address as asset", () => {
  const body = JSON.stringify({
    x402Version: 2,
    paymentRequirements: [{ scheme: "solana", network: "mainnet-beta", asset: USDC_MINT, amount: "2500", payTo: PAY_TO }],
  });

  const requirement = parsePaymentRequirements(body, null);
  assert.equal(requirement.amount, 2500n);
  assert.equal(supportedAsset(requirement.asset)?.currency, "usdc");
  assert.equal(supportedAsset(requirement.asset)?.decimals, 6);
});

test("parses a URL-encoded PAYMENT-REQUIRED header (v1-style)", () => {
  const header = `amount=5000&asset=USDC&network=solana&to=${PAY_TO}&description=credits`;
  const requirement = parsePaymentRequirements(null, header);
  assert.equal(requirement.amount, 5000n);
  assert.equal(requirement.asset, "USDC");
  assert.equal(requirement.payTo, PAY_TO);
});

test("picks a supported requirement when other schemes are advertised", () => {
  const body = JSON.stringify({
    paymentRequirements: [
      { scheme: "evm", network: "base", asset: "0xabc", amount: "1", payTo: "0x1" },
      { scheme: "solana", network: "solana:mainnet-beta", asset: "SOL", amount: "777", payTo: PAY_TO },
    ],
  });

  const requirement = parsePaymentRequirements(body, null);
  assert.equal(requirement.scheme, "solana");
  assert.equal(requirement.amount, 777n);
});

test("throws when only non-Solana payment requirements are offered", () => {
  const body = JSON.stringify({
    paymentRequirements: [{ scheme: "evm", network: "base", asset: "0xabc", amount: "1", payTo: "0x1" }],
  });

  assert.throws(
    () => parsePaymentRequirements(body, null),
    (error: unknown) => error instanceof X402Error && error.message.includes("ClawSafe only supports Solana"),
  );
});

test("throws when the 402 response has no machine-readable payment details", () => {
  assert.throws(
    () => parsePaymentRequirements("<html>payment required</html>", null),
    (error: unknown) => error instanceof X402Error && error.message.includes("no machine-readable x402 payment details"),
  );
});

test("throws on a non-positive or non-integer amount", () => {
  const body = JSON.stringify({
    paymentRequirements: [{ scheme: "solana", asset: "SOL", amount: "0", payTo: PAY_TO }],
  });
  assert.throws(() => parsePaymentRequirements(body, null), X402Error);

  const body2 = JSON.stringify({
    paymentRequirements: [{ scheme: "solana", asset: "SOL", amount: "1.5", payTo: PAY_TO }],
  });
  assert.throws(() => parsePaymentRequirements(body2, null), X402Error);
});

test("supportedAsset recognizes SOL, wSOL mint and USDC; rejects unknown assets", () => {
  assert.equal(supportedAsset("SOL")?.currency, "sol");
  assert.equal(supportedAsset("So11111111111111111111111111111111111111112")?.currency, "sol");
  assert.equal(supportedAsset("USDC")?.currency, "usdc");
  assert.equal(supportedAsset(USDC_MINT)?.currency, "usdc");
  assert.equal(supportedAsset("0xdeadbeef"), null);
  assert.equal(supportedAsset(undefined), null);
});

test("hostnameOf extracts the host and rejects garbage URLs", () => {
  assert.equal(hostnameOf("https://api.example.com:8443/path?q=1"), "api.example.com");
  assert.throws(() => hostnameOf("not a url"), X402Error);
});

test("isSolanaNetwork accepts Solana cluster ids and rejects other ecosystems", () => {
  assert.equal(isSolanaNetwork(undefined), true);
  assert.equal(isSolanaNetwork("solana:mainnet-beta"), true);
  assert.equal(isSolanaNetwork("mainnet-beta"), true);
  assert.equal(isSolanaNetwork("devnet"), true);
  assert.equal(isSolanaNetwork("base-sepolia"), false);
  assert.equal(isSolanaNetwork("ethereum-mainnet"), false);
});
