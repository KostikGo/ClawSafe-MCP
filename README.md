<div align="center">

# 🐾 ClawSafe

### The safest way to let AI agents spend on Solana

[![npm version](https://img.shields.io/npm/v/clawsafe-mcp.svg)](https://www.npmjs.com/package/clawsafe-mcp)
[![GitHub Repo stars](https://img.shields.io/github/stars/KostikGo/ClawSafe-MCP?style=social)](https://github.com/KostikGo/ClawSafe-MCP)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20✓-3178c6.svg)](https://www.typescriptlang.org/)
[![Solana](https://img.shields.io/badge/Solana-mainnet%20β-9945FF.svg)](https://solana.com/)

**Solana** · **MCP** · **AI agents** · **x402** · **Token-2022** · **micropayments**

⭐ **Star this repo** if it's useful — it helps other builders discover ClawSafe.

</div>

---

> **ClawSafe** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that gives
> autonomous AI agents — **Cline, Cursor, Claude Code, Roo Code** — their own **policy-gated Solana wallet**, so they can
> pay for APIs and move micro-funds autonomously **without ever touching your main wallet**.
>
> **Give agents spending power, not your seed phrase.**

## 🎯 TL;DR

```bash
npx -y clawsafe-mcp init     # create the local allowance wallet (~/.clawsafe)
npx -y clawsafe-mcp serve    # start the MCP server (stdio) for any MCP client
```

- ✅ Local **burner wallet** — your main Solana wallet is never imported, configured, or read.
- ✅ **Hard policy engine** — per-transaction and rolling-hour spend limits, enforced *before* anything is signed.
- ✅ **Token-2022 CPI Guard** — protects the agent's token accounts from hidden cross-program transfers.
- ✅ **x402 paid APIs** — agents self-serve `HTTP 402 Payment Required` resources inside their allowance.
- ✅ **SOL / USDC payments and Jupiter swaps** — every operation is one atomic, fully signed transaction.
- ✅ **Works everywhere MCP works** — Claude Desktop, Cline, Cursor, Roo Code, any stdio client.

## 🤖 What an agent session looks like

```
You:     "Fetch the paid weather report and send 0.01 SOL to Alice."

Agent:   get_allowance_status()
           → solBalance: 0.5 SOL · remaining this hour: 0.2 SOL · limits OK

Agent:   x402_paid_fetch("https://api.weatherx.io/report")
           ← 402 Payment Required (invoice: 0.001 SOL)
           → ClawSafe pays from the burner wallet (inside the limits)
           → retries with the payment proof attached
           → returns the JSON report + the payment receipt

Agent:   pay_sol(alice, 0.01)
           → atomic transfer, signature returned, spent logged against the hour

Agent:   "Done. Report attached. 0.19 SOL remaining this hour."
```

No copy-pasting signatures, no wallet approvals, no human in the loop — and no way for the agent to overshoot the policy you set.

## ✨ Features

| | Feature | What it means for you |
| --- | --- | --- |
| 🔐 | **Isolated burner wallet** | A local sub-wallet generated with `0600` permissions. Agents can only ever spend what you fund it with. |
| 🧱 | **Hard policy engine** | `maxPerTx*` / `maxPerHour*` limits, an address whitelist and an x402 domain allow-list — checked locally, in-process, before any transaction is built. |
| 🔒 | **Token-2022 CPI Guard** | The wallet's Token-2022 accounts block transfers triggered by *other* programs (hidden CPI drains). Enabled automatically. |
| 🌐 | **x402 paid-fetch** | The agent can consume `402 Payment Required` APIs: ClawSafe parses the invoice, checks the limits, pays and replays the request with proof. |
| ⚡ | **Payments & swaps** | `pay_sol`, `pay_usdc` and Jupiter swaps — each a single atomic transaction recorded in a rolling-hour spend log. |
| ♻️ | **Trapped-rent audit** | `check_trapped_rent` finds empty token accounts locking SOL in rent and points you to a 1-click reclaim tool. |

## 🚀 Quick start

Requires **Node.js ≥ 20**.

```bash
# 1) Create the allowance wallet, policy and spend log (~/.clawsafe)
npx -y clawsafe-mcp init
```

```
  ✔ Burner wallet generated: ~/.clawsafe/keypair.json
     Sub-wallet address:  Ad8zCHiwBXVwVKioC3GGR2CU6fkTJbCzsokjG21s5PdK

  ✔ Policy file: ~/.clawsafe/policy.json
     Limits: 0.05 SOL/tx · 0.2 SOL/hour · 5 USDC/tx · 20 USDC/hour
  🔒 Token-2022 CPI Guard enforced on this wallet's accounts
```

```bash
# 2) Fund the burner wallet with a small amount of SOL / USDC (only what you can lose)

# 3) Point your MCP client at it — the server name is "clawsafe"
```

**Claude Desktop** — `claude_desktop_config.json`:

```jsonc
// macOS / Linux
{
  "mcpServers": {
    "clawsafe": {
      "command": "npx",
      "args": ["-y", "clawsafe-mcp", "serve"]
    }
  }
}
```

```jsonc
// Windows
{
  "mcpServers": {
    "clawsafe": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "clawsafe-mcp", "serve"]
    }
  }
}
```

**Cline / Cursor / Roo Code / Zed / OpenAI Agents SDK** — add a **stdio** MCP server: command `npx`, args `-y clawsafe-mcp serve`.

## 🧰 The 6 MCP tools

| Tool | What it does |
| --- | --- |
| `get_allowance_status` | The burner address, SOL/USDC balances, CPI Guard status, active limits and the remaining allowance this hour. Call it before any payment. |
| `pay_sol` | Send SOL. Params: `toAddress`, `amountSol`, `memo?` → signature + cost breakdown. |
| `pay_usdc` | Send USDC (creates the recipient's account if needed). Params: `toAddress`, `amountUsdc`, `memo?`. |
| `swap_tokens` | Swap via Jupiter. Params: `inputMint`, `outputMint`, `amount`. CPI Guard is auto-enabled on Token-2022 outputs. |
| `x402_paid_fetch` | Fetch a URL; if it returns `402 Payment Required`, pay the invoice and replay with proof. Params: `url`, `method?`, `headers?`, `body?`. |
| `check_trapped_rent` | Audit empty SPL/Token-2022 accounts and report the SOL locked as rent, with a 1-click reclaim link. |

All inputs are `zod`-validated; violations return an `isError` result that names the violated limit and the exact remaining allowance, so agents can retry within budget instead of looping.

## 🛡️ Security model

| Asset | Agent access |
| --- | --- |
| **Your main wallet** | ❌ Never imported, configured, or read anywhere in this server. |
| **Burner keypair** | ⚠️ On disk at `~/.clawsafe/keypair.json` (`0600`). Used only to sign transactions the policy engine approved — never returned in tool responses, never logged. |
| **Burner funds** | ✅ Bounded by per-tx + rolling-hour limits, the address whitelist and the x402 domain allow-list. |
| **Token-2022 accounts** | 🔒 CPI Guard enabled — other programs cannot sweep them via hidden cross-program calls. |

- **Local enforcement.** Limits are checked in-process *before* any transaction is built or signed. There is no remote API to bypass, nothing to phish.
- **Safe defaults.** A fresh install allows `0.05 SOL/tx`, `0.2 SOL/hour`, `5 USDC/tx`, `20 USDC/hour`. Unknown or malformed policy fields always fall back to the defaults — a half-edited `policy.json` can never silently disable a limit.
- **Auditable accounting.** Every executed spend is appended to `~/.clawsafe/history.json`; a corrupt history is a hard failure instead of silently forgotten limits.
- **One-way flows.** A scam instruction from an agent can only spend within the allowance — it can never reach your main accounts or drain savings.

## 🔒 Token-2022 CPI Guard, explained

A normal Token-2022 account can be spent not only by you, but also **by any program you interact with** — a malicious dApp can trigger a hidden CPI (cross-program invocation) that transfers your tokens out while you're signing something unrelated. ClawSafe enables the **CPI Guard extension** on the wallet's Token-2022 accounts:

- With the guard on, transfers from that account only succeed when the instruction is signed **directly by you** (the owner), not pushed through another contract.
- It activates automatically — `swap_tokens` enables it on the received Token-2022 account right after the swap lands, and `get_allowance_status` reports the protection state of every account.

## 🧱 Policy engine

`~/.clawsafe/policy.json` is the hard firewall the agent cannot talk its way out of:

```json
{
  "maxPerTxSol": 0.05,
  "maxPerHourSol": 0.2,
  "maxPerTxUsdc": 5.0,
  "maxPerHourUsdc": 20.0,
  "whitelistedAddresses": [],
  "allowedX402Domains": []
}
```

- **`maxPerTx*` / `maxPerHour*`** — hard caps per transaction and per rolling 60 minutes (from `history.json`). SOL and USDC are tracked separately.
- **`whitelistedAddresses`** — when non-empty, transfers may only go to these base58 addresses.
- **`allowedX402Domains`** — when non-empty, paid-fetch auto-payment is restricted to these domains (exact match or `*.domain.com`).
- Limits always apply to the **total amount debited from the wallet** in a single atomic operation.
- Rejections are written for the agent: *"the total cost of X exceeds the per-transaction limit of Y… remaining right now: Z"* — so it can retry with a smaller amount instead of guessing.

## 🌐 x402: paid APIs for autonomous agents

[x402](https://x402.org) is the open standard that turns `HTTP 402 Payment Required` into machine-payable invoices. With the `x402_paid_fetch` tool, your agent can consume paid APIs end-to-end:

1. ClawSafe fetches the URL; the API answers `402` with payment requirements (x402 v2 JSON body or a URL-encoded `PAYMENT-REQUIRED` header).
2. The domain is checked against `allowedX402Domains`, and the invoice amount against the **same policy limits** used for every other payment.
3. ClawSafe pays from the burner wallet and replays the request with the Solana transaction signature in the `PAYMENT-SIGNATURE` / `X-PAYMENT` header.
4. The agent receives the API's payload **plus a payment receipt** (amount, signature, explorer link).

Guardrails: the payment is attempted **exactly once** (a repeat `402` is an error, never a loop), an invoice for a **different resource** is refused, and only SOL / USDC invoices are supported.

## ♻️ Trapped rent — audited, never auto-reclaimed

Empty SPL Token / Token-2022 accounts still hold a SOL **rent deposit** (~0.002 SOL each). ClawSafe deliberately never closes accounts from agent flows — mixing rent reclaims with AI-driven transfers is how funds get moved by mistake. Instead, `check_trapped_rent` scans both token programs and reports:

> *Found 12 empty token accounts locking 0.0244 SOL in rent. Reclaim your SOL safely in 1 click at https://excesssol.xyz*

Reclaiming stays a **human action** at **https://excesssol.xyz** (independent third party — review it before use).

## 🏗️ How it works

```
┌──────────────┐      MCP (stdio)       ┌──────────────────────────────────┐
│  AI agent    │ ◄──────────────────►   │        clawsafe-mcp              │
│ (Cline /     │     6 tools only       │      (this server, Node)         │
│  Cursor /    │                        │                                  │
│  Claude)     │                        │  ┌──────────────────────────┐    │
└──────────────┘                        │  │ Burner wallet keypair     │    │ ← fund this, never your main wallet
                                        │  │  ~/.clawsafe/keypair.json │    │
                                        │  └─────────────┬────────────┘    │
                                        │  Policy engine  (hard limits)   │ ← checked BEFORE anything is signed
                                        │  Solana layer   (payments/swaps)│
                                        │  x402 client    (auto-pay 402)   │
                                        └────────────────┬─────────────────┘
                                                         ▼
                                        ┌──────────────────────────────────┐
                                        │         Solana mainnet           │
                                        │   recipient ← full amount        │
                                        └──────────────────────────────────┘
```

## 💡 Use cases

- **Pay-per-request AI APIs** — give agents a budget for x402 endpoints (weather, data, inference) without manual invoicing.
- **Agentic commerce prototypes** — capped budgets for agents that buy digital goods or trigger payouts.
- **Sandboxed agent research** — study autonomous spending behavior with real transactions and hard ceilings.
- **Team tooling budgets** — each coding agent gets its own allowance for SaaS / infra APIs.

## ⚙️ Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC endpoint. Use your own (Helius/QuickNode) key in production, or a devnet endpoint for testing. |
| `SOLANA_COMMITMENT` | `confirmed` | Commitment level (`processed` \| `confirmed` \| `finalized`). |
| `CLAWSAFE_HOME` | `~` | Parent dir of the `.clawsafe` data dir (tests, multiple profiles). |

Set them in `.env` (see `.env.example`), in the `env` block of your MCP client config, or in your shell.

## 👨‍💻 Development

```bash
npm install          # install dependencies
npm run build        # tsc → dist/
npm run typecheck    # strict type-check of src + tests (no emit)
npm test             # node:test + tsx: spend limits, cost math, x402 parsing
npm run dev -- init  # run the CLI from source (tsx)
node dist/index.js init   # or run the built CLI directly
```

> Tests use `node --import tsx`, which needs **Node ≥ 20.6**.

### 🔎 Known transitive advisory (`bigint-buffer`)

`npm audit` reports one remaining high advisory: `bigint-buffer` ([GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)), a deep transitive dependency of `@solana/spl-token` (via `@solana/buffer-layout-utils`). It has **no fixed release** — 1.1.5 is the last version ever published, and npm's only suggested "fix" is downgrading `@solana/spl-token` to `0.1.8`, which predates Token-2022 and would break CPI Guard. Assessment:

- The vulnerable function is only reached when decoding on-chain data returned by **the RPC endpoint you configure** (`SOLANA_RPC_URL`).
- The impact is availability only (a potential uncaught `RangeError` on a crafted payload), not memory corruption — Node's Buffers are bounds-checked.
- Every other advisory the audit reported (`zod`, `stream-json`, `uuid`) is resolved at the root of the tree via direct version upgrades and the `overrides` block in `package.json`.

We track upstream and will drop this dependency as soon as `@solana/spl-token` removes it.

## 📦 Project structure

```
src/
├── index.ts     # CLI: `init` (wallet + config bootstrap) and `serve` (default, stdio MCP server)
├── config.ts    # Routing parameters, paths under ~/.clawsafe, RPC/protocol constants
├── wallet.ts    # Burner wallet generation/storage + Token-2022 CPI Guard helpers
├── policy.ts    # Policy engine: limits, rolling-hour history, whitelist, x402 domain gate
├── solana.ts    # Payments, Jupiter swaps, rent scan, wallet status
├── x402.ts      # HTTP 402 parsing and the paidFetch flow
└── tools.ts     # The 6 MCP tools with zod schemas
tests/           # node:test unit tests: cost math, policy limits, x402 parsing
```

State on disk (`~/.clawsafe/`, all mode `0600`): `keypair.json` (burner secret key — never share, never exposed to tools), `policy.json` (limits, whitelist, allowed x402 domains), `history.json` (rolling-hour spend log).

## ❓ FAQ

**What is a burner wallet?** A throwaway hot wallet that holds only the funds you put into it. In ClawSafe it lives at `~/.clawsafe/keypair.json` — the agent's only money pipe, bounded by the policy engine.

**Does the agent see my private keys?** No. The keypair is only used *inside* the server process to sign transactions the policy engine approved. It never appears in a tool response, a prompt, or a log.

**How is this different from pasting my wallet into an agent?** Scope and blast radius: a main wallet gives the agent everything, a ClawSafe burner gives it a capped allowance with per-tx + rolling-hour limits, a recipient whitelist, and CPI-guarded token accounts.

**Which MCP clients work?** Any client that speaks stdio MCP: Claude Desktop, Cline, Cursor, Roo Code, Zed, the OpenAI Agents SDK, `mcp-inspector`, and more.

**Which chains / tokens?** Solana (mainnet; point `SOLANA_RPC_URL` at devnet to test), native SOL, USDC, and any SPL / Token-2022 token via Jupiter swaps.

**What is x402?** An open protocol that makes `HTTP 402 Payment Required` machine-readable (amount, asset, pay-to address), so clients can pay per API request. ClawSafe implements the Solana side: parse → approve → pay → retry with proof.

**What happens when the agent hits a limit?** It gets a plain-English MCP error naming the violated limit and the exact remaining allowance, so it can retry smaller or wait — never bypass.

**Is it safe?** It's self-custodial and open-source: your keys, your machine, your policy. Still — this moves real money on mainnet. Fund only what you can lose, test on devnet, and review the code (start with `src/policy.ts` and `src/wallet.ts`).

## 🗺️ Roadmap

- [x] Repository, CLI (`init` / `serve`) and the `~/.clawsafe` layout
- [x] Burner wallet + Token-2022 CPI Guard
- [x] Policy engine (per-tx + rolling-hour limits, whitelist, x402 domain gate)
- [x] `pay_sol`, `pay_usdc`, `swap_tokens` (Jupiter) and `check_trapped_rent`
- [x] x402 paid-fetch (JSON v2 + header invoices, one-shot payment)
- [x] The 6 MCP tools with zod validation, unit tests, docs (that's this README!)

**Ideas:** devnet mode flag, multi-wallet profiles, notifications when limits reset, more input assets for swap accounting, payment-channel top-ups, a desktop widget.

## 🤝 Contributing

PRs are welcome — see the roadmap above for direction. Good first issues: new x402 parsers, more tools (NFT transfers, compressed tokens), docs translations, and more MCP client recipes.

1. Fork it, `npm install`, `npm test` must stay green.
2. Keep the strict TS settings and add tests for new policy/math behavior.
3. Open a PR describing the use case (agents-enabled examples win bonus points).

If ClawSafe helps you ship an agent, **tell the world** — and leave a ⭐ so others find it.

## 📄 License

**Apache-2.0** — see [LICENSE](./LICENSE). Use it, fork it, self-host it, build a product on it.

## ⚠️ Disclaimer

This software is provided **as is, without warranty of any kind**. Transactions on Solana are irreversible. Nothing in this repository is financial advice. Always test on devnet, never fund the burner wallet beyond what you can afford to lose, and review the code you are trusting. ClawSafe is not affiliated with Solana Labs, Jupiter, the x402 working group, or https://excesssol.xyz.

---

<div align="center">

**[⭐ Star the repo](https://github.com/KostikGo/ClawSafe-MCP)** · **[📦 npm package](https://www.npmjs.com/package/clawsafe-mcp)** · **[Issues](https://github.com/KostikGo/ClawSafe-MCP/issues)**

Made for autonomous agents that deserve an allowance, not a blank check.

</div>