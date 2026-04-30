# 사후감사 샘플 데이터 수집 작업 정리

## 배경
목표-대상은 ERC20 전송 / ERC721 전송 / swap. 프롬프트/퓨샷 깎는 데 쓸 데이터 수집. 하지만 **LLM이 tx 해시를 매우 쉽게 환각**한다는 게 핵심 위험이었음. "GPT한테 받았다"는 해시도 검증 안 하면 절반은 가짜이거나 다른 트랜잭션일 가능성이 큼. 그래서 어떤 경로로 모으든 마지막에 RPC로 한 번 더 조회해서 실재 확인하는 단계를 반드시 끼움.

## 접근 — 2-트랙

샘플의 출처를 정상/이상에 따라 분리:

| 트랙 | 방법 | 이유 |
|---|---|---|
| 정상 | 최근 메인넷 블록 RPC 스캔 → 카테고리별 자동 분류 | 정상 tx는 무작위 샘플로 충분히 다양함 |
| 이상 | 공개 사고 DB / 분석글에서 큐레이션 → RPC 검증 | 이상 tx는 통계적으로 희귀, 무작위 스캔으로 안 잡힘 |

마지막에 모든 해시(자동 + 큐레이션)는 RPC로 실재/상태 재확인.

## 만든 스크립트

전부 [scripts/](scripts/) 아래. Hardhat 네트워크 설정에 의존하지 않고 `RPC_URL` 환경변수만 받음 → 메인넷 외 다른 EVM 체인에도 그대로 사용 가능.

### [scripts/collect-samples.ts](scripts/collect-samples.ts)
최근 블록을 거꾸로 훑으면서 트랜잭션을 분류해서 버킷에 채움. 25블록마다 디스크에 flush, SIGTERM 받으면 graceful shutdown.

분류 로직 (selector + log topic count 기반, 결정론적):
- `erc20_transfer`: 1개 ERC20 `Transfer` 이벤트 + `transfer`/`transferFrom` selector
- `erc721_transfer`: 4-topic `Transfer` 이벤트 (ERC721 표준 — tokenId가 indexed)
- `swap`: 2개 이상의 ERC20 `Transfer` + 2개 이상의 토큰 + tx.from이 한쪽이라도 관여
- `failed_tx`: receipt.status == 0x0
- `unlimited_approval`: `approve(spender, MaxUint256)`
- `missing_slippage`: Uniswap V3 `exactInputSingle` with amountOutMinimum=0

### [scripts/verify-samples.ts](scripts/verify-samples.ts)
임의의 tx 해시 리스트를 받아서 RPC로 조회 → 위 로직으로 카테고리 자동 추론 + 출처/메모 보존. WebSearch로 받은 큐레이션 후보 검증용.

입력 포맷 유연하게: 해시 배열 / `{items: [...]}` / 카테고리별 dict 모두 받음.

### [scripts/aggregate-samples.ts](scripts/aggregate-samples.ts)
자동 수집 결과 + 큐레이션 결과를 합쳐서 최종 [abnormal.json](fixtures/samples/abnormal.json) 작성. 큐레이션 메타데이터는 [abnormal-curated.json](fixtures/samples/abnormal-curated.json)에 따로 보존.

## 결과물

[fixtures/samples/](fixtures/samples/) 폴더:

| 파일 | 내용 |
|---|---|
| `normal.json` | **정상 150개** (erc20_transfer 50 / erc721_transfer 50 / swap 50) |
| `abnormal.json` | **이상 131개** (병합 최종본, 카테고리별 버킷) |
| `abnormal-auto.json` | 자동 스캔 원본 (failed_tx 50, unlimited_approval 50, missing_slippage 0) |
| `abnormal-curated.json` | RPC 검증된 큐레이션 30개 + observed 메타 (실제 ERC20 전송 개수, selector, status 등) |
| `abnormal-candidates.json` | 큐레이션 raw 입력 (출처/메모 포함) |

### 이상 카테고리 분포 (abnormal.json)

| 카테고리 | 개수 | 출처 |
|---|---:|---|
| `failed_tx` | 50 | 자동 (RPC 스캔) |
| `unlimited_approval` | 50 | 자동 (RPC 스캔) |
| `missing_slippage` | 1 | 큐레이션 (README의 USDC→USDT 97.6% 손실 예시) |
| `hack_exploit` | 25 | 큐레이션 (Euler/Beanstalk/Sushi/Nomad/Curve/Inverse/KyberSwap/Cream/Conic) |
| `hack_recovery` | 1 | 큐레이션 (Curve 자금 반환 tx) |
| `sandwich_victim` | 2 | 큐레이션 |
| `phishing_drainer` | 1 | 큐레이션 (Angel Drainer USDC 인출) |
| `mev_arbitrage` | 1 | 큐레이션 |

겹치는 케이스 있음 (예: README의 sandwich victim은 missing_slippage이기도 해서 양쪽에 들어감). 그래서 합계 131이 단순 합보다 좀 적음.

## 재현 방법

```bash
# 1. 정상 + 자동 이상 수집 (Ethereum 메인넷)
RPC_URL=<your_rpc> \
  NORMAL_TARGET=50 ABNORMAL_TARGET=50 MISSING_SLIPPAGE_TARGET=3 \
  npx hardhat run scripts/collect-samples.ts

# 2. 큐레이션 후보를 fixtures/samples/abnormal-candidates.json에 추가하고 검증
RPC_URL=<your_rpc> npx hardhat run scripts/verify-samples.ts

# 3. 자동 + 큐레이션 합치기
npx hardhat run scripts/aggregate-samples.ts
```

다른 EVM 체인(Base/Arbitrum/Optimism 등)으로 가려면 `RPC_URL` + `CHAIN_LABEL` 환경변수만 바꾸면 됨. 스크립트 자체는 체인 가정 없음.


## 큐레이션 출처

해킹 사고 분석:
- Cyfrin / BlockSec — Euler Finance (2023-03)
- Immunefi / Merkle Science — Beanstalk Farms (2022-04)
- Steve Ng / Hacken — SushiSwap RouteProcessor2 (2023-04)
- Immunefi — Nomad bridge (2022-08)
- LlamaRisk HackMD — Curve Vyper reentrancy (2023-07)
- Halborn — Inverse Finance (2022-06)
- BlockSec / SlowMist / KyberSwap blog — KyberSwap Elastic (2023-11)
- Etherscan tx 직접 확인 — Cream Finance (2021-10), Conic Finance (2023-07)

기타:
- cmichel.io — BadgerDigg sandwich victim
- README PROPOSAL — USDC/USDT 97.6% 손실 예시
- Etherscan Information Center — MEV arbitrage 예시
- Etherscan phishing 라벨 — Angel Drainer 인출

## 다음 단계 제안

이 샘플들을 실제 파이프라인에 돌려서:
1. 정상 150개 → LLM 출력이 전부 `risk_level: low`로 나오는지 (false positive 측정)
2. 이상 131개 → 카테고리별 LLM 판정 분포 확인 (특히 phishing/hack은 룰 시그널 없으니 LLM이 어떻게 다루는지)
3. 통과/실패 케이스 보고 시스템 프롬프트 다듬거나 퓨샷 추가

응답 시간 늘리지 않으려면 파이프라인 자체는 안 건드리고 프롬프트/퓨샷만 깎는 방향으로.
