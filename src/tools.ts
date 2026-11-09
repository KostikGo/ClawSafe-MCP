/**
 * ClawSafe — MCP tool registration. [Roadmap Step 6]
 *
 * Six tools are exposed to the AI agent over the MCP `stdio` transport:
 *
 *   1. get_allowance_status — burner address, SOL/USDC balances, CPI Guard
 *      status, active policy limits and remaining hourly allowance.
 *   2. pay_sol             — transfer SOL, policy-checked.
 *   3. pay_usdc            — transfer USDC, policy-checked.
 *   4. swap_tokens         — Jupiter swap with platformFeeBps routing,
 *      policy-checked.
 *   5. x402_paid_fetch     — HTTP fetch that auto-pays `402 Payment Required`
 *      invoices (SOL/USDC) inside the policy limits.
 *   6. check_trapped_rent  — reports empty SPL/Token-2022 accounts and the
 *      trapped rent, pointing to https://excesssol.xyz (never auto-reclaims).
 *
 * SECURITY: tool responses are derived only from the PUBLIC key of the burner
 * wallet. The secret key never leaves src/wallet.ts and never appears in a
 * tool result or a log line. Policy rejections (PolicyError) are returned as
 * `isError` results with the actionable message, so the agent can retry
 * within its allowance.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Connection, Keypair } from "@solana/web3.js";
import { z } from "zod";
import { getWalletStatus, scanTrappedRent, sendSolWithFee, sendUsdcWithFee, swapTokens } from "./solana.js";
import { paidFetch } from "./x402.js";

/** Everything the tool handlers need access to. The keypair stays in-process. */
export interface ToolContext {
  connection: Connection;
  keypair: Keypair;
}

const COST_NOTE =
  "The requested amount is sent IN FULL to the recipient. Policy limits always apply to the TOTAL amount debited from the wallet.";

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  const failure = (error: unknown) => ({
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `⛔ ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
  });

  server.tool(
    "get_allowance_status",
    "Report the burner wallet address, SOL and USDC balances, Token-2022 CPI Guard status, the active policy limits " +
      "and the remaining allowance in the current rolling hour. Call this before any payment to check what the wallet may spend.",
    {},
    async () => {
      try {
        return json(await getWalletStatus(ctx));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "pay_sol",
    `Pay SOL from the burner wallet to a recipient. ${COST_NOTE} Returns the transaction signature and the cost breakdown.`,
    {
      toAddress: z.string().describe("Base58 Solana address of the recipient"),
      amountSol: z.number().gt(0).describe("Amount of SOL to send to the recipient"),
      memo: z.string().max(80).optional().describe("Optional on-chain memo"),
    },
    async ({ toAddress, amountSol, memo }) => {
      try {
        return json(await sendSolWithFee(ctx, toAddress, amountSol, memo));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "pay_usdc",
    `Pay USDC from the burner wallet to a recipient. ${COST_NOTE} The recipient's USDC account is created if needed. Returns the transaction signature and the cost breakdown.`,
    {
      toAddress: z.string().describe("Base58 Solana address of the recipient"),
      amountUsdc: z.number().gt(0).describe("Amount of USDC to send to the recipient"),
      memo: z.string().max(80).optional().describe("Optional on-chain memo"),
    },
    async ({ toAddress, amountUsdc, memo }) => {
      try {
        return json(await sendUsdcWithFee(ctx, toAddress, amountUsdc, memo));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "swap_tokens",
    "Swap tokens via Jupiter from the burner wallet. Jupiter executes the swap with platformFeeBps routing into the " +
      "collection account for the input mint, so the total debited from the wallet equals the input amount. " +
      "Limit accounting supports SOL (mint So11111111111111111111111111111111111111112) or USDC as the input token. " +
      "CPI Guard is enabled automatically on Token-2022 output accounts.",
    {
      inputMint: z.string().describe("Input mint address (use So11111111111111111111111111111111111111112 for SOL)"),
      outputMint: z.string().describe("Output mint address to receive"),
      amount: z.number().gt(0).describe("Amount of the input token to swap (human units, e.g. 0.05 for SOL)"),
    },
    async ({ inputMint, outputMint, amount }) => {
      try {
        return json(await swapTokens(ctx, inputMint, outputMint, amount));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "x402_paid_fetch",
    "Fetch a URL; if the server responds HTTP 402 Payment Required (x402 protocol), automatically pay the Solana invoice " +
      "with the burner wallet — SOL or USDC, amount subject to the same policy limits as the other tools — and replay the " +
      "request with the payment proof attached. Only domains listed in allowedX402Domains may be paid when that list is " +
      "non-empty. The payment is attempted exactly once.",
    {
      url: z
        .string()
        .regex(/^https?:\/\/\S+$/i, "Must be an absolute http(s) URL")
        .describe("Absolute URL to fetch"),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default GET)"),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("Extra request headers (do not set PAYMENT-SIGNATURE; it is added automatically after paying)"),
      body: z.string().optional().describe("Request body for non-GET requests"),
    },
    async ({ url, method, headers, body }) => {
      try {
        return json(await paidFetch(ctx, url, { method, headers, body }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.tool(
    "check_trapped_rent",
    "Audit the burner wallet for EMPTY SPL Token and Token-2022 accounts whose SOL rent deposit is locked. " +
      "ClawSafe never closes accounts itself: the result tells you how much SOL is trapped and links to a one-click " +
      "reclaim service so a HUMAN can decide to reclaim.",
    {},
    async () => {
      try {
        return json(await scanTrappedRent(ctx));
      } catch (error) {
        return failure(error);
      }
    },
  );
}