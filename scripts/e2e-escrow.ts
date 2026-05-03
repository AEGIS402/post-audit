import { config as loadEnv } from "dotenv";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { network } from "hardhat";
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
import { buildAuditPayload } from "../src/payload.js";
import { parsePriceOverrides } from "../src/prices.js";
import { collectRawRpc, type JsonRpcProviderLike } from "../src/rpc.js";
import { runLlmAudit } from "../src/llm.js";
import type { AuditOutput } from "../src/types.js";
import { requireEnv } from "../src/utils.js";

loadEnv({ quiet: true });

const DEPLOYMENT_PATH = resolve("escrow-hook/deployments/sepolia-demo.json");
const RESULT_PATH = resolve("deployments/e2e-escrow-result.json");

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
  "function setAuditor(address newAuditor)",
  "function auditor() view returns (address)",
  "event EscrowRegistered(bytes32 indexed escrowId,address indexed subject,address indexed beneficiary,bytes32 policyHash)",
];

const POOL_SWAP_TEST_ABI = [
  "function swap(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,tuple(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params,tuple(bool takeClaims,bool settleUsingBurn) testSettings,bytes hookData) payable returns (int256)",
];

interface Deployment {
  contracts: {
    usdt: string;
    aegis: string;
    insurancePool: string;
    vault: string;
    hook: string;
    adapter: string;
  };
  officialUniswapV4: {
    poolManager: string;
    poolSwapTest: string;
    poolModifyLiquidityTest: string;
  };
  initialConfig: {
    finalOwner: string;
    initialAuditor: string;
  };
}

interface PoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

type AnyContract = Contract & Record<string, any>;

interface Ctx {
  provider: JsonRpcProviderLike;
  owner: BaseWallet;
  auditor: BaseWallet;
  user: BaseWallet;
  attacker: BaseWallet;
  usdt: AnyContract;
  aegis: AnyContract;
  vault: AnyContract;
  adapter: AnyContract;
  poolSwapTest: AnyContract;
  key: PoolKey;
  usdtIsZero: boolean;
  amountIn: bigint;
  expectedOutput: bigint;
  insurancePool: string;
}

function severityToAction(severity: string): typeof AUDIT_ACTION_RELEASE | typeof AUDIT_ACTION_BLOCK_AND_CLAIM {
  if (severity === "high" || severity === "critical") {
    return AUDIT_ACTION_BLOCK_AND_CLAIM;
  }
  if (severity === "medium") {
    process.stderr.write(`[severity=medium] auto-RELEASE for demo; production should require human review\n`);
  }
  return AUDIT_ACTION_RELEASE;
}

function loadDeployment(): Deployment {
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
}

function buildPoolKey(deployment: Deployment): { key: PoolKey; usdtIsZero: boolean } {
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
  const tx = await funder.sendTransaction({ to: recipient, value: amount });
  await tx.wait();
}

async function runAudit(provider: JsonRpcProviderLike, txHash: string, subject: string): Promise<AuditOutput> {
  const rawRpc = await collectRawRpc(provider, txHash, subject);
  const payload = buildAuditPayload(rawRpc, { priceOverrides: parsePriceOverrides() });
  return runLlmAudit(payload);
}

function decodeEscrowId(
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string> }> },
  vaultAddress: string,
): string | null {
  const topic = id("EscrowRegistered(bytes32,address,address,bytes32)");
  const lower = vaultAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === lower && log.topics[0] === topic) {
      return log.topics[1];
    }
  }
  return null;
}

async function plainSwap(
  ctx: Ctx,
  trader: BaseWallet,
  zeroForOne: boolean,
  amountIn: bigint,
  sqrtPriceLimit: bigint,
): Promise<void> {
  const swapper = ctx.poolSwapTest.connect(trader) as AnyContract;
  const tx = await swapper.swap(
    ctx.key,
    { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: sqrtPriceLimit },
    { takeClaims: false, settleUsingBurn: false },
    "0x",
    { gasLimit: 4_000_000 },
  );
  await tx.wait();
}

async function ensureUserUsdtAndApproval(ctx: Ctx, who: BaseWallet, amount: bigint, spender: string): Promise<void> {
  const usdtAsWho = ctx.usdt.connect(who) as AnyContract;
  await (await usdtAsWho.mint(who.address, amount)).wait();
  await (await usdtAsWho.approve(spender, MAX_UINT256)).wait();
}

interface ScenarioOutput {
  label: string;
  tradeId: string;
  swapTxHash: string;
  decisionTxHash: string;
  audit: AuditOutput;
  chosenAction: "RELEASE" | "BLOCK_AND_CLAIM";
  reasonCode: string;
  finalEscrowState: string;
  pendingOutputAegis: string;
  userAegisAfter: string;
  userUsdtAfter: string;
  insuranceAegisAfter: string;
}

