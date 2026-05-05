import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { buildAuditPayload } from "./payload.js";
import { collectRawRpc, resolveSubjectFromTxSender, type JsonRpcProviderLike } from "./rpc.js";
import { runLlmAudit } from "./llm.js";
import { type LlmResponseCacheOptions } from "./llm-cache.js";
import { runScenarioLive } from "./scenarios.js";
import type { AuditOutput, AuditPayload } from "./types.js";
import { checksumAddress, hexToNumber } from "./utils.js";

export interface AuditRunnerFinality {
  required_confirmations: number;
  confirmations?: number;
  latest_block?: number;
  tx_block?: number;
  ready: boolean;
  waited_ms: number;
}

export interface AuditRunnerContext extends LlmResponseCacheOptions {
  finality?: AuditRunnerFinality;
}

export type AuditRunner = (payload: AuditPayload, context?: AuditRunnerContext) => Promise<AuditOutput>;

export interface AuditApiOptions {
  provider: JsonRpcProviderLike;
  priceOverrides?: Record<string, string | number>;
  auditRunner?: AuditRunner;
  ownerKey?: string;
  normalTraderKey?: string;
  sandwichTraderKey?: string;
}

const AuditSubjectRequestSchema = z.object({
  tx_hash: z.string().min(1),
  subject_address: z.string().min(1),
  force_refresh: z.boolean().optional(),
});

const AuditFromTxRequestSchema = z.object({
  tx_hash: z.string().min(1),
  force_refresh: z.boolean().optional(),
});

const DEFAULT_CACHE_MIN_CONFIRMATIONS_BY_CHAIN = new Map<number, number>([
  [1, 2],
  [11155111, 2],
]);
const DEFAULT_FINALITY_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_FINALITY_POLL_MS = 2_000;

const ScenarioOptionsSchema = z
  .object({
    amount_in: z.string().optional(),
    expected_output: z.string().optional(),
    wallet_fund_eth: z.string().optional(),
    attack_amount: z.string().optional(),
  })
  .optional()
  .default({});

