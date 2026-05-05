import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type BaseWallet,
  Contract,
  Wallet,
  encodeBytes32String,
  formatEther,
  id,
  keccak256,
  parseEther,
  toUtf8Bytes,
} from "ethers";
import { buildAuditPayload } from "./payload.js";
import { parsePriceOverrides } from "./prices.js";
import { collectRawRpc, type JsonRpcProviderLike } from "./rpc.js";
import { runLlmAudit } from "./llm.js";
import type { AuditOutput } from "./types.js";

const DEPLOYMENT_PATH = resolve("escrow-hook/deployments/sepolia-demo.json");
const SEPOLIA_CHAIN_ID = 11155111n;

const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_PRICE_LIMIT = 4295128740n;
const MAX_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341n;
const AUDIT_ACTION_RELEASE = 0;
const AUDIT_ACTION_BLOCK_AND_CLAIM = 1;

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const ADAPTER_ABI = [
  "function protectedExactInputSingle((tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint128 amountIn,uint256 expectedOutput,uint160 sqrtPriceLimitX96,bytes32 tradeId,address settlementRecipient)) returns (int256)",
];

const VAULT_ABI = [
  "function executeAuditDecision((bytes32 escrowId,uint8 action,bytes32 reason,bytes32 evidenceHash,bytes actionData)) returns (bytes4)",
  "function escrows(bytes32) view returns (uint8 state,address user,address inputToken,uint256 inputAmount,address outputToken,uint256 outputAmount,address settlementRecipient,uint256 expectedOutput)",
  "function auditor() view returns (address)",
  "event EscrowRegistered(bytes32 indexed escrowId,address indexed subject,address indexed beneficiary,bytes32 policyHash)",
];

const POOL_SWAP_TEST_ABI = [
  "function swap(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,tuple(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,tuple(bool takeClaims,bool settleUsingBurn) testSettings,bytes hookData) payable returns (int256)",
];

interface DeploymentJson {
  contracts: {
    usdt: string;
    aegis: string;
    insurancePool: string;
    vault: string;
    hook: string;
    adapter: string;
  };
  officialUniswapV4: { poolSwapTest: string; [k: string]: unknown };
  initialConfig: { finalOwner: string };
}

interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

type AnyContract = Contract & Record<string, any>;

export interface ScenarioOptions {
  amountIn?: string;
  expectedOutput?: string;
  walletFundEth?: string;
  attackAmount?: string;
}

export interface ScenarioResult {
  scenario: "normal" | "sandwich";
  explainer: string;
  narration: string[];
  network: { chainId: string };
  deployment: DeploymentJson["contracts"];
  actors: { auditor: string; user: string; attacker: string | null };
  tradeId: string;
  swapTxHash: string;
  decisionTxHash: string;
  audit: AuditOutput;
  chosenAction: "RELEASE" | "BLOCK_AND_CLAIM";
  reasonCode: string;
  pendingEscrow: {
    state: string;
    inputAmount: string;
    outputAmount: string;
    expectedOutput: string;
  };
  finalEscrow: { state: string; outputAmount: string };
  balances: {
    userUsdt: string;
    userAegis: string;
    insuranceUsdt: string;
    insuranceAegis: string;
  };
  etherscan: { swap: string; decision: string };
  elapsedMs: number;
}

let scenarioMutex: Promise<unknown> = Promise.resolve();
function withScenarioLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = scenarioMutex.then(() => fn(), () => fn());
  scenarioMutex = next.then(() => undefined, () => undefined);
  return next;
}

function loadDeployment(): DeploymentJson {
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as DeploymentJson;
}

function buildPoolKey(deployment: DeploymentJson): { key: PoolKey; usdtIsZero: boolean } {
  const usdtIsZero = BigInt(deployment.contracts.usdt) < BigInt(deployment.contracts.aegis);
  const [currency0, currency1] = usdtIsZero
    ? [deployment.contracts.usdt, deployment.contracts.aegis]
    : [deployment.contracts.aegis, deployment.contracts.usdt];
  return {
    key: { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: deployment.contracts.hook },
    usdtIsZero,
  };
}

async function fundWallet(funder: BaseWallet, recipient: string, amount: bigint): Promise<void> {
  await (await funder.sendTransaction({ to: recipient, value: amount })).wait();
}

