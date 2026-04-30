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

TX_HASH=0x... SUBJECT_ADDRESS=0x... npx hardhat run scripts/audit-tx.ts --network mainnet

FIXTURE_PATH=fixtures/simple-transfer.json SUBJECT_ADDRESS=0x... npx hardhat run scripts/audit-fixture.ts
```

Use `OUTPUT_PATH=out.json` or pass script args after Hardhat's `--`, for example `npx hardhat run scripts/audit-fixture.ts -- --out out.json`, to write the validated audit JSON to a file as well as stdout.

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
  "one_line_summary_ko": "주체 주소가 100 USDC를 정상적인 ERC20 전송으로 보냈음",
  "executive_summary_ko": "해당 트랜잭션은 주체 주소가 USDC 토큰 100개를 다른 주소로 전송한 단순 ERC20 전송이며, 성공적으로 처리되었습니다. 의심스러운 행위나 비정상적인 패턴이 발견되지 않아 위험 수준은 낮습니다.",
  "findings": [
    {
      "type": "simple_erc20_transfer",
      "severity": "info",
      "title_ko": "단순 ERC20 전송",
      "description_ko": "주체 주소가 100 USDC를 다른 주소로 전송했으며, 트랜잭션은 성공적으로 완료되었습니다.",
      "evidence_refs": [
        "flow#0"
      ],
      "confidence": 0.99
    }
  ],
  "benign_explanations_to_check": [
    "정상적인 토큰 전송",
    "사용자 간 결제 또는 교환"
  ],
  "missing_evidence": [],
  "recommended_actions_ko": [
    "현재로서는 추가 조치가 필요하지 않음",
    "정기적인 모니터링을 유지"
  ],
  "final_assessment_ko": "이 트랜잭션은 정상적인 ERC20 토큰 전송으로 판단되며, 위험도는 낮음"
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
