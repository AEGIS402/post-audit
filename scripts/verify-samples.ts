import { readFile, mkdir, writeFile } from "node:fs/promises";
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

const RPC_URL = process.env.RPC_URL ?? process.env.MAINNET_RPC_URL;
const INPUT_PATH = process.env.INPUT_PATH ?? "fixtures/samples/abnormal-candidates.json";
const OUTPUT_PATH = process.env.OUTPUT_PATH ?? "fixtures/samples/abnormal-verified.json";
const CHAIN_LABEL = process.env.CHAIN_LABEL ?? "ethereum";

if (RPC_URL === undefined || RPC_URL.trim() === "") {
  console.error("RPC_URL (or MAINNET_RPC_URL) must be set");
  process.exit(1);
}

interface Candidate {
  tx_hash: string;
  category?: string;
  source?: string;
  note?: string;
}

interface VerifiedItem {
  tx_hash: string;
  category: string;
  source?: string;
  note?: string;
  observed: {
    status: string;
    erc20_transfers: number;
    erc721_transfers: number;
    selector: string;
    is_unlimited_approval: boolean;
    is_missing_slippage: boolean;
  };
}

interface VerifyResult {
  chain: string;
  verified: VerifiedItem[];
  not_found: string[];
  errors: { tx_hash: string; error: string }[];
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
}

interface RpcReceipt {
  transactionHash: string;
  status?: string;
  logs?: RpcLog[];
}

async function loadCandidates(path: string): Promise<Candidate[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeCandidate(item));
  }

  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const items = record.items ?? record.candidates;
    if (Array.isArray(items)) {
      return items.map((item) => normalizeCandidate(item));
    }
    const candidates: Candidate[] = [];
    for (const [category, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") {
            candidates.push({ tx_hash: entry, category });
          } else {
            candidates.push({ ...normalizeCandidate(entry), category });
          }
        }
      }
    }
    if (candidates.length > 0) {
      return candidates;
    }
  }

  throw new Error(`Could not parse candidates from ${path}`);
}

function normalizeCandidate(item: unknown): Candidate {
  if (typeof item === "string") {
    return { tx_hash: item };
  }
  if (item !== null && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const txHash = record.tx_hash ?? record.hash ?? record.txhash;
    if (typeof txHash !== "string") {
      throw new Error(`Candidate missing tx_hash: ${JSON.stringify(item)}`);
    }
    return {
      tx_hash: txHash,
      category: typeof record.category === "string" ? record.category : undefined,
      source: typeof record.source === "string" ? record.source : undefined,
      note: typeof record.note === "string" ? record.note : undefined,
    };
  }
  throw new Error(`Invalid candidate entry: ${JSON.stringify(item)}`);
}

async function verifyOne(provider: JsonRpcProvider, candidate: Candidate): Promise<VerifiedItem | undefined> {
  const tx = (await provider.send("eth_getTransactionByHash", [candidate.tx_hash])) as RpcTx | null;
  if (tx === null) {
    return undefined;
  }
  const receipt = (await provider.send("eth_getTransactionReceipt", [candidate.tx_hash])) as RpcReceipt | null;
  if (receipt === null) {
    return undefined;
  }

  const input = (tx.input ?? "0x").toLowerCase();
  const selector = input.slice(0, 10);
  const logs = receipt.logs ?? [];
  const erc20Count = logs.filter(
    (log) => log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 3,
  ).length;
  const erc721Count = logs.filter(
    (log) => log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics.length === 4,
  ).length;
  const isUnlimitedApproval =
    selector === ERC20_APPROVE_SELECTOR && input.length >= 138 && input.slice(74, 138) === MAX_UINT256_HEX;
  const isMissingSlippage =
    selector === EXACT_INPUT_SINGLE_SELECTOR && input.length >= 522 && /^0+$/u.test(input.slice(394, 458));

  const inferredCategory = inferCategory({
    selector,
    erc20Count,
    erc721Count,
    isUnlimitedApproval,
    isMissingSlippage,
    status: receipt.status?.toLowerCase() ?? "0x1",
  });

  return {
    tx_hash: candidate.tx_hash,
    category: candidate.category ?? inferredCategory,
    source: candidate.source,
    note: candidate.note,
    observed: {
      status: receipt.status?.toLowerCase() ?? "unknown",
      erc20_transfers: erc20Count,
      erc721_transfers: erc721Count,
      selector,
      is_unlimited_approval: isUnlimitedApproval,
      is_missing_slippage: isMissingSlippage,
    },
  };
}

function inferCategory(observed: {
  selector: string;
  erc20Count: number;
  erc721Count: number;
  isUnlimitedApproval: boolean;
  isMissingSlippage: boolean;
  status: string;
}): string {
  if (observed.status === "0x0") {
    return "failed_tx";
  }
  if (observed.isMissingSlippage) {
    return "missing_slippage";
  }
  if (observed.isUnlimitedApproval) {
    return "unlimited_approval";
  }
  if (observed.erc20Count >= 2) {
    return "swap";
  }
  if (observed.erc721Count >= 1) {
    return "erc721_transfer";
  }
  if (
    observed.erc20Count === 1 &&
    (observed.selector === ERC20_TRANSFER_SELECTOR || observed.selector === ERC20_TRANSFER_FROM_SELECTOR)
  ) {
    return "erc20_transfer";
  }
  return "other";
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const candidates = await loadCandidates(INPUT_PATH);
  console.log(`loaded ${candidates.length} candidates from ${INPUT_PATH}`);

  const provider = new JsonRpcProvider(RPC_URL);
  const result: VerifyResult = {
    chain: CHAIN_LABEL,
    verified: [],
    not_found: [],
    errors: [],
  };

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    try {
      const verified = await verifyOne(provider, candidate);
      if (verified === undefined) {
        result.not_found.push(candidate.tx_hash);
      } else {
        result.verified.push(verified);
      }
    } catch (error) {
      result.errors.push({
        tx_hash: candidate.tx_hash,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if ((index + 1) % 10 === 0) {
      console.log(`  progress: ${index + 1}/${candidates.length}`);
    }
  }

  console.log(`\nverified: ${result.verified.length}`);
  console.log(`not_found: ${result.not_found.length}`);
  console.log(`errors: ${result.errors.length}`);

  await writeJsonFile(OUTPUT_PATH, result);
  console.log(`wrote: ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
