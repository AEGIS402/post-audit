import { readFile } from "node:fs/promises";
import { expect } from "chai";
import { MaxUint256, parseUnits } from "ethers";
import { network } from "hardhat";
import { buildAuditPayload, collectPayloadReferenceIds } from "../src/payload.js";
import { collectRawRpc } from "../src/rpc.js";
import { parseAndValidateAuditOutput } from "../src/schemas.js";
import type { AuditPayload, RawRpcInput } from "../src/types.js";

describe("post-audit payload builder", function () {
  it("detects a simple ERC20 transfer from raw RPC evidence", async function () {
    const { ethers } = await network.create();
    const [subject, recipient] = await ethers.getSigners();
    const usdc = (await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])) as any;
    await usdc.waitForDeployment();
    await (await usdc.mint(subject.address, parseUnits("1000", 6))).wait();

    const tx = await usdc.connect(subject).transfer(recipient.address, parseUnits("100", 6));
    await tx.wait();
    const tokenAddress = await usdc.getAddress();
    const raw = await collectRawRpc(ethers.provider, tx.hash, subject.address);
    const payload = buildAuditPayload(raw, {
      priceOverrides: {
        [tokenAddress]: "1",
      },
    });

    expect(payload.execution.status).to.equal("success");
    expect(payload.decoded_call?.function).to.equal("transfer");
    expect(payload.asset_flows).to.have.length(1);
    expect(payload.asset_flows[0]).to.include({
      asset: "USDC",
      direction: "out",
      amount: "100",
      counterparty: recipient.address,
    });
    expect(payload.rule_signals.some((signal) => signal.type === "simple_erc20_transfer")).to.equal(true);
    expectEveryEvidenceRefIsResolvable(payload);
  });

  it("detects unlimited ERC20 approvals", async function () {
    const { ethers } = await network.create();
    const [subject, spender] = await ethers.getSigners();
    const usdc = (await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])) as any;
    await usdc.waitForDeployment();

    const tx = await usdc.connect(subject).approve(spender.address, MaxUint256);
    await tx.wait();
    const raw = await collectRawRpc(ethers.provider, tx.hash, subject.address);
    const payload = buildAuditPayload(raw, {
      priceOverrides: {
        [await usdc.getAddress()]: "1",
      },
    });

    expect(payload.approval_changes).to.have.length(1);
    expect(payload.approval_changes[0]).to.include({
      spender: spender.address,
      is_unlimited: true,
    });
    expect(payload.rule_signals.some((signal) => signal.type === "unlimited_erc20_approval")).to.equal(true);
    expectEveryEvidenceRefIsResolvable(payload);
  });

  it("detects extreme stablecoin swap imbalance and zero slippage protection", async function () {
    const { ethers } = await network.create();
    const [subject] = await ethers.getSigners();
    const usdc = (await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])) as any;
    const usdt = (await ethers.deployContract("MockERC20", ["Tether USD", "USDT", 6])) as any;
    const router = (await ethers.deployContract("MockSwapRouter")) as any;
    await usdc.waitForDeployment();
    await usdt.waitForDeployment();
    await router.waitForDeployment();

    const usdcAddress = await usdc.getAddress();
    const usdtAddress = await usdt.getAddress();
    const routerAddress = await router.getAddress();
    const amountIn = parseUnits("220806.389669", 6);
    const amountOut = parseUnits("5272.998058", 6);

    await (await usdc.mint(subject.address, amountIn)).wait();
    await (await usdt.mint(routerAddress, amountOut)).wait();
    await (await router.setQuote(usdcAddress, usdtAddress, amountOut)).wait();
    await (await usdc.connect(subject).approve(routerAddress, amountIn)).wait();

    const tx = await router.connect(subject).exactInputSingle({
      tokenIn: usdcAddress,
      tokenOut: usdtAddress,
      fee: 500,
      recipient: subject.address,
      deadline: 0,
      amountIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    await tx.wait();
    const raw = await collectRawRpc(ethers.provider, tx.hash, subject.address);
    const payload = buildAuditPayload(raw, {
      priceOverrides: {
        [usdcAddress]: "1",
        [usdtAddress]: "1",
      },
    });

    expect(payload.decoded_call?.function).to.equal("exactInputSingle");
    expect(payload.asset_flows.map((flow) => `${flow.direction}:${flow.asset}:${flow.amount}`)).to.include.members([
      "out:USDC:220806.389669",
      "in:USDT:5272.998058",
    ]);
    expect(payload.rule_signals.some((signal) => signal.type === "extreme_value_imbalance")).to.equal(true);
    expect(payload.rule_signals.some((signal) => signal.type === "missing_slippage_protection")).to.equal(true);
    expectEveryEvidenceRefIsResolvable(payload);
  });

  it("validates LLM output schema and prunes findings with invalid evidence refs", async function () {
    const fixture = JSON.parse(await readFile("fixtures/simple-transfer.json", "utf8")) as RawRpcInput;
    const payload = buildAuditPayload(fixture);
    const validOutput = {
      risk_level: "low",
      risk_score: 12,
      one_line_summary: "This is a simple 100 USDC transfer.",
      executive_summary: "The subject address sent 100 USDC to the recipient.",
      findings: [
        {
          type: "simple_erc20_transfer",
          severity: "info",
          title: "Normal ERC20 transfer",
          description: "The subject address sent 100 USDC.",
          evidence_refs: ["flow#0"],
          confidence: 0.9,
        },
        {
          type: "unsupported_claim",
          severity: "high",
          title: "Unsupported claim",
          description: "This finding references an evidence ref that does not exist.",
          evidence_refs: ["missing#0"],
          confidence: 0.5,
        },
      ],
      benign_explanations_to_check: [],
      missing_evidence: ["Debug trace was not provided."],
      recommended_actions: ["Confirm that the recipient address was intended."],
      final_assessment: "The provided evidence supports a low-risk assessment.",
    };

    const parsed = parseAndValidateAuditOutput(validOutput, payload);
    expect(parsed.findings).to.have.length(1);
    expect(parsed.findings[0].evidence_refs).to.deep.equal(["flow#0"]);

    expect(() =>
      parseAndValidateAuditOutput(
        {
          ...validOutput,
          risk_score: 101,
        },
        payload,
      ),
    ).to.throw();
  });

  it("keeps all generated payload evidence refs resolvable for JSON fixtures", async function () {
    const fixture = JSON.parse(await readFile("fixtures/simple-transfer.json", "utf8")) as RawRpcInput;
    const payload = buildAuditPayload(fixture);

    expect(payload.raw_evidence.map((item) => item.evidence_id)).to.include.members([
      "tx.raw",
      "tx.raw.input",
      "receipt.raw",
      "receipt.raw.logs[0]",
    ]);
    expect(payload.rule_signals.some((signal) => signal.type === "simple_erc20_transfer")).to.equal(true);
    expectEveryEvidenceRefIsResolvable(payload);
  });
});

function expectEveryEvidenceRefIsResolvable(payload: AuditPayload): void {
  const refs = collectPayloadReferenceIds(payload);
  const nestedRefs = [
    ...payload.execution.evidence_refs,
    ...(payload.decoded_call?.evidence_refs ?? []),
    ...payload.decoded_events.flatMap((event) => event.evidence_refs),
    ...payload.asset_flows.flatMap((flow) => flow.evidence_refs),
    ...payload.approval_changes.flatMap((approval) => approval.evidence_refs),
    ...payload.rule_signals.flatMap((signal) => signal.evidence_refs),
  ];

  for (const ref of nestedRefs) {
    expect(refs.has(ref), ref).to.equal(true);
  }
}