function decodeEscrowId(
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string> }> },
  vault: string,
): string | null {
  const topic = id("EscrowRegistered(bytes32,address,address,bytes32)");
  const lower = vault.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === lower && log.topics[0] === topic) {
      return log.topics[1];
    }
  }
  return null;
}

function severityToAction(severity: string): typeof AUDIT_ACTION_RELEASE | typeof AUDIT_ACTION_BLOCK_AND_CLAIM {
  return severity === "high" || severity === "critical" ? AUDIT_ACTION_BLOCK_AND_CLAIM : AUDIT_ACTION_RELEASE;
}

async function ensureUserUsdtAndApproval(
  usdt: AnyContract,
  who: BaseWallet,
  amount: bigint,
  spender: string,
): Promise<void> {
  const usdtAsWho = usdt.connect(who) as AnyContract;
  await (await usdtAsWho.mint(who.address, amount)).wait();
  await (await usdtAsWho.approve(spender, MAX_UINT256)).wait();
}

async function plainSwap(
  poolSwapTest: AnyContract,
  trader: BaseWallet,
  key: PoolKey,
  zeroForOne: boolean,
  amountIn: bigint,
  sqrtPriceLimit: bigint,
): Promise<void> {
  const swapper = poolSwapTest.connect(trader) as AnyContract;
  const tx = await swapper.swap(
    key,
    { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: sqrtPriceLimit },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
    { gasLimit: 4_000_000 },
  );
  await tx.wait();
}

function buildExplainer(scenario: "normal" | "sandwich", r: Partial<ScenarioResult>): string {
  if (scenario === "normal") {
    return [
      `User swapped ${r.pendingEscrow?.inputAmount} USDT through protectedExactInputSingle and got ${r.pendingEscrow?.outputAmount} AEGIS escrowed (expected ${r.pendingEscrow?.expectedOutput}).`,
      `Post-audit returned severity=${r.audit?.overall_severity} (no risk signals fired), so the auditor RELEASEd the escrow.`,
      `User now holds ${r.balances?.userAegis} AEGIS. Sunk cost = the 0.5% protection fee.`,
    ].join(" ");
  }
  return [
    `Attacker front-ran with a large USDT->AEGIS swap to dump the price.`,
    `User's protectedExactInputSingle then yielded only ${r.pendingEscrow?.outputAmount} AEGIS, way below the user-stated expectedOutput=${r.pendingEscrow?.expectedOutput}.`,
    `Attacker back-ran AEGIS->USDT to extract the spread.`,
    `Post-audit fired the protected_swap_output_shortfall rule signal at severity=${r.audit?.overall_severity}, so the auditor chose BLOCK_AND_CLAIM.`,
    `InsurancePool refunded the user's ${r.pendingEscrow?.inputAmount} USDT (minus the 0.5% protection fee paid up front), and the suspicious AEGIS in the vault was forwarded to InsurancePool.`,
  ].join(" ");
}

