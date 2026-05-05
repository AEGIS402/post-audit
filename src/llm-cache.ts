import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const DEFAULT_LLM_RESPONSE_CACHE_DIR = "cache/llm-responses";
export const DEFAULT_LLM_RESPONSE_CACHE_TTL_SECONDS = 0;
export const DEFAULT_LLM_RESPONSE_CACHE_MAX_ENTRIES = 4_096;

const LLM_RESPONSE_CACHE_VERSION = 1;
const DEFAULT_LLM_RESPONSE_CACHE_DB_FILE = "responses.sqlite";

export interface LlmResponseCacheOptions {
  responseCache?: boolean;
  responseCacheDir?: string;
  responseCacheDbPath?: string;
  forceRefresh?: boolean;
  cacheLog?: boolean;
  responseCacheTtlSeconds?: number;
  responseCacheMaxEntries?: number;
}

export interface LlmResponseCacheConfig {
  enabled: boolean;
  dir: string;
  dbPath: string;
  forceRefresh: boolean;
  log: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

interface LlmResponseCacheRow {
  version: number;
  key: string;
  created_at: string;
  accessed_at: string;
  output_json: string;
}

export function resolveLlmResponseCacheConfig(options: LlmResponseCacheOptions = {}): LlmResponseCacheConfig {
  const dir = options.responseCacheDir ?? process.env.LLM_RESPONSE_CACHE_DIR ?? DEFAULT_LLM_RESPONSE_CACHE_DIR;
  return {
    enabled: options.responseCache ?? readEnvFlag("LLM_RESPONSE_CACHE", true),
    dir,
    dbPath: options.responseCacheDbPath ?? process.env.LLM_RESPONSE_CACHE_DB_PATH ?? join(dir, DEFAULT_LLM_RESPONSE_CACHE_DB_FILE),
    forceRefresh: options.forceRefresh ?? readEnvFlag("LLM_RESPONSE_CACHE_FORCE_REFRESH", false),
    log: options.cacheLog ?? readEnvFlag("LLM_RESPONSE_CACHE_LOG", true),
    ttlSeconds: readNonNegativeIntegerOption(
      options.responseCacheTtlSeconds,
      "LLM_RESPONSE_CACHE_TTL_SECONDS",
      DEFAULT_LLM_RESPONSE_CACHE_TTL_SECONDS,
    ),
    maxEntries: readNonNegativeIntegerOption(
      options.responseCacheMaxEntries,
      "LLM_RESPONSE_CACHE_MAX_ENTRIES",
      DEFAULT_LLM_RESPONSE_CACHE_MAX_ENTRIES,
    ),
  };
}

export function createLlmResponseCacheKey(material: unknown): string {
  return createHash("sha256")
    .update(stableStringify({
      version: LLM_RESPONSE_CACHE_VERSION,
      material,
    }))
    .digest("hex");
}

export async function readLlmResponseCache(config: LlmResponseCacheConfig, key: string): Promise<unknown | undefined> {
  try {
    return withLlmResponseCacheDb(config, (db) => {
      const row = db.prepare("SELECT version, key, created_at, accessed_at, output_json FROM llm_response_cache WHERE key = ?")
        .get(key) as LlmResponseCacheRow | undefined;

      if (row === undefined) {
        return undefined;
      }

      if (row.version !== LLM_RESPONSE_CACHE_VERSION || row.key !== key || row.output_json === "") {
        logLlmResponseCache(config, "stale", key);
        return undefined;
      }

      if (isExpired(row.created_at, config.ttlSeconds)) {
        logLlmResponseCache(config, "expired", key);
        return undefined;
      }

      const output = JSON.parse(row.output_json) as unknown;
      db.prepare("UPDATE llm_response_cache SET accessed_at = ? WHERE key = ?").run(new Date().toISOString(), key);
      return output;
    });
  } catch (error) {
    logLlmResponseCache(config, "read-error", key, error);
    return undefined;
  }
}

export async function writeLlmResponseCache(
  config: LlmResponseCacheConfig,
  key: string,
  output: unknown,
): Promise<boolean> {
  try {
    withLlmResponseCacheDb(config, (db) => {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO llm_response_cache (key, version, created_at, accessed_at, output_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          version = excluded.version,
          created_at = excluded.created_at,
          accessed_at = excluded.accessed_at,
          output_json = excluded.output_json
      `).run(key, LLM_RESPONSE_CACHE_VERSION, now, now, JSON.stringify(output) ?? "null");
      pruneLlmResponseCache(config, db);
    });
    return true;
  } catch (error) {
    logLlmResponseCache(config, "write-error", key, error);
    return false;
  }
}

export function logLlmResponseCache(
  config: Pick<LlmResponseCacheConfig, "log">,
  event: string,
  key: string,
  detail?: unknown,
): void {
  if (!config.log) {
    return;
  }

  const detailText = detail instanceof Error ? `: ${detail.message}` : detail === undefined ? "" : `: ${String(detail)}`;
  console.error(`[llm-cache] ${event} ${key.slice(0, 12)}${detailText}`);
}

function withLlmResponseCacheDb<T>(config: LlmResponseCacheConfig, fn: (db: DatabaseSync) => T): T {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_response_cache (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        output_json TEXT NOT NULL
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_llm_response_cache_accessed_at ON llm_response_cache(accessed_at, created_at)");
    return fn(db);
  } finally {
    db.close();
  }
}

function pruneLlmResponseCache(config: LlmResponseCacheConfig, db: DatabaseSync): void {
  if (config.maxEntries <= 0) {
    return;
  }

  const countRow = db.prepare("SELECT COUNT(*) AS count FROM llm_response_cache").get() as { count: number };
  const excess = countRow.count - config.maxEntries;
  if (excess <= 0) {
    return;
  }

  const rows = db.prepare(`
    SELECT key
    FROM llm_response_cache
    ORDER BY accessed_at ASC, created_at ASC, key ASC
    LIMIT ?
  `).all(excess as SQLInputValue) as Array<{ key: string }>;

  const deleteEntry = db.prepare("DELETE FROM llm_response_cache WHERE key = ?");
  for (const row of rows) {
    deleteEntry.run(row.key);
    logLlmResponseCache(config, "pruned", row.key);
  }
}

function isExpired(createdAt: string, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) {
    return false;
  }

  const createdAtMs = parseTimestamp(createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return true;
  }

  return Date.now() - createdAtMs >= ttlSeconds * 1_000;
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? "null";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : sortJsonValue(item)));
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = sortJsonValue(item);
      }
    }

    return sorted;
  }

  return value;
}

function readEnvFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }

  return defaultValue;
}

function readNonNegativeIntegerOption(value: number | undefined, envName: string, defaultValue: number): number {
  if (value !== undefined) {
    return normalizeNonNegativeInteger(value, defaultValue);
  }

  const raw = process.env[envName];
  if (raw === undefined) {
    return defaultValue;
  }

  return normalizeNonNegativeInteger(Number(raw), defaultValue);
}

function normalizeNonNegativeInteger(value: number, defaultValue: number): number {
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}
