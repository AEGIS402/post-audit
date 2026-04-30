import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { z } from "zod";
import { buildAuditPayload } from "./payload.js";
import { collectRawRpc, resolveSubjectFromTxSender, type JsonRpcProviderLike } from "./rpc.js";
import { runLlmAudit } from "./llm.js";
import type { AuditOutput, AuditPayload } from "./types.js";
import { checksumAddress } from "./utils.js";

export type AuditRunner = (payload: AuditPayload) => Promise<AuditOutput>;

export interface AuditApiOptions {
  provider: JsonRpcProviderLike;
  priceOverrides?: Record<string, string | number>;
  auditRunner?: AuditRunner;
}

const AuditSubjectRequestSchema = z.object({
  tx_hash: z.string().min(1),
  subject_address: z.string().min(1),
});

const AuditFromTxRequestSchema = z.object({
  tx_hash: z.string().min(1),
});

class HttpError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function createAuditApiServer(options: AuditApiOptions): Server {
  return createServer(async (req, res) => {
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

async function routeAuditRequest(req: IncomingMessage, options: AuditApiOptions): Promise<AuditOutput> {
  if (req.method !== "POST") {
    throw new HttpError(405, "Only POST is supported");
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const body = await readJsonBody(req);

  if (pathname === "/audit/subject") {
    const request = AuditSubjectRequestSchema.parse(body);
    return auditTransaction(options, request.tx_hash, parseAddress(request.subject_address, "subject_address"));
  }

  if (pathname === "/audit/from-tx") {
    const request = AuditFromTxRequestSchema.parse(body);
    const subject = await resolveSubjectFromTxSender(options.provider, request.tx_hash);
    return auditTransaction(options, request.tx_hash, subject);
  }

  throw new HttpError(404, "Endpoint not found");
}

function parseAddress(value: string, fieldName: string): string {
  try {
    return checksumAddress(value);
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid EVM address`);
  }
}

async function auditTransaction(options: AuditApiOptions, txHash: string, subjectAddress: string): Promise<AuditOutput> {
  const rawRpc = await collectRawRpc(options.provider, txHash, subjectAddress);
  const payload = buildAuditPayload(rawRpc, {
    priceOverrides: options.priceOverrides,
  });
  const auditRunner = options.auditRunner ?? runLlmAudit;

  return auditRunner(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
    throw new HttpError(400, "JSON body is required");
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
