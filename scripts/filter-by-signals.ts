import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider } from "ethers";
import { buildAuditPayload } from "../src/payload.js";
import { parsePriceOverrides } from "../src/prices.js";
import { collectRawRpc, resolveSubjectFromTxSender } from "../src/rpc.js";

loadEnv({ quiet: true });

const RPC_URL = process.env.RPC_URL ?? process.env.MAINNET_RPC_URL;
const INPUT_PATH = process.env.INPUT_PATH ?? "fixtures/samples/abnormal.json";
const OUTPUT_PATH = process.env.OUTPUT_PATH ?? "fixtures/samples/abnormal-filtered.json";
const CHAIN_LABEL = process.env.CHAIN_LABEL ?? "ethereum";
const KEEP_INFO_ONLY = (process.env.KEEP_INFO_ONLY ?? "false").toLowerCase() === "true";

if (RPC_URL === undefined || RPC_URL.trim() === "") {
  console.error("RPC_URL (or MAINNET_RPC_URL) must be set");
  process.exit(1);
}

interface InputItem {
  tx_hash: string;
  category?: string;
  source?: string;
  note?: string;
}

interface FilteredItem {
  tx_hash: string;
  category?: string;
  source?: string;
  note?: string;
  subject_address: string;
  decoded_function: string;
  signals: { type: string; severity_hint: string }[];
  max_severity: string;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxSeverity(severities: string[]): string {
  let best = "info";
  for (const sev of severities) {
    if ((SEVERITY_RANK[sev] ?? 0) > (SEVERITY_RANK[best] ?? 0)) {
      best = sev;
    }
  }
  return best;
}

function normalizeItem(item: unknown, fallbackCategory?: string): InputItem {
  if (typeof item === "string") {
    return { tx_hash: item, category: fallbackCategory };
  }
  if (item !== null && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const txHash = record.tx_hash ?? record.hash;
    if (typeof txHash !== "string") {
      throw new Error(`Item missing tx_hash: ${JSON.stringify(item)}`);
    }
    return {
      tx_hash: txHash,
      category: typeof record.category === "string" ? record.category : fallbackCategory,
      source: typeof record.source === "string" ? record.source : undefined,
      note: typeof record.note === "string" ? record.note : undefined,
    };
  }
  throw new Error(`Invalid item: ${JSON.stringify(item)}`);
}

const SKIP_KEYS = new Set(["chain", "counts", "total", "verified", "errors", "not_found"]);

async function loadInput(path: string): Promise<InputItem[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeItem(item));
  }

  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return record.items.map((item) => normalizeItem(item));
    }
    if (Array.isArray(record.verified)) {
      return record.verified.map((item) => normalizeItem(item));
    }
    const items: InputItem[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (SKIP_KEYS.has(key) || !Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        items.push(normalizeItem(entry, key));
      }
    }
    if (items.length > 0) {
      return items;
    }
  }

  throw new Error(`Cannot parse input at ${path}`);
}

function dedupe(items: InputItem[]): InputItem[] {
  const seen = new Map<string, InputItem>();
  for (const item of items) {
    const existing = seen.get(item.tx_hash);
    if (existing === undefined) {
      seen.set(item.tx_hash, item);
    } else {
      seen.set(item.tx_hash, {
        ...existing,
        category: existing.category ?? item.category,
        source: existing.source ?? item.source,
        note: existing.note ?? item.note,
      });
    }
  }
  return [...seen.values()];
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const allItems = await loadInput(INPUT_PATH);
  const items = dedupe(allItems);
  console.log(`loaded ${allItems.length} entries -> ${items.length} unique tx hashes from ${INPUT_PATH}`);
  console.log(`filter mode: ${KEEP_INFO_ONLY ? "all rule_signals" : "non-info severity (medium+)"}`);

  const provider = new JsonRpcProvider(RPC_URL);
  const priceOverrides = parsePriceOverrides();

  const kept: FilteredItem[] = [];
  const dropped: { tx_hash: string; reason: string; category?: string }[] = [];
  const errors: { tx_hash: string; error: string }[] = [];
  const signalTypeCounts = new Map<string, number>();
  const signalSeverityCounts = new Map<string, number>();
  const droppedByCategory = new Map<string, number>();

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    try {
      const subject = await resolveSubjectFromTxSender(provider, item.tx_hash);
      const raw = await collectRawRpc(provider, item.tx_hash, subject);
      const payload = buildAuditPayload(raw, { priceOverrides });
      const signals = payload.rule_signals;

      if (signals.length === 0) {
        dropped.push({ tx_hash: item.tx_hash, reason: "no_rule_signals", category: item.category });
        droppedByCategory.set(item.category ?? "uncategorized", (droppedByCategory.get(item.category ?? "uncategorized") ?? 0) + 1);
        continue;
      }

      const nonInfo = signals.filter((sig) => sig.severity_hint !== "info");
      if (!KEEP_INFO_ONLY && nonInfo.length === 0) {
        dropped.push({ tx_hash: item.tx_hash, reason: "info_only", category: item.category });
        droppedByCategory.set(item.category ?? "uncategorized", (droppedByCategory.get(item.category ?? "uncategorized") ?? 0) + 1);
        continue;
      }

      const sigInfos = signals.map((sig) => ({ type: sig.type, severity_hint: sig.severity_hint }));
      for (const info of sigInfos) {
        signalTypeCounts.set(info.type, (signalTypeCounts.get(info.type) ?? 0) + 1);
        signalSeverityCounts.set(info.severity_hint, (signalSeverityCounts.get(info.severity_hint) ?? 0) + 1);
      }

      kept.push({
        tx_hash: item.tx_hash,
        category: item.category,
        source: item.source,
        note: item.note,
        subject_address: payload.subject_address,
        decoded_function: payload.decoded_call?.function ?? "unknown",
        signals: sigInfos,
        max_severity: maxSeverity(sigInfos.map((info) => info.severity_hint)),
      });
    } catch (error) {
      errors.push({
        tx_hash: item.tx_hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if ((index + 1) % 10 === 0) {
      console.log(`  progress: ${index + 1}/${items.length} (kept=${kept.length}, dropped=${dropped.length}, errors=${errors.length})`);
    }
  }

  const result = {
    chain: CHAIN_LABEL,
    input_path: INPUT_PATH,
    input_total: items.length,
    kept_total: kept.length,
    dropped_total: dropped.length,
    error_total: errors.length,
    signal_type_counts: Object.fromEntries([...signalTypeCounts.entries()].sort((a, b) => b[1] - a[1])),
    signal_severity_counts: Object.fromEntries(signalSeverityCounts),
    dropped_by_category: Object.fromEntries(droppedByCategory),
    kept,
    dropped,
    errors,
  };

  await writeJsonFile(OUTPUT_PATH, result);

  console.log(`\nkept: ${kept.length} / ${items.length}`);
  console.log(`dropped: ${dropped.length}, errors: ${errors.length}`);
  console.log("\nsignal type counts:");
  for (const [type, count] of [...signalTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(36)} ${count}`);
  }
  console.log("\ndropped by input category:");
  for (const [cat, count] of [...droppedByCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(28)} ${count}`);
  }
  console.log(`\nwrote: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
