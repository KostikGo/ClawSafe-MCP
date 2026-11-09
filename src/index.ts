#!/usr/bin/env node
/**
 * ClawSafe — CLI entry point and MCP server bootstrap. [Roadmap Steps 1 & 7]
 *
 * Usage:
 *   clawsafe-mcp init      Create ~/.clawsafe (keypair + policy + history) and
 *                          print the MCP client config snippet.
 *   clawsafe-mcp serve     Start the MCP server over stdio (default command).
 *   clawsafe-mcp --version
 *
 * `serve` MUST NOT write to stdout (the MCP stdio transport owns it).
 * Diagnostics only ever go to stderr.
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { Connection } from "@solana/web3.js";
import { existsSync, writeFileSync } from "node:fs";
import {
  ensureDataDir,
  getCommitment,
  getHistoryPath,
  getKeypairPath,
  getPolicyPath,
  getRpcUrl,
  sensitiveFileMode,
  VERSION,
} from "./config.js";
import { getOrCreateKeypair, loadKeypair } from "./wallet.js";
import { loadPolicy } from "./policy.js";
import { registerTools } from "./tools.js";

const PACKAGE_BIN = "clawsafe-mcp";
const SERVER_NAME = "clawsafe";

const program = new Command();
program
  .name(PACKAGE_BIN)
  .description(
    "ClawSafe — MCP server for safe Solana spending by AI agents.\n" +
      "Isolated burner wallet with Token-2022 CPI Guard, hard policy limits, x402 paid APIs.\n" +
      "Your main wallet stays untouched.",
  )
  .version(VERSION);

program
  .command("init")
  .description("Create the burner wallet and config files, then print the MCP client config snippet.")
  .action(() => {
    ensureDataDir();

    const wallet = getOrCreateKeypair();
    const policy = loadPolicy(); // writes the default policy when missing
    const historyPath = getHistoryPath();
    if (!existsSync(historyPath)) {
      writeFileSync(historyPath, "[]\n", { encoding: "utf8", mode: sensitiveFileMode });
    }

    const keypairPath = getKeypairPath();
    const policyPath = getPolicyPath();

    console.log("");
    console.log(`  clawsafe · ${PACKAGE_BIN} v${VERSION}`);
    console.log("  ───────────────────────────────────────────────────────────────");
    console.log("");
    console.log(`  ✔ Burner wallet ${wallet.created ? "generated" : "already exists"}: ${keypairPath}`);
    console.log(`     Sub-wallet address:  ${wallet.address}`);
    console.log("");
    console.log("  ⚠  The private key never leaves this machine. It is never exposed to");
    console.log("     MCP tools, responses, or logs. Never share keypair.json.");
    console.log("");
    console.log(`  ✔ Policy file: ${policyPath}`);
    console.log(
      `     Limits: ${policy.maxPerTxSol} SOL/tx · ${policy.maxPerHourSol} SOL/hour · ` +
        `${policy.maxPerTxUsdc} USDC/tx · ${policy.maxPerHourUsdc} USDC/hour`,
    );
    console.log(
      `     Whitelist: ${policy.whitelistedAddresses.length > 0 ? policy.whitelistedAddresses.join(", ") : "disabled (any recipient allowed)"}`,
    );
    console.log(
      `     Allowed x402 domains: ${policy.allowedX402Domains.length > 0 ? policy.allowedX402Domains.join(", ") : "disabled (any domain may be paid)"}`,
    );
    console.log(`  ✔ History file: ${historyPath}`);
    console.log("  🔒 Token-2022 CPI Guard is enforced on this wallet's accounts");
    console.log("     (see the get_allowance_status tool).");
    console.log("");
    console.log("  Next: fund the sub-wallet with only what you can afford to lose,");
    console.log("  then add the server to your MCP client:");
    console.log("");
    console.log("  claude_desktop_config.json (macOS / Linux):");
    console.log("  {");
    console.log('    "mcpServers": {');
    console.log(`      "${SERVER_NAME}": {`);
    console.log('        "command": "npx",');
    console.log(`        "args": ["-y", "${PACKAGE_BIN}", "serve"]`);
    console.log("      }");
    console.log("    }");
    console.log("  }");
    console.log("");
    console.log("  claude_desktop_config.json (Windows):");
    console.log("  {");
    console.log('    "mcpServers": {');
    console.log(`      "${SERVER_NAME}": {`);
    console.log('        "command": "cmd",');
    console.log(`        "args": ["/c", "npx", "-y", "${PACKAGE_BIN}", "serve"]`);
    console.log("      }");
    console.log("    }");
    console.log("  }");
    console.log("");
    console.log(`  Cline / Cursor / any stdio MCP client: command 'npx -y ${PACKAGE_BIN} serve'.`);
    console.log("");
  });

program
  .command("serve", { isDefault: true })
  .description("Start the ClawSafe MCP server over stdio.")
  .action(async () => {
    let keypair;
    try {
      keypair = loadKeypair();
    } catch (error) {
      console.error(`[clawsafe] ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const connection = new Connection(getRpcUrl(), getCommitment());
    const server = new McpServer({ name: SERVER_NAME, version: VERSION });
    registerTools(server, { connection, keypair });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    // From here the process lives until the client closes the stdio stream.
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(`[clawsafe] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
