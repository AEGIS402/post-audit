# Post-Audit

Hardhat 3, Hardhat ethers, Solidity mocks, and TypeScript utilities for the RPC-to-LLM post-transaction audit flow described in `PROPOSAL.md`.

## Setup

```bash
npm install
cp .env.example .env
```

Required runtime environment variables:

- `MAINNET_RPC_URL`: Ethereum mainnet RPC URL for live transaction analysis.
- `OPENAI_API_KEY`: OpenAI API key for the GPT API. When this is set and no explicit LLM base URL is passed in code, the audit runner uses `https://api.openai.com/v1`.
- `OPENAI_MODEL`: OpenAI model name, for example `gpt-5.4-mini-2026-03-17`.
- `PRICE_OVERRIDES_JSON`: optional token-address-to-USD-price map.

Local or self-hosted OpenAI-compatible endpoints are still supported by leaving
`OPENAI_API_KEY` unset and configuring:

- `LLM_BASE_URL`: OpenAI-compatible base URL that already includes `/v1`.
- `LLM_MODEL`: model name, for example `gpt-oss-120b`.

Optional LLM response cache variables:

- `OPENAI_BASE_URL`: optional OpenAI API base URL override, defaulting to `https://api.openai.com/v1`.
- `LLM_MAX_TOKENS_FIELD`: request token-limit field override. Defaults to `max_completion_tokens` for the official OpenAI API and `max_tokens` for local-compatible endpoints.
- `LLM_REASONING_EFFORT`: optional Chat Completions `reasoning_effort` value. Set to `low` for lower latency and lower reasoning-token usage.
- `LLM_RESPONSE_CACHE`: enables the API/CLI response cache by default. Set to `0` to disable it.
- `LLM_RESPONSE_CACHE_DIR`: cache directory, defaulting to `cache/llm-responses`.
- `LLM_RESPONSE_CACHE_DB_PATH`: SQLite response cache path, defaulting to `cache/llm-responses/responses.sqlite`. The cache opens SQLite in WAL mode.
- `LLM_RESPONSE_CACHE_FORCE_REFRESH`: set to `1` to bypass cache reads and overwrite entries.
- `LLM_RESPONSE_CACHE_TTL_SECONDS`: cache entry TTL, defaulting to `0` for no TTL-based expiration.
- `LLM_RESPONSE_CACHE_MAX_ENTRIES`: maximum cache entries, defaulting to `4096`. Entries above the cap are pruned by oldest `accessed_at`.
- `LLM_RESPONSE_CACHE_MIN_CONFIRMATIONS`: API finality gate before evidence collection, LLM calls, or cache reads. Defaults to `2` confirmations on Ethereum mainnet/Sepolia and `0` elsewhere.
- `LLM_RESPONSE_CACHE_FINALITY_WAIT_TIMEOUT_MS`: maximum API wait for required confirmations, defaulting to `180000`.
- `LLM_RESPONSE_CACHE_FINALITY_POLL_MS`: block/receipt polling interval while waiting for finality, defaulting to `2000`.
- `LLM_RESPONSE_CACHE_LOG`: logs cache hit/miss/store events by default. Set to `0` to quiet it.

The LLM prompt is also laid out for endpoint-side prefix caching: fixed audit
instructions live in the system message, while the user message contains only
the serialized transaction payload. High-cardinality fields such as `tx_hash`
and `raw_evidence` are serialized near the end of the payload.

## Commands

```bash
npm run compile
npm test
npm run api

TX_HASH=0x... SUBJECT_ADDRESS=0x... npx hardhat run scripts/audit-tx.ts --network mainnet

FIXTURE_PATH=fixtures/simple-transfer.json SUBJECT_ADDRESS=0x... npx hardhat run scripts/audit-fixture.ts
```

Use `OUTPUT_PATH=out.json` or pass script args after Hardhat's `--`, for example `npx hardhat run scripts/audit-fixture.ts -- --out out.json`, to write the validated audit JSON to a file as well as stdout.

## API

Start the API server:

```bash
npm run api
```

The server listens on `HOST` and `PORT`, defaulting to `127.0.0.1:13000`. Both endpoints return the same validated audit JSON produced by the CLI path.

Audit with an explicit subject address:

```bash
curl -s http://127.0.0.1:13000/audit/subject \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0x...",
    "subject_address": "0x..."
  }'
```

To bypass a cached LLM response for one API call, add `"force_refresh": true`
to either request body.

Audit using `tx.from` as the subject address:

```bash
curl -s http://127.0.0.1:13000/audit/from-tx \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0x..."
  }'
```

