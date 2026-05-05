import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";
import { runLlmAudit } from "../src/llm.js";
import type { AuditOutput, AuditPayload } from "../src/types.js";

describe("LLM response cache", function () {
  const originalFetch = globalThis.fetch;
  let cacheDir: string;

  beforeEach(async function () {
    cacheDir = await mkdtemp(join(tmpdir(), "post-audit-llm-cache-"));
  });

  afterEach(async function () {
    globalThis.fetch = originalFetch;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("reuses the cached response for an identical LLM request", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return llmResponse(makeRawAuditOutput(5, `Network response ${calls}.`));
    }) as typeof fetch;

    const first = await runLlmAudit(makePayload(), cacheOptions());
    const second = await runLlmAudit(makePayload(), cacheOptions());

    expect(calls).to.equal(1);
    expect(second).to.deep.equal(first);
    expect(second.overall_summary).to.equal("Network response 1.");
  });

  it("refreshes and overwrites the cached response when forced", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const score = calls === 1 ? 5 : 35;
      return llmResponse(makeRawAuditOutput(score, `Network response ${calls}.`));
    }) as typeof fetch;

    const first = await runLlmAudit(makePayload(), cacheOptions());
    const refreshed = await runLlmAudit(makePayload(), {
      ...cacheOptions(),
      forceRefresh: true,
    });
    const cachedRefresh = await runLlmAudit(makePayload(), cacheOptions());

    expect(calls).to.equal(2);
    expect(first.overall_risk_score).to.equal(5);
    expect(refreshed.overall_risk_score).to.equal(35);
    expect(cachedRefresh).to.deep.equal(refreshed);
  });

  function cacheOptions() {
    return {
      baseUrl: "http://llm.test/v1",
      model: "test-model",
      responseCacheDir: cacheDir,
      cacheLog: false,
    };
  }
});

function makePayload(): AuditPayload {
  return {
    task: "post_transaction_audit",
    chain_id: 1,
    tx_hash: "0xabc",
    subject_address: "0x0000000000000000000000000000000000000001",
    raw_evidence: [],
    token_metadata: [],
    price_context: [],
    execution: {
      status: "success",
      evidence_refs: [],
    },
    decoded_events: [],
    asset_flows: [],
    approval_changes: [],
    rule_signals: [],
    known_limitations: [],
  };
}

function makeRawAuditOutput(score: number, summary: string): AuditOutput {
  return {
    model: "ignored-by-normalization",
    score_version: "risk-v1",
    overall_risk_score: score,
    overall_severity: "info",
    overall_summary: summary,
    vulnerabilities: [],
  };
}

function llmResponse(output: AuditOutput): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(output),
          },
        },
      ],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}
