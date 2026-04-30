import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config as loadEnv } from "dotenv";
import { JsonRpcProvider } from "ethers";

loadEnv({ quiet: true });

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const ERC20_TRANSFER_FROM_SELECTOR = "0x23b872dd";
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const EXACT_INPUT_SINGLE_SELECTOR = "0x414bf389";
const MAX_UINT256_HEX = "f".repeat(64);

const NORMAL_TARGET = Number(process.env.NORMAL_TARGET ?? 100);
const ABNORMAL_TARGET = Number(process.env.ABNORMAL_TARGET ?? 50);
const MISSING_SLIPPAGE_TARGET = Number(process.env.MISSING_SLIPPAGE_TARGET ?? ABNORMAL_TARGET);
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? 1500);
const HEAD_OFFSET = Number(process.env.HEAD_OFFSET ?? 5);
const NORMAL_PATH = process.env.NORMAL_PATH ?? "fixtures/samples/normal.json";
const ABNORMAL_PATH = process.env.ABNORMAL_PATH ?? "fixtures/samples/abnormal-auto.json";
const RPC_URL = process.env.RPC_URL ?? process.env.MAINNET_RPC_URL;
const CHAIN_LABEL = process.env.CHAIN_LABEL ?? "ethereum";

if (RPC_URL === undefined || RPC_URL.trim() === "") {
  console.error("RPC_URL (or MAINNET_RPC_URL) must be set");
  process.exit(1);
}

interface RpcLog {
  topics?: string[];
  address?: string;
  data?: string;
}

interface RpcTx {
  hash: string;
  input?: string;
  from?: string;
  to?: string | null;
}

interface RpcReceipt {
  transactionHash: string;
  status?: string;
  logs?: RpcLog[];
}

interface NormalBuckets {
  erc20_transfer: string[];
  erc721_transfer: string[];
  swap: string[];
}

interface AbnormalBuckets {
  failed_tx: string[];
  unlimited_approval: string[];
  missing_slippage: string[];
}

interface Buckets {
  normal: NormalBuckets;
  abnormal: AbnormalBuckets;
}

function paddedAddress(addr: string): string {
  return `0x${"0".repeat(24)}${addr.toLowerCase().slice(2)}`;
}

function pushUnique(bucket: string[], item: string, max: number): void {
  if (bucket.length < max && !bucket.includes(item)) {
    bucket.push(item);
  }
}

function classify(tx: RpcTx, receipt: RpcReceipt, buckets: Buckets): void {
  const hash = tx.hash;
  const status = receipt.status?.toLowerCase();
  const input = (tx.input ?? "0x").toLowerCase();
  const selector = input.slice(0, 10);
  const logs = receipt.logs ?? [];

  if (status === "0x0") {
    pushUnique(buckets.abnormal.failed_tx, hash, ABNORMAL_TARGET);
    return;
  }

  const erc20Transfers = logs.filter(
    (log) => log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 3,
  );
  const erc721Transfers = logs.filter(
    (log) => log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 4,
  );

  if (erc721Transfers.length >= 1 && erc20Transfers.length === 0) {
    pushUnique(buckets.normal.erc721_transfer, hash, NORMAL_TARGET);
  }

  if (erc20Transfers.length >= 2 && tx.from !== undefined) {
    const tokens = new Set(erc20Transfers.map((log) => (log.address ?? "").toLowerCase()));
    const fromPadded = paddedAddress(tx.from);
    const sent = erc20Transfers.some((log) => log.topics?.[1]?.toLowerCase() === fromPadded);
    const received = erc20Transfers.some((log) => log.topics?.[2]?.toLowerCase() === fromPadded);
    if (tokens.size >= 2 && (sent || received)) {
      pushUnique(buckets.normal.swap, hash, NORMAL_TARGET);
    }
  }

  if (
    erc20Transfers.length === 1 &&
    erc721Transfers.length === 0 &&
    (selector === ERC20_TRANSFER_SELECTOR || selector === ERC20_TRANSFER_FROM_SELECTOR)
  ) {
    pushUnique(buckets.normal.erc20_transfer, hash, NORMAL_TARGET);
  }

  if (selector === ERC20_APPROVE_SELECTOR && input.length >= 138) {
    const amountHex = input.slice(74, 138);
    if (amountHex === MAX_UINT256_HEX) {
      pushUnique(buckets.abnormal.unlimited_approval, hash, ABNORMAL_TARGET);
    }
  }

  if (selector === EXACT_INPUT_SINGLE_SELECTOR && input.length >= 522) {
    const amountOutMinHex = input.slice(394, 458);
    if (/^0+$/u.test(amountOutMinHex)) {
      pushUnique(buckets.abnormal.missing_slippage, hash, MISSING_SLIPPAGE_TARGET);
    }
  }
}

