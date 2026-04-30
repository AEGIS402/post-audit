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

## E2E Example

The fixture E2E path reads raw RPC-shaped input, builds the audit payload, calls the configured LLM endpoint from `.env`, validates the model JSON with the local schema, and prints only the validated audit output.

```bash
FIXTURE_PATH=fixtures/simple-transfer.json OUTPUT_PATH=/tmp/post-audit-e2e-readme.json npx hardhat run scripts/audit-fixture.ts
```

Input fixture summary:

```json
{
  "chain_id": 1,
  "tx_hash": "0x148365227e5820b06f2d9786aea454f96cf2b686bd26fdeb825ffda18b7633f3",
  "subject_address": "0x5bee9b98669d032352e7eec4b7f4486abe00f897",
  "raw_rpc": {
    "eth_getTransactionByHash": {
      "from": "0x5bee9b98669d032352e7eec4b7f4486abe00f897",
      "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "value": "0x0",
      "input": "0xa9059cbb..."
    },
    "eth_getTransactionReceipt": {
      "status": "0x1",
      "logs": ["ERC20 Transfer log for 100 USDC"]
    },
    "eth_call_token_metadata": [
      {
        "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "decoded": {
          "name": "USD Coin",
          "symbol": "USDC",
          "decimals": 6
        }
      }
    ]
  }
}
```

Validated E2E output:

```json
{
  "risk_level": "low",
  "risk_score": 5,
  "one_line_summary": "Subject address transferred 100 USDC to another address; transaction succeeded with no ETH value transferred.",
  "executive_summary": "The transaction is a standard ERC20 transfer of 100 USDC from the subject to 0x44Eb044aa553E45C17d029983727abC8b633cb9A. The call succeeded, no ETH was moved, no approvals were changed, and no red flags are present in the provided evidence.",
  "findings": [
    {
      "type": "erc20_transfer",
      "severity": "info",
      "title": "Standard USDC transfer",
      "description": "Subject sent 100 USDC to address 0x44Eb044aa553E45C17d029983727abC8b633cb9A. The transfer succeeded and matches the expected ERC20 Transfer event.",
      "evidence_refs": [
        "flow#0"
      ],
      "confidence": 1
    }
  ],
  "benign_explanations_to_check": [
    "User-initiated payment or settlement",
    "Routine fund reallocation between wallets"
  ],
  "missing_evidence": [],
  "recommended_actions": [
    "Continue monitoring the subject address for unusual patterns or larger transfers.",
    "Verify that the counterparty address is known and trusted if required by compliance policies.",
    "Consider adding internal call tracing for future high-value or suspicious transactions."
  ],
  "final_assessment": "The transaction poses low risk. It is a normal ERC20 token transfer with no anomalies detected."
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