## Risk Fields

Every successful audit response uses evmbench-style top-level scoring fields.

- `overall_risk_score`: numeric severity from `0` to `100`, where higher means riskier.
- `overall_severity`: categorical severity. Allowed values are `info`, `low`, `medium`, `high`, and `critical`.
- `score_version`: fixed to `risk-v1`.
- `vulnerabilities`: concrete risk items. Benign transactions should return an empty array.

Severity bands:

| overall_severity | overall_risk_score range | Meaning |
| --- | ---: | --- |
| `info` | `0-19` | Normal-looking activity or no risk condition detected. |
| `low` | `20-44` | Low-risk signal that may be useful context but is not urgent. |
| `medium` | `45-74` | Suspicious or user-confirmation-worthy activity without severe loss evidence. |
| `high` | `75-89` | Strong risk signal, high-value exposure, or dangerous approval. |
| `critical` | `90-100` | Severe loss pattern, extreme value imbalance, or missing slippage protection on a harmful swap. |

The LLM proposes the final score, but local normalization fixes `score_version`, sets `model` from the configured OpenAI or local LLM model, enforces `0-100` score ranges, and derives severity from the score bands above.

## API E2E Examples

These examples use the API server path: HTTP request -> live RPC lookup -> deterministic audit payload -> configured LLM endpoint -> local JSON schema validation -> JSON response.

Start the server first:

```bash
npm run api
```

### Normal Transfer

Request:

```bash
curl -s http://127.0.0.1:13000/audit/subject \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0x148365227e5820b06f2d9786aea454f96cf2b686bd26fdeb825ffda18b7633f3",
    "subject_address": "0x5Bee9b98669D032352E7Eec4B7F4486ABe00F897"
  }'
```

Request summary:

```json
{
  "tx_hash": "0x148365227e5820b06f2d9786aea454f96cf2b686bd26fdeb825ffda18b7633f3",
  "subject_address": "0x5Bee9b98669D032352E7Eec4B7F4486ABe00F897",
  "expected_decoded_behavior": "100 USDC ERC20 transfer out from the subject"
}
```

Actual response captured through the API server:

```json
{
  "model": "gpt-oss-120b",
  "score_version": "risk-v1",
  "overall_risk_score": 0,
  "overall_severity": "info",
  "overall_summary": "The transaction transferred 100 USDC from the subject address to another address, and no risky conditions were detected.",
  "vulnerabilities": []
}
```

### Anomaly Detection

Request using `tx.from` as the subject:

```bash
curl -s http://127.0.0.1:13000/audit/from-tx \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0xee9fcd2b9996e96b642cb4cda47fc140f98fdaf07ee02657743d4bfcc4670106"
  }'
```

Request summary:

```json
{
  "tx_hash": "0xee9fcd2b9996e96b642cb4cda47fc140f98fdaf07ee02657743d4bfcc4670106",
  "subject_source": "tx.from",
  "expected_decoded_behavior": "USDC/USDT swap with severe value imbalance and zero minimum output"
}
```

Actual response captured through the API server:

```json
{
  "model": "gpt-oss-120b",
  "score_version": "risk-v1",
  "overall_risk_score": 90,
  "overall_severity": "critical",
  "overall_summary": "The transaction performed an exactInputSingle swap on Uniswap V3, sending 220,806.389669 USDC and receiving only 5,272.998058 USDT, resulting in an approximate 97.6% loss. The swap was executed with amountOutMinimum set to zero, providing no slippage protection.",
  "vulnerabilities": [
    {
      "id": "V-001",
      "title": "Extreme value imbalance (large loss)",
      "severity": "critical",
      "risk_score": 90,
      "confidence_score": 90,
      "impact_score": 90,
      "exploitability_score": 80,
      "summary": "The subject transferred 220,806.389669 USDC out and received only 5,272.998058 USDT in, representing a loss of about 97.6% of the input value. This extreme imbalance indicates a highly risky transaction.",
      "remediation": "Avoid swaps with such disproportionate output. Verify price impact and expected output before executing, and use slippage limits to protect against excessive loss.",
      "evidence": [
        {
          "line_start": null,
          "line_end": null,
          "description": "Evidence refs: flow#1, flow#0."
        }
      ]
    },
    {
      "id": "V-002",
      "title": "Missing slippage protection (amountOutMinimum = 0)",
      "severity": "high",
      "risk_score": 85,
      "confidence_score": 90,
      "impact_score": 85,
      "exploitability_score": 80,
      "summary": "The decoded exactInputSingle call sets amountOutMinimum to zero, meaning the transaction accepts any amount of USDT in return, providing no protection against price slippage.",
      "remediation": "Specify a reasonable amountOutMinimum based on market rates to enforce slippage protection. Review and adjust contract calls to include minimum output constraints.",
      "evidence": [
        {
          "line_start": null,
          "line_end": null,
          "description": "Evidence refs: tx.raw.input."
        }
      ]
    }
  ]
}
```