async function runScenario(ctx: Ctx, label: "normal" | "sandwich"): Promise<ScenarioOutput> {
  console.log(`\n=== scenario: ${label} ===`);
  const tradeId = id(`e2e-escrow-${label}-${Date.now()}`);
  const usdtToAegisLimit = ctx.usdtIsZero ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
  const aegisToUsdtLimit = ctx.usdtIsZero ? MAX_PRICE_LIMIT : MIN_PRICE_LIMIT;
  const reasonCode = label === "normal" ? "CLEAN" : "SANDWICH";

  await ensureUserUsdtAndApproval(ctx, ctx.user, ctx.amountIn * 100n, ctx.adapter.target as string);

  let attackerBackRunAegis = 0n;
  if (label === "sandwich") {
    const attackAmount = parseEther(process.env.E2E_ATTACK_AMOUNT ?? "500000");
    console.log(`front-run: attacker swaps ${formatEther(attackAmount)} USDT -> AEGIS`);
    await ensureUserUsdtAndApproval(ctx, ctx.attacker, attackAmount, ctx.poolSwapTest.target as string);
    const aegisAsAttacker = ctx.aegis.connect(ctx.attacker) as AnyContract;
    await (await aegisAsAttacker.approve(ctx.poolSwapTest.target, MAX_UINT256)).wait();
    const aegisBefore: bigint = await ctx.aegis.balanceOf(ctx.attacker.address);
    await plainSwap(ctx, ctx.attacker, ctx.usdtIsZero, attackAmount, usdtToAegisLimit);
    const aegisAfter: bigint = await ctx.aegis.balanceOf(ctx.attacker.address);
    attackerBackRunAegis = aegisAfter - aegisBefore;
    console.log(`front-run filled: attacker received ${formatEther(attackerBackRunAegis)} AEGIS`);
  }

  const adapterAsUser = ctx.adapter.connect(ctx.user) as AnyContract;
  const swapTx = await adapterAsUser.protectedExactInputSingle(
    {
      key: ctx.key,
      zeroForOne: ctx.usdtIsZero,
      amountIn: ctx.amountIn,
      expectedOutput: ctx.expectedOutput,
      sqrtPriceLimitX96: usdtToAegisLimit,
      tradeId,
      settlementRecipient: ctx.user.address,
    },
    { gasLimit: 4_000_000 },
  );
  const swapReceipt = await swapTx.wait();
  console.log(`victim swap tx: ${swapReceipt.hash}`);

  if (label === "sandwich" && attackerBackRunAegis > 0n) {
    console.log(`back-run: attacker swaps ${formatEther(attackerBackRunAegis)} AEGIS -> USDT`);
    await plainSwap(ctx, ctx.attacker, !ctx.usdtIsZero, attackerBackRunAegis, aegisToUsdtLimit);
  }

  const escrowIdFromLog = decodeEscrowId(swapReceipt, ctx.vault.target as string);
  if (escrowIdFromLog === null || escrowIdFromLog.toLowerCase() !== tradeId.toLowerCase()) {
    throw new Error(`EscrowRegistered missing or escrowId mismatch (log=${escrowIdFromLog}, tradeId=${tradeId})`);
  }
  const pending = await ctx.vault.escrows(tradeId);
  console.log(`escrow Pending: state=${pending.state} outputAmount=${formatEther(pending.outputAmount)} AEGIS`);

  console.log(`post-audit: tx=${swapReceipt.hash} subject=${ctx.user.address}`);
  const audit = await runAudit(ctx.provider, swapReceipt.hash, ctx.user.address);
  console.log(
    `audit: severity=${audit.overall_severity} score=${audit.overall_risk_score} summary=${audit.overall_summary.slice(0, 140)}`,
  );

  const action = severityToAction(audit.overall_severity);
  const reason = encodeBytes32String(reasonCode);
  const evidenceHash = keccak256(toUtf8Bytes(JSON.stringify(audit)));

  const vaultAsAuditor = ctx.vault.connect(ctx.auditor) as AnyContract;
  const decisionTx = await vaultAsAuditor.executeAuditDecision(
    { escrowId: tradeId, action, reason, evidenceHash, actionData: "0x" },
    { gasLimit: 1_000_000 },
  );
  const decisionReceipt = await decisionTx.wait();
  const chosenAction = action === AUDIT_ACTION_RELEASE ? "RELEASE" : "BLOCK_AND_CLAIM";
  console.log(`executeAuditDecision tx: ${decisionReceipt.hash} action=${chosenAction}`);

  const finalEscrow = await ctx.vault.escrows(tradeId);
  const userAegis: bigint = await ctx.aegis.balanceOf(ctx.user.address);
  const userUsdt: bigint = await ctx.usdt.balanceOf(ctx.user.address);
  const insuranceAegis: bigint = await ctx.aegis.balanceOf(ctx.insurancePool);

  return {
    label,
    tradeId,
    swapTxHash: swapReceipt.hash,
    decisionTxHash: decisionReceipt.hash,
    audit,
    chosenAction,
    reasonCode,
    finalEscrowState: finalEscrow.state.toString(),
    pendingOutputAegis: formatEther(pending.outputAmount),
    userAegisAfter: formatEther(userAegis),
    userUsdtAfter: formatEther(userUsdt),
    insuranceAegisAfter: formatEther(insuranceAegis),
  };
}

