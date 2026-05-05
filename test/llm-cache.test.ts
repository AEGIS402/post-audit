import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "chai";
import { runLlmAudit } from "../src/llm.js";
import type { AuditOutput, AuditPayload } from "../src/types.js";

describe("LLM response cache", function () {
  const originalFetch = globalThis.fetch;
  const envKeys = [
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_BASE_URL",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_MAX_TOKENS_FIELD",
    "LLM_REASONING_EFFORT",
  ] as const;
  let cacheDir: string;
  let originalEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async function () {
    originalEnv = snapshotEnv(envKeys);
    clearEnv(envKeys);
    cacheDir = await mkdtemp(join(tmpdir(), "post-audit-llm-cache-"));
  });

  afterEach(async function () {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
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

  it("stores cached responses in a SQLite database using WAL mode", async function () {
    globalThis.fetch = (async () => llmResponse(makeRawAuditOutput(5, "Network response."))) as typeof fetch;

    await runLlmAudit(makePayload(), cacheOptions());

    withCacheDb((db) => {
      const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const count = db.prepare("SELECT COUNT(*) AS count FROM llm_response_cache").get() as { count: number };

      expect(journal.journal_mode).to.equal("wal");
      expect(count.count).to.equal(1);
    });
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

  it("keeps cached responses indefinitely when TTL is 0", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return llmResponse(makeRawAuditOutput(5, `Network response ${calls}.`));
    }) as typeof fetch;

    const options = {
      ...cacheOptions(),
      responseCacheTtlSeconds: 0,
    };

    const first = await runLlmAudit(makePayload(), options);
    await rewriteOnlyCacheEntry((entry) => ({
      ...entry,
      created_at: "1970-01-01T00:00:00.000Z",
    }));
    const second = await runLlmAudit(makePayload(), options);

    expect(calls).to.equal(1);
    expect(second).to.deep.equal(first);
  });

  it("expires cached responses when a positive TTL is configured", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return llmResponse(makeRawAuditOutput(5, `Network response ${calls}.`));
    }) as typeof fetch;

    const options = {
      ...cacheOptions(),
      responseCacheTtlSeconds: 1,
    };

    await runLlmAudit(makePayload(), options);
    await rewriteOnlyCacheEntry((entry) => ({
      ...entry,
      created_at: "1970-01-01T00:00:00.000Z",
    }));
    const refreshed = await runLlmAudit(makePayload(), options);

    expect(calls).to.equal(2);
    expect(refreshed.overall_summary).to.equal("Network response 2.");
  });

  it("prunes least-recently-accessed entries above the max entry cap", async function () {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return llmResponse(makeRawAuditOutput(5, `Network response ${calls}.`));
    }) as typeof fetch;

    const options = {
      ...cacheOptions(),
      responseCacheMaxEntries: 2,
    };

    await runLlmAudit(makePayload("0xaaa"), options);
    await sleep(10);
    await runLlmAudit(makePayload("0xbbb"), options);
    await sleep(10);
    await runLlmAudit(makePayload("0xaaa"), options);
    await sleep(10);
    await runLlmAudit(makePayload("0xccc"), options);

    expect(await countCacheEntries()).to.equal(2);
    await runLlmAudit(makePayload("0xaaa"), options);
    expect(calls).to.equal(3);
    await runLlmAudit(makePayload("0xbbb"), options);
    expect(calls).to.equal(4);
  });

  it("keeps fixed instructions in the system prompt and only payload JSON in the user message", async function () {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return llmResponse(makeRawAuditOutput(5, "Network response."));
    }) as typeof fetch;

    await runLlmAudit(makePayload("0xabc"), {
      ...cacheOptions(),
      responseCache: false,
    });
    await runLlmAudit(makePayload("0xdef"), {
      ...cacheOptions(),
      responseCache: false,
    });

    const firstUserContent = requests[0]?.messages[1]?.content ?? "";
    const secondUserContent = requests[1]?.messages[1]?.content ?? "";
    const firstSystemContent = requests[0]?.messages[0]?.content ?? "";
    const secondSystemContent = requests[1]?.messages[0]?.content ?? "";
    const firstTxHashIndex = firstUserContent.indexOf('"tx_hash":"0xabc"');
    const secondTxHashIndex = secondUserContent.indexOf('"tx_hash":"0xdef"');

    expect(firstSystemContent).to.equal(secondSystemContent);
    expect(firstSystemContent).to.contain("Analyze exactly one post_transaction_audit payload");
    expect(firstUserContent).to.not.contain("PAYLOAD_JSON");
    expect(JSON.parse(firstUserContent)).to.include({
      task: "post_transaction_audit",
      tx_hash: "0xabc",
    });
    expect(firstTxHashIndex).to.be.greaterThan(firstUserContent.indexOf('"known_limitations"'));
    expect(firstUserContent.indexOf('"raw_evidence"')).to.be.greaterThan(firstTxHashIndex);
    expect(firstUserContent.slice(0, firstTxHashIndex)).to.equal(secondUserContent.slice(0, secondTxHashIndex));
  });

  it("uses the OpenAI GPT API when OPENAI_API_KEY is configured", async function () {
    const requests: Array<{
      input: RequestInfo | URL;
      init: RequestInit | undefined;
      body: Record<string, unknown>;
    }> = [];

    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_MODEL = "openai-test-model";
    process.env.LLM_BASE_URL = "http://local-llm.test/v1";
    process.env.LLM_MODEL = "local-test-model";
    process.env.LLM_REASONING_EFFORT = "low";

    globalThis.fetch = (async (input, init) => {
      requests.push({
        input,
        init,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return llmResponse(makeRawAuditOutput(5, "Network response."));
    }) as typeof fetch;

    await runLlmAudit(makePayload(), {
      responseCache: false,
      responseCacheDir: cacheDir,
      cacheLog: false,
    });

    expect(requests).to.have.lengthOf(1);
    expect(String(requests[0]?.input)).to.equal("https://api.openai.com/v1/chat/completions");
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).to.equal("Bearer test-openai-key");
    expect(requests[0]?.body.model).to.equal("openai-test-model");
    expect(requests[0]?.body.reasoning_effort).to.equal("low");
    expect(requests[0]?.body.max_completion_tokens).to.equal(8192);
    expect(requests[0]?.body).to.not.have.property("temperature");
    expect(requests[0]?.body).to.not.have.property("max_tokens");
  });

  function cacheOptions() {
    return {
      baseUrl: "http://llm.test/v1",
      model: "test-model",
      responseCacheDir: cacheDir,
      cacheLog: false,
    };
  }

  async function rewriteOnlyCacheEntry(mutator: (entry: Record<string, unknown>) => Record<string, unknown>) {
    withCacheDb((db) => {
      const row = db.prepare("SELECT key, version, created_at, accessed_at, output_json FROM llm_response_cache")
        .get() as Record<string, unknown> | undefined;
      expect(row).to.not.equal(undefined);
      const entry = {
        ...row,
        output: JSON.parse(String(row?.output_json)),
      };
      const next = mutator(entry);
      db.prepare(`
        UPDATE llm_response_cache
        SET created_at = ?, accessed_at = ?, output_json = ?
        WHERE key = ?
      `).run(
        String(next.created_at),
        String(next.accessed_at ?? row?.accessed_at),
        JSON.stringify(next.output ?? JSON.parse(String(row?.output_json))),
        String(row?.key),
      );
    });
  }

  async function countCacheEntries() {
    return withCacheDb((db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM llm_response_cache").get() as { count: number };
      return row.count;
    });
  }

  function withCacheDb<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(cacheDir, "responses.sqlite"));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
});

function snapshotEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const snapshot: Partial<Record<T[number], string | undefined>> = {};
  for (const key of keys) {
    snapshot[key as T[number]] = process.env[key];
  }

  return snapshot as Record<T[number], string | undefined>;
}

function clearEnv(keys: readonly string[]): void {
  for (const key of keys) {
    delete process.env[key];
  }
}

function restoreEnv(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makePayload(txHash = "0xabc"): AuditPayload {
  return {
    task: "post_transaction_audit",
    chain_id: 1,
    tx_hash: txHash,
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