class HttpError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function createAuditApiServer(options: AuditApiOptions): Server {
  return createServer(async (req, res) => {
    applyCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      const response = await routeAuditRequest(req, options);
      sendJson(res, 200, response);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
      sendJson(res, statusCode, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const allowList = (process.env.CORS_ALLOW_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const allowAny = allowList.includes("*");
  const allowOrigin = allowAny ? (origin || "*") : allowList.includes(origin) ? origin : "";
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  const reqHeaders = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof reqHeaders === "string" && reqHeaders.length > 0 ? reqHeaders : "Content-Type",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function routeAuditRequest(req: IncomingMessage, options: AuditApiOptions): Promise<unknown> {
  if (req.method !== "POST") {
    throw new HttpError(405, "Only POST is supported");
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const body = await readJsonBodyOrEmpty(req);

  if (pathname === "/audit/subject") {
    const request = AuditSubjectRequestSchema.parse(body);
    return auditTransaction(
      options,
      request.tx_hash,
      parseAddress(request.subject_address, "subject_address"),
      request.force_refresh,
    );
  }

  if (pathname === "/audit/from-tx") {
    const request = AuditFromTxRequestSchema.parse(requireBody(body));
    const subject = await resolveSubjectFromTxSender(options.provider, request.tx_hash);
    return auditTransaction(options, request.tx_hash, subject, request.force_refresh);
  }

  if (pathname === "/scenario/normal" || pathname === "/scenario/sandwich") {
    if (!options.ownerKey) {
      throw new HttpError(503, "scenario endpoints require server PRIVATE_KEY (auditor signer)");
    }
    const scenario = pathname === "/scenario/normal" ? "normal" : "sandwich";
    const traderKey =
      scenario === "normal" ? options.normalTraderKey : options.sandwichTraderKey;
    if (!traderKey) {
      throw new HttpError(
        503,
        `scenario endpoint requires ${scenario === "normal" ? "NORMAL_TRADER_KEY" : "SANDWICH_TRADER_KEY"} env var (trader signer)`,
      );
    }
    const config = ScenarioOptionsSchema.parse(body ?? {});
    return runScenarioLive({
      provider: options.provider,
      ownerKey: options.ownerKey,
      traderKey,
      scenario,
      options: {
        amountIn: config?.amount_in,
        expectedOutput: config?.expected_output,
        walletFundEth: config?.wallet_fund_eth,
        attackAmount: config?.attack_amount,
      },
    });
  }

  throw new HttpError(404, "Endpoint not found");
}

function requireBody(body: unknown): unknown {
  if (body === null || body === undefined) {
    throw new HttpError(400, "JSON body is required");
  }
  return body;
}

function parseAddress(value: string, fieldName: string): string {
  try {
    return checksumAddress(value);
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid EVM address`);
  }
}

async function auditTransaction(
  options: AuditApiOptions,
  txHash: string,
  subjectAddress: string,
  forceRefresh = false,
): Promise<AuditOutput> {
  const finality = await waitForTransactionFinality(options.provider, txHash);
  const rawRpc = await collectRawRpc(options.provider, txHash, subjectAddress);
  const payload = buildAuditPayload(rawRpc, {
    priceOverrides: options.priceOverrides,
  });
  const auditRunner = options.auditRunner ?? runLlmAudit;

  return auditRunner(payload, { forceRefresh, finality });
}

async function waitForTransactionFinality(
  provider: JsonRpcProviderLike,
  txHash: string,
): Promise<AuditRunnerFinality | undefined> {
  const started = Date.now();
  const chainId = await readChainId(provider);
  const requiredConfirmations = resolveCacheMinConfirmations(chainId ?? 0);
  if (requiredConfirmations <= 0) {
    return undefined;
  }

  const timeoutMs = readNonNegativeIntegerEnv("LLM_RESPONSE_CACHE_FINALITY_WAIT_TIMEOUT_MS", DEFAULT_FINALITY_WAIT_TIMEOUT_MS);
  const pollMs = Math.max(100, readNonNegativeIntegerEnv("LLM_RESPONSE_CACHE_FINALITY_POLL_MS", DEFAULT_FINALITY_POLL_MS));
  const deadline = started + timeoutMs;
  let loggedWait = false;

  while (true) {
    const status = await readTransactionFinalityStatus(provider, txHash);
    const confirmations =
      status.txBlock === undefined || status.latestBlock === undefined
        ? undefined
        : Math.max(0, status.latestBlock - status.txBlock + 1);

    if (confirmations !== undefined && confirmations >= requiredConfirmations) {
      const finality = {
        required_confirmations: requiredConfirmations,
        confirmations,
        latest_block: status.latestBlock,
        tx_block: status.txBlock,
        ready: true,
        waited_ms: Date.now() - started,
      };
      logFinality("ready", txHash, finality);
      return finality;
    }

    if (!loggedWait) {
      loggedWait = true;
      logFinality("waiting", txHash, {
        required_confirmations: requiredConfirmations,
        confirmations,
        latest_block: status.latestBlock,
        tx_block: status.txBlock,
        ready: false,
        waited_ms: Date.now() - started,
      });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new HttpError(
        408,
        `Transaction did not reach ${requiredConfirmations} confirmations before timeout`,
      );
    }

    await sleep(Math.min(pollMs, remaining));
  }
}

async function readTransactionFinalityStatus(
  provider: JsonRpcProviderLike,
  txHash: string,
): Promise<{ txBlock?: number; latestBlock?: number }> {
  const [receipt, latestBlock] = await Promise.all([
    readTransactionReceipt(provider, txHash),
    readLatestBlockNumber(provider),
  ]);

  return {
    txBlock: hexToNumber(receipt?.blockNumber),
    latestBlock,
  };
}

async function readChainId(provider: JsonRpcProviderLike): Promise<number | undefined> {
  try {
    return hexToNumber(await provider.send("eth_chainId", []));
  } catch {
    return undefined;
  }
}

async function readTransactionReceipt(
  provider: JsonRpcProviderLike,
  txHash: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const receipt = await provider.send("eth_getTransactionReceipt", [txHash]);
    return receipt !== null && typeof receipt === "object" ? receipt as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function readLatestBlockNumber(provider: JsonRpcProviderLike): Promise<number | undefined> {
  try {
    return hexToNumber(await provider.send("eth_blockNumber", []));
  } catch {
    return undefined;
  }
}

function resolveCacheMinConfirmations(chainId: number): number {
  const raw = process.env.LLM_RESPONSE_CACHE_MIN_CONFIRMATIONS;
  if (raw !== undefined) {
    return normalizeNonNegativeInteger(Number(raw), DEFAULT_CACHE_MIN_CONFIRMATIONS_BY_CHAIN.get(chainId) ?? 0);
  }

  return DEFAULT_CACHE_MIN_CONFIRMATIONS_BY_CHAIN.get(chainId) ?? 0;
}

function readNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  return normalizeNonNegativeInteger(Number(raw), defaultValue);
}

function normalizeNonNegativeInteger(value: number, defaultValue: number): number {
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}

function logFinality(event: "waiting" | "ready", txHash: string, finality: AuditRunnerFinality): void {
  const confirmations = finality.confirmations === undefined ? "unknown" : String(finality.confirmations);
  const latestBlock = finality.latest_block === undefined ? "unknown" : String(finality.latest_block);
  const txBlock = finality.tx_block === undefined ? "unknown" : String(finality.tx_block);
  console.error(
    `[finality] ${event} tx=${txHash.slice(0, 12)} confirmations=${confirmations}/${finality.required_confirmations} tx_block=${txBlock} latest_block=${latestBlock} waited_ms=${finality.waited_ms}`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBodyOrEmpty(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 1_000_000) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function sendJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}