export async function runScenarioLive(args: {
  provider: JsonRpcProviderLike;
  ownerKey: string;
  traderKey: string;
  scenario: "normal" | "sandwich";
  options?: ScenarioOptions;
}): Promise<ScenarioResult> {
  return withScenarioLock(async () => {
    const start = Date.now();
    const narration: string[] = [];
    const log = (msg: string) => {
      narration.push(msg);
      console.log(`[scenario:${args.scenario}] ${msg}`);
    };

    const deployment = loadDeployment();
    const ethersProvider = args.provider as unknown as any;

    const networkInfo = await ethersProvider.getNetwork();
    const chainId = BigInt(networkInfo.chainId.toString());
    if (chainId !== SEPOLIA_CHAIN_ID) {
      throw new Error(
        `scenario endpoints only work on Sepolia (chainId=${SEPOLIA_CHAIN_ID}); current=${chainId.toString()}`,
      );
    }

    const auditor: BaseWallet = new Wallet(args.ownerKey, ethersProvider);
    const trader: BaseWallet = new Wallet(args.traderKey, ethersProvider);
    if (auditor.address.toLowerCase() === trader.address.toLowerCase()) {
      throw new Error("trader key must differ from PRIVATE_KEY (auditor)");
    }
    const user: BaseWallet = trader;
    const attacker: BaseWallet | null = args.scenario === "sandwich" ? trader : null;

    const usdt = new Contract(deployment.contracts.usdt, ERC20_ABI, ethersProvider) as AnyContract;
    const aegis = new Contract(deployment.contracts.aegis, ERC20_ABI, ethersProvider) as AnyContract;
    const adapter = new Contract(deployment.contracts.adapter, ADAPTER_ABI, ethersProvider) as AnyContract;
    const vault = new Contract(deployment.contracts.vault, VAULT_ABI, ethersProvider) as AnyContract;
    const poolSwapTest = new Contract(
      deployment.officialUniswapV4.poolSwapTest,
      POOL_SWAP_TEST_ABI,
      ethersProvider,
    ) as AnyContract;

    const onChainAuditor: string = await vault.auditor();
    if (onChainAuditor.toLowerCase() !== auditor.address.toLowerCase()) {
      throw new Error(
        `vault.auditor=${onChainAuditor} but PRIVATE_KEY signer=${auditor.address}; cannot executeAuditDecision`,
      );
    }
    log(`vault.auditor matches PRIVATE_KEY signer (${auditor.address}). setAuditor not required.`);
    log(`trader=${trader.address} (signer for swap${attacker ? "/frontrun/backrun" : ""})`);

    const traderEth: bigint = await ethersProvider.getBalance(trader.address);
    log(`trader Sepolia ETH balance: ${formatEther(traderEth)}`);
    if (traderEth === 0n) {
      throw new Error(`trader ${trader.address} has 0 ETH on Sepolia; please fund it before calling this endpoint`);
    }

    const { key: poolKey, usdtIsZero } = buildPoolKey(deployment);
    const amountIn = parseEther(args.options?.amountIn ?? "100");
    const expectedOutput = parseEther(args.options?.expectedOutput ?? "99");
    const usdtToAegisLimit = usdtIsZero ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
    const aegisToUsdtLimit = usdtIsZero ? MAX_PRICE_LIMIT : MIN_PRICE_LIMIT;

    let attackerBackRunAegis = 0n;
    if (args.scenario === "sandwich" && attacker) {
      const attackAmount = parseEther(args.options?.attackAmount ?? "500000");
      log(`front-run: trader mints ${formatEther(attackAmount)} USDT, approves poolSwapTest, swaps USDT -> AEGIS`);
      await ensureUserUsdtAndApproval(usdt, attacker, attackAmount, poolSwapTest.target as string);
      const aegisAsAttacker = aegis.connect(attacker) as AnyContract;
      await (await aegisAsAttacker.approve(poolSwapTest.target, MAX_UINT256)).wait();
      const aegisBefore: bigint = await aegis.balanceOf(attacker.address);
      await plainSwap(poolSwapTest, attacker, poolKey, usdtIsZero, attackAmount, usdtToAegisLimit);
      const aegisAfter: bigint = await aegis.balanceOf(attacker.address);
      attackerBackRunAegis = aegisAfter - aegisBefore;
      log(`front-run filled: trader received ${formatEther(attackerBackRunAegis)} AEGIS`);
    }

    log(`mint ${formatEther(amountIn)} USDT for trader (as user), approve adapter`);
    await ensureUserUsdtAndApproval(usdt, user, amountIn * 100n, adapter.target as string);

    const tradeId = id(`api-scenario-${args.scenario}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
    const reasonCode = args.scenario === "normal" ? "CLEAN" : "SANDWICH";

    log(`victim swap: protectedExactInputSingle ${formatEther(amountIn)} USDT (expectedOutput=${formatEther(expectedOutput)} AEGIS)`);
    const adapterAsUser = adapter.connect(user) as AnyContract;
    const swapTx = await adapterAsUser.protectedExactInputSingle(
      {
        key: poolKey,
        zeroForOne: usdtIsZero,
        amountIn,
        expectedOutput,
        sqrtPriceLimitX96: usdtToAegisLimit,
        tradeId,
        settlementRecipient: user.address,
      },
      { gasLimit: 4_000_000 },
    );
    const swapReceipt = await swapTx.wait();
    log(`victim swap tx mined: ${swapReceipt.hash}`);

    if (args.scenario === "sandwich" && attacker && attackerBackRunAegis > 0n) {
      log(`back-run: attacker swaps ${formatEther(attackerBackRunAegis)} AEGIS -> USDT`);
      await plainSwap(poolSwapTest, attacker, poolKey, !usdtIsZero, attackerBackRunAegis, aegisToUsdtLimit);
    }

    const escrowIdFromLog = decodeEscrowId(swapReceipt, vault.target as string);
    if (escrowIdFromLog === null || escrowIdFromLog.toLowerCase() !== tradeId.toLowerCase()) {
      throw new Error(
        `EscrowRegistered missing or escrowId mismatch (log=${escrowIdFromLog}, tradeId=${tradeId})`,
      );
    }
    const pending = await vault.escrows(tradeId);
    log(`escrow Pending: state=${pending.state} outputAmount=${formatEther(pending.outputAmount)} AEGIS`);

    log(`post-audit: tx=${swapReceipt.hash} subject=${user.address}`);
    const rawRpc = await collectRawRpc(args.provider, swapReceipt.hash, user.address);
    const payload = buildAuditPayload(rawRpc, { priceOverrides: parsePriceOverrides() });
    const audit = await runLlmAudit(payload);
    log(`audit returned severity=${audit.overall_severity} score=${audit.overall_risk_score}`);

    const action = severityToAction(audit.overall_severity);
    const chosenAction = action === AUDIT_ACTION_RELEASE ? "RELEASE" : "BLOCK_AND_CLAIM";
    const reason = encodeBytes32String(reasonCode);
    const evidenceHash = keccak256(toUtf8Bytes(JSON.stringify(audit)));

    log(`executeAuditDecision: action=${chosenAction} reason=${reasonCode}`);
    const vaultAsAuditor = vault.connect(auditor) as AnyContract;
    const decisionTx = await vaultAsAuditor.executeAuditDecision(
      { escrowId: tradeId, action, reason, evidenceHash, actionData: "0x" },
      { gasLimit: 1_000_000 },
    );
    const decisionReceipt = await decisionTx.wait();
    log(`decision tx mined: ${decisionReceipt.hash}`);

    // RPC eventual-consistency: state and balances may lag the latest mined block
    // on shared gateways. Small wait + 1 extra confirmation read before reporting.
    await new Promise((r) => setTimeout(r, 2500));

    const finalEscrow = await vault.escrows(tradeId);
    const userAegisBal: bigint = await aegis.balanceOf(user.address);
    const userUsdtBal: bigint = await usdt.balanceOf(user.address);
    const insuranceUsdtBal: bigint = await usdt.balanceOf(deployment.contracts.insurancePool);
    const insuranceAegisBal: bigint = await aegis.balanceOf(deployment.contracts.insurancePool);

    const partial: Partial<ScenarioResult> = {
      pendingEscrow: {
        state: pending.state.toString(),
        inputAmount: formatEther(pending.inputAmount),
        outputAmount: formatEther(pending.outputAmount),
        expectedOutput: formatEther(pending.expectedOutput),
      },
      audit,
      balances: {
        userUsdt: formatEther(userUsdtBal),
        userAegis: formatEther(userAegisBal),
        insuranceUsdt: formatEther(insuranceUsdtBal),
        insuranceAegis: formatEther(insuranceAegisBal),
      },
    };

    return {
      scenario: args.scenario,
      explainer: buildExplainer(args.scenario, partial),
      narration,
      network: { chainId: chainId.toString() },
      deployment: deployment.contracts,
      actors: {
        auditor: auditor.address,
        user: user.address,
        attacker: attacker?.address ?? null,
      },
      tradeId,
      swapTxHash: swapReceipt.hash,
      decisionTxHash: decisionReceipt.hash,
      audit,
      chosenAction,
      reasonCode,
      pendingEscrow: partial.pendingEscrow!,
      finalEscrow: {
        state: finalEscrow.state.toString(),
        outputAmount: formatEther(finalEscrow.outputAmount),
      },
      balances: partial.balances!,
      etherscan: {
        swap: `https://sepolia.etherscan.io/tx/${swapReceipt.hash}`,
        decision: `https://sepolia.etherscan.io/tx/${decisionReceipt.hash}`,
      },
      elapsedMs: Date.now() - start,
    };
  });
}