async function main(): Promise<void> {
  const deployment = loadDeployment();
  const { ethers } = await network.create();
  const provider = ethers.provider as unknown as JsonRpcProviderLike;
  const networkInfo = await ethers.provider.getNetwork();

  const ownerKey = requireEnv("PRIVATE_KEY");
  const owner = new Wallet(ownerKey, ethers.provider);
  if (owner.address.toLowerCase() !== deployment.initialConfig.finalOwner.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY signer ${owner.address} does not match deployment owner ${deployment.initialConfig.finalOwner}; the owner key is required to setAuditor on the deployed vault`,
    );
  }

  const auditor = Wallet.createRandom().connect(ethers.provider);
  const user = Wallet.createRandom().connect(ethers.provider);
  const attacker = Wallet.createRandom().connect(ethers.provider);
  const fundAmount = parseEther(process.env.E2E_WALLET_FUND_ETH ?? "0.05");

  console.log(`network chainId=${networkInfo.chainId} owner=${owner.address}`);
  console.log(`generated auditor=${auditor.address} user=${user.address} attacker=${attacker.address}`);
  console.log(`funding each ephemeral wallet with ${formatEther(fundAmount)} ETH`);

  await fundWallet(owner, auditor.address, fundAmount);
  await fundWallet(owner, user.address, fundAmount);
  await fundWallet(owner, attacker.address, fundAmount);

  const usdt = new Contract(deployment.contracts.usdt, ERC20_ABI, ethers.provider) as AnyContract;
  const aegis = new Contract(deployment.contracts.aegis, ERC20_ABI, ethers.provider) as AnyContract;
  const adapter = new Contract(deployment.contracts.adapter, ADAPTER_ABI, ethers.provider) as AnyContract;
  const vault = new Contract(deployment.contracts.vault, VAULT_ABI, ethers.provider) as AnyContract;
  const poolSwapTest = new Contract(
    deployment.officialUniswapV4.poolSwapTest,
    POOL_SWAP_TEST_ABI,
    ethers.provider,
  ) as AnyContract;

  const vaultAsOwner = vault.connect(owner) as AnyContract;
  const setAuditorTx = await vaultAsOwner.setAuditor(auditor.address, { gasLimit: 200_000 });
  await setAuditorTx.wait();
  const currentAuditor = await vault.auditor();
  if (currentAuditor.toLowerCase() !== auditor.address.toLowerCase()) {
    throw new Error(`vault auditor not updated to ephemeral key; got ${currentAuditor}`);
  }

  const { key, usdtIsZero } = buildPoolKey(deployment);
  const ctx: Ctx = {
    provider,
    owner,
    auditor,
    user,
    attacker,
    usdt,
    aegis,
    vault,
    adapter,
    poolSwapTest,
    key,
    usdtIsZero,
    amountIn: parseEther(process.env.E2E_AMOUNT_IN ?? "100"),
    expectedOutput: parseEther(process.env.E2E_EXPECTED_OUTPUT ?? "99"),
    insurancePool: deployment.contracts.insurancePool,
  };

  const normalCase = await runScenario(ctx, "normal");
  const sandwichCase = await runScenario(ctx, "sandwich");

  const result = {
    note:
      "End-to-end pipeline: victim swap -> EscrowRegistered -> post-audit (RPC + LLM, ProtectedSwapEscrowed decoded with output_amount vs expected_output) -> protected_swap_output_shortfall rule signal -> severity threshold mapping -> AuditDecision -> insurance settlement. Normal swap should land in info/RELEASE; sandwich victim swap should land in high|critical/BLOCK_AND_CLAIM with insurance pool refunding the user's input principal.",
    network: { chainId: networkInfo.chainId.toString() },
    deployment: deployment.contracts,
    actors: { owner: owner.address, auditor: auditor.address, user: user.address, attacker: attacker.address },
    severityToActionPolicy: {
      info: "RELEASE",
      low: "RELEASE",
      medium: "RELEASE (with stderr warning; prod should require human review)",
      high: "BLOCK_AND_CLAIM",
      critical: "BLOCK_AND_CLAIM",
    },
    normalCase,
    sandwichCase,
  };

  mkdirSync(dirname(RESULT_PATH), { recursive: true });
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nresult written to ${RESULT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