## Insured Escrow E2E

The submodule `escrow-hook/` is an audit-responsive Uniswap v4 hook that escrows
the swap output until an audit agent calls `executeAuditDecision`. The script
[`scripts/e2e-escrow.ts`](scripts/e2e-escrow.ts) drives the full
victim-swap -> post-audit -> on-chain decision -> insurance settlement loop
against the deployed escrow-hook contracts on Sepolia.

Two scenarios run in one go:

- **normal**: user swaps 100 USDT through `protectedExactInputSingle`. Audit
  returns `info` (no rule signal fires). Decision: `RELEASE`. User receives
  the escrowed AEGIS.
- **sandwich**: an attacker front-runs a 500k USDT swap, then the same user
  swap, then back-runs. The victim's escrowed output is materially below the
  user-stated `expectedOutput`, so the
  `protected_swap_output_shortfall` rule signal fires and the LLM returns
  `high`. Decision: `BLOCK_AND_CLAIM`. Vault forwards the suspicious AEGIS to
  `InsurancePool`, and `InsurancePool` refunds the user's original USDT input
  amount as the insurance claim. The 0.5% protection fee is the only sunk cost
  to the user.

Required env (in `.env`):

```
SEPOLIA_RPC_URL=<archive-capable Sepolia RPC>
PRIVATE_KEY=0x<deployer key matching escrow-hook initialConfig.finalOwner>
OPENAI_API_KEY=<OpenAI API key>
OPENAI_MODEL=<model name>
```

Run against an in-process Sepolia fork (Hardhat 3 `edr-simulated` + `forking`,
no separate node needed):

```bash
npm run e2e:escrow:fork
```

Or against live Sepolia (uses gas; the script regenerates ephemeral
auditor/user/attacker wallets and funds them from `PRIVATE_KEY`):

```bash
npm run e2e:escrow:live
```

Both modes write `deployments/e2e-escrow-result.json` containing the swap and
decision tx hashes, the audit JSON for each scenario, and the final escrow
state and balance changes.

The orchestrator does not modify either repo's contracts. The mapping from
`overall_severity` to `AuditDecision.action` is:

| `overall_severity` | `AuditDecision.action` |
| --- | --- |
| `info`, `low` | `RELEASE` |
| `medium`, `high`, `critical` | `BLOCK_AND_CLAIM` |

## v1 Scope

- ERC20 `transfer`, `approve`, `transferFrom` calldata decode.
- ERC20 `Transfer` and `Approval` log decode.
- Subject-centric ERC20/native ETH flows.
- ERC20 approval risk signals.
- Uniswap V3 `exactInputSingle` decode with value imbalance and zero `amountOutMinimum` signals.
- AEGIS Protected Swap Adapter `protectedExactInputSingle` calldata decode.
- AEGIS Insured Escrow `EscrowRegistered` and `ProtectedSwapEscrowed` log decode.
- `protected_swap_output_shortfall` rule signal driven by escrow `outputAmount` vs user-stated `expectedOutput`.
- LLM output JSON parse/schema/evidence validation.

Out of scope for v1: ERC721, selector DB lookup, external labels, compliance lists, debug traces, internal call tree, and full state diff.

## Few-shot Augmentation (deferred)

[fixtures/few-shot-samples.json](fixtures/few-shot-samples.json) is a curated set of one canonical mainnet tx per risk category (failed tx, unlimited approval, missing slippage, hack exploit, hack recovery, sandwich victim, phishing drainer, MEV arbitrage, Permit2 drain, address poisoning, NFT setApprovalForAll, wallet drain) plus three negative anchors (plain ERC20/ERC721 transfer, balanced swap). Each entry carries a rationale for why that tx is the strongest demonstration of its category for prompt tuning.

Not wired into the LLM call yet. The intended use is selective few-shot — prepend the negative-of-pipeline cases (phishing_drainer, address_poisoning, permit2_signature_drain, hack_recovery, wallet_drain) where rule signals do not fire, so the model learns to flag patterns the deterministic layer misses without bloating context with categories already covered by `rule_signals`.
