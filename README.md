# Post-Audit

Hardhat 3, Hardhat ethers, Solidity mocks, and TypeScript utilities for the RPC-to-LLM post-transaction audit flow described in `PROPOSAL.md`.

## Setup

```bash
npm install
cp .env.example .env
```

Required runtime environment variables:

- `MAINNET_RPC_URL`: Ethereum mainnet RPC URL for live transaction analysis.
- `LLM_BASE_URL`: OpenAI-compatible base URL that already includes `/v1`.
- `LLM_MODEL`: model name, for example `gpt-oss-120b`.
- `PRICE_OVERRIDES_JSON`: optional token-address-to-USD-price map.

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

The server listens on `HOST` and `PORT`, defaulting to `127.0.0.1:3000`. Both endpoints return the same validated audit JSON produced by the CLI path.

Audit with an explicit subject address:

```bash
curl -s http://127.0.0.1:3000/audit/subject \
  -H "Content-Type: application/json" \
  -d '{
    "tx_hash": "0x...",
    "subject_address": "0x..."
  }'
```

Audit using `tx.from` as the subject address:

```bash
curl -s http://127.0.0.1:3000/audit/from-tx \
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

The LLM proposes the final score, but local normalization fixes `score_version`, sets `model` from `LLM_MODEL`, enforces `0-100` score ranges, and derives severity from the score bands above.

## API E2E Examples

These examples use the API server path: HTTP request -> live RPC lookup -> deterministic audit payload -> configured LLM endpoint -> local JSON schema validation -> JSON response.

Start the server first:

```bash
npm run api
```

### Normal Transfer

Request:

```bash
curl -s http://127.0.0.1:3000/audit/subject \
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
curl -s http://127.0.0.1:3000/audit/from-tx \
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

## v1 Scope

- ERC20 `transfer`, `approve`, `transferFrom` calldata decode.
- ERC20 `Transfer` and `Approval` log decode.
- Subject-centric ERC20/native ETH flows.
- ERC20 approval risk signals.
- Uniswap V3 `exactInputSingle` decode with value imbalance and zero `amountOutMinimum` signals.
- LLM output JSON parse/schema/evidence validation.

Out of scope for v1: ERC721, selector DB lookup, external labels, compliance lists, debug traces, internal call tree, and full state diff.
