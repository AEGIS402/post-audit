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

Every successful audit response includes both `risk_level` and `risk_score`.

- `risk_level`: categorical severity. Allowed values are `low`, `medium`, `high`, and `critical`.
- `risk_score`: numeric severity from `0` to `100`, where higher means riskier.

Recommended interpretation:

| risk_level | risk_score range | Meaning |
| --- | ---: | --- |
| `low` | `0-24` | Normal-looking activity or only informational findings. |
| `medium` | `25-59` | Suspicious or user-confirmation-worthy activity without strong loss evidence. |
| `high` | `60-84` | Strong risk signal, high-value exposure, dangerous approval, or compliance-sensitive interaction. |
| `critical` | `85-100` | Severe loss pattern, extreme value imbalance, missing slippage protection on harmful swap, or urgent incident candidate. |

The LLM returns the final level and score, but the local schema enforces `risk_level` membership and the `0-100` score range.

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

Example response:

```json
{
  "risk_level": "low",
  "risk_score": 0,
  "one_line_summary": "Standard ERC20 USDC transfer of 100 USDC from subject address to counterparty.",
  "executive_summary": "The transaction 0x148365227e5820b06f2d9786aea454f96cf2b686bd26fdeb825ffda18b7633f3 is a simple ERC20 transfer of 100 USDC (6 decimals) from the subject address 0x5Bee9b98669D032352E7Eec4B7F4486ABe00F897 to the recipient 0x44Eb044aa553E45C17d029983727abC8b633cb9A. The transfer succeeded, consumed 62,248 gas, and no value in ETH was transferred. No suspicious patterns or rule violations were detected.",
  "findings": [
    {
      "type": "transfer",
      "severity": "info",
      "title": "ERC20 USDC transfer of 100 USDC",
      "description": "Subject address 0x5Bee9b98669D032352E7Eec4B7F4486ABe00F897 sent 100 USDC (token 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48) to 0x44Eb044aa553E45C17d029983727abC8b633cb9A. The transfer was successful and recorded in the transaction receipt log.",
      "evidence_refs": [
        "receipt.raw.logs[0]"
      ],
      "confidence": 1
    }
  ],
  "benign_explanations_to_check": [],
  "missing_evidence": [],
  "recommended_actions": [
    "No further action required."
  ],
  "final_assessment": "The transaction is a normal ERC20 token transfer with no indicators of risk."
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

Example response:

```json
{
  "risk_level": "critical",
  "risk_score": 92,
  "one_line_summary": "Uniswap V3 swap of ~220,806 USDC for ~5,273 USDT with 97.6% loss and no slippage protection.",
  "executive_summary": "The subject address swapped 220,806.389669 USDC for only 5,272.998058 USDT via Uniswap V3's exactInputSingle function. The transaction set amountOutMinimum to zero, providing no slippage protection, and resulted in an extreme value imbalance (output/input ratio approximately 0.024, ~97.6% loss). Two ERC-20 Transfer events confirm the outflow of USDC and inflow of USDT. The combination of a critical loss and missing slippage protection indicates a high-risk transaction.",
  "findings": [
    {
      "type": "extreme_value_imbalance",
      "severity": "critical",
      "title": "Extreme value imbalance: massive loss on swap",
      "description": "The subject sent approximately 220,806.389669 USDC and received only 5,272.998058 USDT, representing a ~97.6% loss (output/input ratio 0.0239).",
      "evidence_refs": [
        "flow#1",
        "flow#0"
      ],
      "confidence": 1
    },
    {
      "type": "missing_slippage_protection",
      "severity": "critical",
      "title": "Missing slippage protection in Uniswap V3 exactInputSingle call",
      "description": "The decoded exactInputSingle calldata has amountOutMinimum set to zero, providing no protection against price slippage.",
      "evidence_refs": [
        "tx.raw.input"
      ],
      "confidence": 1
    },
    {
      "type": "erc20_transfer",
      "severity": "info",
      "title": "ERC-20 token transfers observed",
      "description": "Transfer of 220,806.389669 USDC from the subject to the pool and receipt of 5,272.998058 USDT from the pool to the subject.",
      "evidence_refs": [
        "log#1",
        "log#0"
      ],
      "confidence": 1
    }
  ],
  "benign_explanations_to_check": [
    "The user intentionally set amountOutMinimum to zero, accepting any execution price.",
    "The transaction may be part of a larger strategy (e.g., arbitrage) where the apparent loss is offset elsewhere."
  ],
  "missing_evidence": [],
  "recommended_actions": [
    "Review the user's intent and confirm whether the zero minimum output was deliberate.",
    "Advise adding a reasonable amountOutMinimum to protect against slippage in future swaps.",
    "Monitor the address for similar high-loss swaps and consider flagging for further analysis."
  ],
  "final_assessment": "The transaction exhibits a critical risk due to an extreme loss on a token swap and the absence of slippage protection. While the transfers themselves are standard ERC-20 events, the combination of a near-total loss and missing safeguards warrants a high-severity alert and further review."
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
