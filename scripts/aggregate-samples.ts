import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const NORMAL_AUTO = process.env.NORMAL_PATH ?? "fixtures/samples/normal.json";
const ABNORMAL_AUTO = process.env.ABNORMAL_AUTO_PATH ?? "fixtures/samples/abnormal-auto.json";
const ABNORMAL_CURATED = process.env.ABNORMAL_CURATED_PATH ?? "fixtures/samples/abnormal-curated.json";
const ABNORMAL_OUT = process.env.ABNORMAL_OUT ?? "fixtures/samples/abnormal.json";

interface Bucket {
  chain?: string;
  [bucket: string]: unknown;
}

interface CuratedItem {
  tx_hash: string;
  category: string;
  source?: string;
  note?: string;
}

interface CuratedFile {
  chain: string;
  verified: CuratedItem[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pushUnique(bucket: string[], item: string): void {
  if (!bucket.includes(item)) {
    bucket.push(item);
  }
}

async function main(): Promise<void> {
  const auto = await readJson<Bucket>(ABNORMAL_AUTO);
  const curated = await readJson<CuratedFile>(ABNORMAL_CURATED);

  const merged: Record<string, string[]> = {
    failed_tx: Array.isArray(auto.failed_tx) ? [...(auto.failed_tx as string[])] : [],
    unlimited_approval: Array.isArray(auto.unlimited_approval) ? [...(auto.unlimited_approval as string[])] : [],
    missing_slippage: Array.isArray(auto.missing_slippage) ? [...(auto.missing_slippage as string[])] : [],
    hack_exploit: [],
    hack_recovery: [],
    sandwich_victim: [],
    phishing_drainer: [],
    mev_arbitrage: [],
  };

  for (const item of curated.verified) {
    const observedStatus = (item as { observed?: { status?: string } }).observed?.status;
    const observed = (item as { observed?: { is_missing_slippage?: boolean; is_unlimited_approval?: boolean } }).observed;

    const targetBucket = merged[item.category];
    if (Array.isArray(targetBucket)) {
      pushUnique(targetBucket, item.tx_hash);
    }

    if (observedStatus === "0x0") {
      pushUnique(merged.failed_tx, item.tx_hash);
    }
    if (observed?.is_missing_slippage === true) {
      pushUnique(merged.missing_slippage, item.tx_hash);
    }
    if (observed?.is_unlimited_approval === true) {
      pushUnique(merged.unlimited_approval, item.tx_hash);
    }
  }

  const totalAbnormal = Object.values(merged).reduce((sum, list) => sum + list.length, 0);
  const counts = Object.fromEntries(Object.entries(merged).map(([key, list]) => [key, list.length]));

  await writeJson(ABNORMAL_OUT, {
    chain: curated.chain ?? auto.chain ?? "ethereum",
    counts,
    total: totalAbnormal,
    ...merged,
  });

  console.log(`wrote: ${ABNORMAL_OUT}`);
  console.log(`abnormal counts:`, counts);
  console.log(`abnormal total (with overlaps):`, totalAbnormal);

  const normal = await readJson<Bucket>(NORMAL_AUTO);
  const normalCounts = {
    erc20_transfer: Array.isArray(normal.erc20_transfer) ? (normal.erc20_transfer as string[]).length : 0,
    erc721_transfer: Array.isArray(normal.erc721_transfer) ? (normal.erc721_transfer as string[]).length : 0,
    swap: Array.isArray(normal.swap) ? (normal.swap as string[]).length : 0,
  };
  console.log(`\nnormal counts (${NORMAL_AUTO}):`, normalCounts);
  console.log(`normal total:`, Object.values(normalCounts).reduce((sum, n) => sum + n, 0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
