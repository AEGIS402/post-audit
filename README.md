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

## v1 Scope

- ERC20 `transfer`, `approve`, `transferFrom` calldata decode.
- ERC20 `Transfer` and `Approval` log decode.
- Subject-centric ERC20/native ETH flows.
- ERC20 approval risk signals.
- Uniswap V3 `exactInputSingle` decode with value imbalance and zero `amountOutMinimum` signals.
- LLM output JSON parse/schema/evidence validation.

Out of scope for v1: ERC721, selector DB lookup, external labels, compliance lists, debug traces, internal call tree, and full state diff.
