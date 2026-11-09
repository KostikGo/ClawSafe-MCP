/**
 * Unit tests: the policy engine — per-transaction and rolling-hour limits,
 * whitelist enforcement and x402 domain gating. [Roadmap Step 7]
 *
 * These tests are pure (no filesystem): they exercise checkSpend and friends
 * with in-memory policy + history.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POLICY,
  PolicyError,
  checkSpend,
  checkWhitelist,
  isAllowedX402Domain,
  spentInLastHour,
  type HistoryEntry,
  type Policy,
} from "../src/policy.js";

const policy: Policy = { ...DEFAULT_POLICY };

const sol = (solAmount: number): bigint => BigInt(Math.round(solAmount * 1e9));
const usdc = (usdcAmount: number): bigint => BigInt(Math.round(usdcAmount * 1e6));

const MINUTE = 60_000;

function entry(timestamp: number, currency: "sol" | "usdc", total: number): HistoryEntry {
  return { timestamp, currency, kind: "pay_sol", amount: total, total };
}

test("per-transaction limit: a payment under the limit passes", () => {
  const check = checkSpend(policy, [], "sol", sol(0.05));
  assert.equal(check.total, 0.05);
  assert.equal(check.spentInWindow, 0);
  // remainingAfter is 0.15 up to float dust (0.2 - 0.05 in double precision).
  assert.ok(Math.abs(check.remainingAfter - 0.15) < 1e-9);
});

test("per-transaction limit: excess is rejected with an agent-friendly message", () => {
  assert.throws(
    () => checkSpend(policy, [], "sol", sol(0.06)),
    (error: unknown) =>
      error instanceof PolicyError &&
      error.message.includes("per-transaction limit") &&
      error.message.includes("0.050000 SOL"),
  );
});

test("per-transaction limit: exactly at the limit passes", () => {
  const check = checkSpend(policy, [], "sol", sol(0.05));
  assert.equal(check.total, 0.05);
});

test("rolling hour: spends older than 60 minutes are ignored", () => {
  const now = Date.now();
  const history = [
    entry(now - 30 * MINUTE, "sol", 0.05),
    entry(now - 90 * MINUTE, "sol", 0.5),
    entry(now - 30 * MINUTE, "usdc", 3),
  ];

  assert.equal(spentInLastHour(history, "sol", now), 0.05);
  assert.equal(spentInLastHour(history, "usdc", now), 3);
});

test("rolling hour: a payment that would overshoot the hourly limit is rejected with the remaining allowance", () => {
  const now = Date.now();
  const history = [entry(now - 30 * MINUTE, "sol", 0.1), entry(now - 20 * MINUTE, "sol", 0.07)];
  // 0.17 spent + 0.04 → 0.21 > 0.2 hourly limit (0.04 stays under the per-tx limit).
  assert.throws(
    () => checkSpend(policy, history, "sol", sol(0.04), now),
    (error: unknown) =>
      error instanceof PolicyError &&
      error.message.includes("above the 0.200000 SOL/hour limit") &&
      error.message.includes("remaining right now: 0.030000 SOL"),
  );
});

test("rolling hour: a payment that fits the remaining allowance passes", () => {
  const now = Date.now();
  const history = [entry(now - 30 * MINUTE, "sol", 0.15)];
  const check = checkSpend(policy, history, "sol", sol(0.05), now);
  assert.equal(check.spentInWindow, 0.15);
  // remainingAfter is 0 up to float dust (0.2 - 0.15 - 0.05 in double precision).
  assert.ok(Math.abs(check.remainingAfter) < 1e-9);
});

test("per-transaction and hourly limits are tracked per currency", () => {
  const now = Date.now();
  const history = [entry(now - 10 * MINUTE, "usdc", 20)]; // USDC hourly maxed out
  // SOL is unaffected.
  const check = checkSpend(policy, history, "sol", sol(0.05), now);
  assert.equal(check.total, 0.05);
  // USDC is blocked.
  assert.throws(() => checkSpend(policy, history, "usdc", usdc(0.1), now), PolicyError);
});

test("zero or negative amounts are rejected", () => {
  assert.throws(() => checkSpend(policy, [], "sol", 0n), PolicyError);
  assert.throws(() => checkSpend(policy, [], "sol", -1n), PolicyError);
});

test("whitelist: empty list allows any recipient", () => {
  checkWhitelist(policy, "8rjcjWccf5E7KrMfEDge4Ph8PvD5YahSxaUYepHtubDg");
});

test("whitelist: non-empty list rejects unlisted recipients and accepts listed ones", () => {
  const allowed = "8rjcjWccf5E7KrMfEDge4Ph8PvD5YahSxaUYepHtubDg";
  const whitelistedPolicy: Policy = { ...policy, whitelistedAddresses: [allowed] };
  checkWhitelist(whitelistedPolicy, allowed);
  assert.throws(
    () => checkWhitelist(whitelistedPolicy, "9xQeWvG8WvFvZz5wZ5pGJ3Km2dV8yU6zL5qW3cF7dS2B"),
    (error: unknown) => error instanceof PolicyError && error.message.includes("not on the whitelist"),
  );
});

test("x402 domains: empty list allows every domain", () => {
  assert.equal(isAllowedX402Domain(policy, "api.example.com"), true);
});

test("x402 domains: exact and wildcard matching", () => {
  const gated: Policy = {
    ...policy,
    allowedX402Domains: ["api.trusted.com", "*.partner.org"],
  };
  assert.equal(isAllowedX402Domain(gated, "api.trusted.com"), true);
  assert.equal(isAllowedX402Domain(gated, "other.trusted.com"), false);
  assert.equal(isAllowedX402Domain(gated, "api.partner.org"), true);
  assert.equal(isAllowedX402Domain(gated, "deep.api.partner.org"), true);
  assert.equal(isAllowedX402Domain(gated, "api.partner.org.evil.com"), false);
});