function isFull(buckets: Buckets): boolean {
  return (
    buckets.normal.erc20_transfer.length >= NORMAL_TARGET &&
    buckets.normal.erc721_transfer.length >= NORMAL_TARGET &&
    buckets.normal.swap.length >= NORMAL_TARGET &&
    buckets.abnormal.failed_tx.length >= ABNORMAL_TARGET &&
    buckets.abnormal.unlimited_approval.length >= ABNORMAL_TARGET &&
    buckets.abnormal.missing_slippage.length >= MISSING_SLIPPAGE_TARGET
  );
}

function summary(buckets: Buckets): string {
  return [
    "  normal:",
    `    erc20_transfer:     ${buckets.normal.erc20_transfer.length}/${NORMAL_TARGET}`,
    `    erc721_transfer:    ${buckets.normal.erc721_transfer.length}/${NORMAL_TARGET}`,
    `    swap:               ${buckets.normal.swap.length}/${NORMAL_TARGET}`,
    "  abnormal:",
    `    failed_tx:          ${buckets.abnormal.failed_tx.length}/${ABNORMAL_TARGET}`,
    `    unlimited_approval: ${buckets.abnormal.unlimited_approval.length}/${ABNORMAL_TARGET}`,
    `    missing_slippage:   ${buckets.abnormal.missing_slippage.length}/${MISSING_SLIPPAGE_TARGET}`,
  ].join("\n");
}

async function fetchReceipts(provider: JsonRpcProvider, blockHex: string, txHashes: string[]): Promise<RpcReceipt[]> {
  try {
    const receipts = (await provider.send("eth_getBlockReceipts", [blockHex])) as RpcReceipt[] | null;
    if (Array.isArray(receipts)) {
      return receipts;
    }
  } catch {
    // Fall back to per-tx fetch.
  }

  const results: RpcReceipt[] = [];
  for (const hash of txHashes) {
    const receipt = (await provider.send("eth_getTransactionReceipt", [hash])) as RpcReceipt | null;
    if (receipt !== null) {
      results.push(receipt);
    }
  }
  return results;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function flush(buckets: Buckets): Promise<void> {
  await writeJsonFile(NORMAL_PATH, { chain: CHAIN_LABEL, ...buckets.normal });
  await writeJsonFile(ABNORMAL_PATH, { chain: CHAIN_LABEL, ...buckets.abnormal });
}

async function main(): Promise<void> {
  const buckets: Buckets = {
    normal: { erc20_transfer: [], erc721_transfer: [], swap: [] },
    abnormal: { failed_tx: [], unlimited_approval: [], missing_slippage: [] },
  };

  let stopRequested = false;
  const stopHandler = (): void => {
    console.log("\nstop signal received; will flush after current block");
    stopRequested = true;
  };
  process.on("SIGINT", stopHandler);
  process.on("SIGTERM", stopHandler);

  const provider = new JsonRpcProvider(RPC_URL);
  const latestHex = (await provider.send("eth_blockNumber", [])) as string;
  const latest = Number(BigInt(latestHex));
  console.log(`chain: ${CHAIN_LABEL} | latest block: ${latest}`);
  console.log(`targets: normal=${NORMAL_TARGET}/bucket, abnormal=${ABNORMAL_TARGET}/bucket, max_blocks=${MAX_BLOCKS}`);

  let block = latest - HEAD_OFFSET;
  let scanned = 0;

  while (!isFull(buckets) && block > 0 && scanned < MAX_BLOCKS && !stopRequested) {
    const blockHex = `0x${block.toString(16)}`;
    const fullBlock = (await provider.send("eth_getBlockByNumber", [blockHex, true])) as
      | { transactions?: RpcTx[] }
      | null;

    if (fullBlock?.transactions === undefined || fullBlock.transactions.length === 0) {
      block--;
      scanned++;
      continue;
    }

    const txHashes = fullBlock.transactions.map((tx) => tx.hash);
    const receipts = await fetchReceipts(provider, blockHex, txHashes);
    const receiptByHash = new Map(receipts.map((receipt) => [receipt.transactionHash.toLowerCase(), receipt]));

    for (const tx of fullBlock.transactions) {
      const receipt = receiptByHash.get(tx.hash.toLowerCase());
      if (receipt === undefined) {
        continue;
      }
      classify(tx, receipt, buckets);
    }

    scanned++;
    if (scanned % 5 === 0) {
      console.log(`[scanned ${scanned} blocks, head ${block}]`);
      console.log(summary(buckets));
    }
    if (scanned % 25 === 0) {
      await flush(buckets);
    }
    block--;
  }

  console.log(`\nfinished after ${scanned} blocks scanned`);
  console.log(summary(buckets));

  await flush(buckets);
  console.log(`\nwrote: ${NORMAL_PATH}`);
  console.log(`wrote: ${ABNORMAL_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
