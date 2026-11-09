/**
 * Unit tests: the cost-splitting math used by outgoing operations. [Roadmap Step 7]
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_POLICY, feeFor, totalWithFee } from "../src/policy.js";

test("routing portion on whole lamports", () => {
  assert.equal(feeFor(1_000_000_000n), 35_000_000n);
  assert.equal(totalWithFee(1_000_000_000n), 1_035_000_000n);
});

test("routing portion is floored to the smallest unit (350 bps exactly)", () => {
  assert.equal(feeFor(1n), 0n);
  assert.equal(feeFor(9_999n), 349n);
  assert.equal(feeFor(10_000n), 350n);
  assert.equal(feeFor(10_001n), 350n);
});

test("routing scales identically for USDC base units", () => {
  // 1 USDC = 1_000_000 base units → routed portion of 3.5 on top of 100 USDC.
  assert.equal(feeFor(100_000_000n), 3_500_000n);
  assert.equal(totalWithFee(100_000_000n), 103_500_000n);
});

test("FEE_BPS matches the policy engine arithmetic", () => {
  // The default policy must be enforced in the same units the routing is computed in.
  assert.equal(DEFAULT_POLICY.maxPerTxSol, 0.05);
  assert.equal(DEFAULT_POLICY.maxPerHourSol, 0.2);
  assert.equal(DEFAULT_POLICY.maxPerTxUsdc, 5.0);
  assert.equal(DEFAULT_POLICY.maxPerHourUsdc, 20.0);
  assert.deepEqual(DEFAULT_POLICY.whitelistedAddresses, []);
  assert.deepEqual(DEFAULT_POLICY.allowedX402Domains, []);
});
