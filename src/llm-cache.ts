import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LLM_RESPONSE_CACHE_DIR = "cache/llm-responses";

const LLM_RESPONSE_CACHE_VERSION = 1;

export interface LlmResponseCacheOptions {
  responseCache?: boolean;
  responseCacheDir?: string;
  forceRefresh?: boolean;
  cacheLog?: boolean;
}

export interface LlmResponseCacheConfig {
  enabled: boolean;
  dir: string;
  forceRefresh: boolean;
  log: boolean;
}

interface LlmResponseCacheEntry {
  version: number;
  key: string;
  created_at: string;
  output: unknown;
}

export function resolveLlmResponseCacheConfig(options: LlmResponseCacheOptions = {}): LlmResponseCacheConfig {
  return {
    enabled: options.responseCache ?? readEnvFlag("LLM_RESPONSE_CACHE", true),
    dir: options.responseCacheDir ?? process.env.LLM_RESPONSE_CACHE_DIR ?? DEFAULT_LLM_RESPONSE_CACHE_DIR,
    forceRefresh: options.forceRefresh ?? readEnvFlag("LLM_RESPONSE_CACHE_FORCE_REFRESH", false),
    log: options.cacheLog ?? readEnvFlag("LLM_RESPONSE_CACHE_LOG", true),
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

    if (entry.version !== LLM_RESPONSE_CACHE_VERSION || entry.key !== key || entry.output === undefined) {
      logLlmResponseCache(config, "stale", key);
      return undefined;
    }

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
    await mkdir(config.dir, { recursive: true });
    const targetPath = cachePath(config.dir, key);
    const tmpPath = join(config.dir, `${key}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);

    await writeFile(
      tmpPath,
      `${JSON.stringify({
        version: LLM_RESPONSE_CACHE_VERSION,
        key,
        created_at: new Date().toISOString(),
        output,
      } satisfies LlmResponseCacheEntry, null, 2)}\n`,
      "utf8",
    );
    await rename(tmpPath, targetPath);
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

function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
