import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { buildAuditPayload } from "./payload.js";
import { collectRawRpc, resolveSubjectFromTxSender, type JsonRpcProviderLike } from "./rpc.js";
import { runLlmAudit } from "./llm.js";
import { resolveLlmResponseCacheConfig, type LlmResponseCacheOptions } from "./llm-cache.js";
import { runScenarioLive } from "./scenarios.js";
import type { AuditOutput, AuditPayload } from "./types.js";
import { checksumAddress, hexToNumber } from "./utils.js";

export interface AuditRunnerCacheFinality {
  required_confirmations: number;
  confirmations?: number;
  latest_block?: number;
  tx_block?: number;
  cacheable: boolean;
}

export interface AuditRunnerContext extends LlmResponseCacheOptions {
  cacheFinality?: AuditRunnerCacheFinality;
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
  [1, 64],
  [11155111, 64],
]);

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
  const rawRpc = await collectRawRpc(options.provider, txHash, subjectAddress);
  const payload = buildAuditPayload(rawRpc, {
    priceOverrides: options.priceOverrides,
  });
  const auditRunner = options.auditRunner ?? runLlmAudit;
  const auditRunnerContext = await buildAuditRunnerContext(options.provider, payload, forceRefresh);

  return auditRunner(payload, auditRunnerContext);
}

async function buildAuditRunnerContext(
  provider: JsonRpcProviderLike,
  payload: AuditPayload,
  forceRefresh: boolean,
): Promise<AuditRunnerContext> {
  const context: AuditRunnerContext = { forceRefresh };
  const cache = resolveLlmResponseCacheConfig(context);
  if (!cache.enabled) {
    return context;
  }

  const requiredConfirmations = resolveCacheMinConfirmations(payload.chain_id);
  if (requiredConfirmations <= 0) {
    return context;
  }

  const txBlock = payload.execution.block_number;
  if (txBlock === undefined) {
    context.responseCache = false;
    context.cacheFinality = {
      required_confirmations: requiredConfirmations,
      cacheable: false,
    };
    logCacheFinalityBypass(cache.log, payload, context.cacheFinality, "missing tx block");
    return context;
  }

  const latestBlock = await readLatestBlockNumber(provider);
  if (latestBlock === undefined) {
    context.responseCache = false;
    context.cacheFinality = {
      required_confirmations: requiredConfirmations,
      tx_block: txBlock,
      cacheable: false,
    };
    logCacheFinalityBypass(cache.log, payload, context.cacheFinality, "missing latest block");
    return context;
  }

  const confirmations = Math.max(0, latestBlock - txBlock + 1);
  context.cacheFinality = {
    required_confirmations: requiredConfirmations,
    confirmations,
    latest_block: latestBlock,
    tx_block: txBlock,
    cacheable: confirmations >= requiredConfirmations,
  };

  if (!context.cacheFinality.cacheable) {
    context.responseCache = false;
    logCacheFinalityBypass(cache.log, payload, context.cacheFinality);
  }

  return context;
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

function normalizeNonNegativeInteger(value: number, defaultValue: number): number {
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}

function logCacheFinalityBypass(
  enabled: boolean,
  payload: AuditPayload,
  finality: AuditRunnerCacheFinality,
  reason = "insufficient confirmations",
): void {
  if (!enabled) {
    return;
  }

  const confirmations = finality.confirmations === undefined ? "unknown" : String(finality.confirmations);
  const latestBlock = finality.latest_block === undefined ? "unknown" : String(finality.latest_block);
  const txBlock = finality.tx_block === undefined ? "unknown" : String(finality.tx_block);
  console.error(
    `[llm-cache] bypass-finality tx=${payload.tx_hash.slice(0, 12)} reason=${reason} confirmations=${confirmations}/${finality.required_confirmations} tx_block=${txBlock} latest_block=${latestBlock}`,
  );
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
