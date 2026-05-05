import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { expect } from "chai";
import { parseUnits } from "ethers";
import { network } from "hardhat";
import { createAuditApiServer } from "../src/api.js";
import type { AuditOutput, AuditPayload } from "../src/types.js";

describe("post-audit API", function () {
  it("audits a transaction with an explicit subject address", async function () {
    const { ethers } = await network.create();
    const [subject, recipient] = await ethers.getSigners();
    const usdc = (await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])) as any;
    await usdc.waitForDeployment();
    await (await usdc.mint(subject.address, parseUnits("1000", 6))).wait();

    const tx = await usdc.connect(subject).transfer(recipient.address, parseUnits("100", 6));
    await tx.wait();

    let capturedPayload: AuditPayload | undefined;
    let capturedForceRefresh: boolean | undefined;
    const server = createAuditApiServer({
      provider: ethers.provider,
      priceOverrides: {
        [await usdc.getAddress()]: "1",
      },
      auditRunner: async (payload, context) => {
        capturedPayload = payload;
        capturedForceRefresh = context?.forceRefresh;
        return makeAuditOutput(payload);
      },
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/audit/subject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_hash: tx.hash,
          subject_address: subject.address,
          force_refresh: true,
        }),
      });
      const json = (await response.json()) as AuditOutput;

      expect(response.status).to.equal(200);
      expect(json.model).to.equal("test-model");
      expect(json.score_version).to.equal("risk-v1");
      expect(json.overall_severity).to.equal("info");
      expect(json.vulnerabilities).to.deep.equal([]);
      expect(capturedPayload?.subject_address).to.equal(subject.address);
      expect(capturedForceRefresh).to.equal(true);
      expect(capturedPayload?.asset_flows[0]).to.include({
        asset: "USDC",
        direction: "out",
        amount: "100",
      });
    } finally {
      await close(server);
    }
  });

  it("audits a transaction using tx.from as the subject address", async function () {
    const { ethers } = await network.create();
    const [subject, recipient] = await ethers.getSigners();
    const usdc = (await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])) as any;
    await usdc.waitForDeployment();
    await (await usdc.mint(subject.address, parseUnits("1000", 6))).wait();

    const tx = await usdc.connect(subject).transfer(recipient.address, parseUnits("42", 6));
    await tx.wait();

    let capturedPayload: AuditPayload | undefined;
    const server = createAuditApiServer({
      provider: ethers.provider,
      priceOverrides: {
        [await usdc.getAddress()]: "1",
      },
      auditRunner: async (payload) => {
        capturedPayload = payload;
        return makeAuditOutput(payload);
      },
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/audit/from-tx`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_hash: tx.hash,
        }),
      });
      const json = (await response.json()) as AuditOutput;

      expect(response.status).to.equal(200);
      expect(json.model).to.equal("test-model");
      expect(json.score_version).to.equal("risk-v1");
      expect(json.overall_severity).to.equal("info");
      expect(json.vulnerabilities).to.deep.equal([]);
      expect(capturedPayload?.subject_address).to.equal(subject.address);
      expect(capturedPayload?.asset_flows[0]).to.include({
        asset: "USDC",
        direction: "out",
        amount: "42",
      });
    } finally {
      await close(server);
    }
  });

  it("returns JSON errors for invalid API requests", async function () {
    const { ethers } = await network.create();
    const server = createAuditApiServer({
      provider: ethers.provider,
      auditRunner: async (payload) => makeAuditOutput(payload),
    });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/audit/subject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_hash: "0x1234",
          subject_address: "not-an-address",
        }),
      });
      const json = (await response.json()) as { error: { message: string } };

      expect(response.status).to.equal(400);
      expect(json.error.message).to.equal("subject_address must be a valid EVM address");
    } finally {
      await close(server);
    }
  });
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function makeAuditOutput(payload: AuditPayload): AuditOutput {
  return {
    model: "test-model",
    score_version: "risk-v1",
    overall_risk_score: payload.rule_signals.some((signal) => signal.severity_hint === "critical") ? 90 : 5,
    overall_severity: payload.rule_signals.some((signal) => signal.severity_hint === "critical") ? "critical" : "info",
    overall_summary: "API test audit result.",
    vulnerabilities: [],
  };
}
