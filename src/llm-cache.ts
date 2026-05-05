import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LLM_RESPONSE_CACHE_DIR = "cache/llm-responses";
export const DEFAULT_LLM_RESPONSE_CACHE_TTL_SECONDS = 0;
export const DEFAULT_LLM_RESPONSE_CACHE_MAX_ENTRIES = 4_096;

const LLM_RESPONSE_CACHE_VERSION = 1;

export interface LlmResponseCacheOptions {
  responseCache?: boolean;
  responseCacheDir?: string;
  forceRefresh?: boolean;
  cacheLog?: boolean;
  responseCacheTtlSeconds?: number;
  responseCacheMaxEntries?: number;
}

export interface LlmResponseCacheConfig {
  enabled: boolean;
  dir: string;
  forceRefresh: boolean;
  log: boolean;
  ttlSeconds: number;
  maxEntries: number;
}

interface LlmResponseCacheEntry {
  version: number;
  key: string;
  created_at: string;
  accessed_at: string;
  output: unknown;
}

interface LlmResponseCachePruneCandidate {
  key: string;
  path: string;
  accessedAtMs: number;
}

export function resolveLlmResponseCacheConfig(options: LlmResponseCacheOptions = {}): LlmResponseCacheConfig {
  return {
    enabled: options.responseCache ?? readEnvFlag("LLM_RESPONSE_CACHE", true),
    dir: options.responseCacheDir ?? process.env.LLM_RESPONSE_CACHE_DIR ?? DEFAULT_LLM_RESPONSE_CACHE_DIR,
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
    const raw = await readFile(cachePath(config.dir, key), "utf8");
    const entry = JSON.parse(raw) as Partial<LlmResponseCacheEntry>;

    if (
      entry.version !== LLM_RESPONSE_CACHE_VERSION ||
      entry.key !== key ||
      typeof entry.created_at !== "string" ||
      entry.output === undefined
    ) {
      logLlmResponseCache(config, "stale", key);
      return undefined;
    }

    if (isExpired(entry.created_at, config.ttlSeconds)) {
      logLlmResponseCache(config, "expired", key);
      return undefined;
    }

    await touchLlmResponseCacheEntry(config, {
      version: entry.version,
      key: entry.key,
      created_at: entry.created_at,
      accessed_at: new Date().toISOString(),
      output: entry.output,
    });

    return entry.output;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      logLlmResponseCache(config, "read-error", key, error);
    }

    return undefined;
  }
}

export async function writeLlmResponseCache(
  config: LlmResponseCacheConfig,
  key: string,
  output: unknown,
): Promise<boolean> {
  try {
    const now = new Date().toISOString();
    await writeLlmResponseCacheEntry(config.dir, key, {
      version: LLM_RESPONSE_CACHE_VERSION,
      key,
      created_at: now,
      accessed_at: now,
      output,
    });
    await pruneLlmResponseCache(config);
    return true;
  } catch (error) {
    logLlmResponseCache(config, "write-error", key, error);
    return false;
  }
}

export function logLlmResponseCache(
  config: LlmResponseCacheConfig,
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

async function touchLlmResponseCacheEntry(
  config: LlmResponseCacheConfig,
  entry: LlmResponseCacheEntry,
): Promise<void> {
  try {
    await writeLlmResponseCacheEntry(config.dir, entry.key, entry);
  } catch (error) {
    logLlmResponseCache(config, "touch-error", entry.key, error);
  }
}

async function writeLlmResponseCacheEntry(
  dir: string,
  key: string,
  entry: LlmResponseCacheEntry,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const targetPath = cachePath(dir, key);
  const tmpPath = join(dir, `${key}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

  await writeFile(tmpPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

async function pruneLlmResponseCache(config: LlmResponseCacheConfig): Promise<void> {
  if (config.maxEntries <= 0) {
    return;
  }

  let files: string[];
  try {
    files = await readdir(config.dir);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      logLlmResponseCache(config, "prune-error", "unknown", error);
    }
    return;
  }

  const candidates = await Promise.all(
    files
      .filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))
      .map((file) => readPruneCandidate(config, file)),
  );
  const existing = candidates.filter((candidate): candidate is LlmResponseCachePruneCandidate => candidate !== undefined);
  const excess = existing.length - config.maxEntries;

  if (excess <= 0) {
    return;
  }

  existing.sort((a, b) => a.accessedAtMs - b.accessedAtMs);
  for (const candidate of existing.slice(0, excess)) {
    try {
      await unlink(candidate.path);
      logLlmResponseCache(config, "pruned", candidate.key);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        logLlmResponseCache(config, "prune-error", candidate.key, error);
      }
    }
  }
}

async function readPruneCandidate(
  config: LlmResponseCacheConfig,
  file: string,
): Promise<LlmResponseCachePruneCandidate | undefined> {
  const path = join(config.dir, file);

  try {
    const raw = await readFile(path, "utf8");
    const entry = JSON.parse(raw) as Partial<LlmResponseCacheEntry>;
    const key = typeof entry.key === "string" ? entry.key : file.replace(/\.json$/u, "");
    const accessedAt = typeof entry.accessed_at === "string" ? entry.accessed_at : entry.created_at;
    const accessedAtMs = parseTimestamp(accessedAt);

    return {
      key,
      path,
      accessedAtMs,
    };
  } catch (error) {
    logLlmResponseCache(config, "prune-read-error", file.replace(/\.json$/u, ""), error);
    return undefined;
  }
}

function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
