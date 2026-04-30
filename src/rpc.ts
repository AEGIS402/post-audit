import { erc20Interface, metadataFunctionNames } from "./abis.js";
import type { RawCodeResult, RawEthCallResult, RawRpcInput, RawTokenMetadataResult } from "./types.js";
import { checksumAddress, hexToNumber } from "./utils.js";

interface JsonRpcProviderLike {
  send(method: string, params?: unknown[]): Promise<unknown>;
}

export async function collectRawRpc(
  provider: JsonRpcProviderLike,
  txHash: string,
  subjectAddress: string,
): Promise<RawRpcInput> {
  const chainIdHex = await provider.send("eth_chainId", []);
  const tx = await provider.send("eth_getTransactionByHash", [txHash]);
  const receipt = await provider.send("eth_getTransactionReceipt", [txHash]);

  if (tx === null || typeof tx !== "object") {
    throw new Error(`Transaction not found: ${txHash}`);
  }

  if (receipt === null || typeof receipt !== "object") {
    throw new Error(`Transaction receipt not found: ${txHash}`);
  }

  const receiptRecord = receipt as Record<string, unknown>;
  const blockNumber = receiptRecord.blockNumber;
  if (typeof blockNumber !== "string") {
    throw new Error(`Receipt has no blockNumber: ${txHash}`);
  }

  const block = await provider.send("eth_getBlockByNumber", [blockNumber, false]);
  const candidateAddresses = collectCandidateAddresses(tx as Record<string, unknown>, receiptRecord);
  const tokenMetadata = await collectTokenMetadata(provider, candidateAddresses, blockNumber);
  const codeResults = await collectCode(provider, candidateAddresses, blockNumber);

  return {
    chain_id: hexToNumber(chainIdHex) ?? 0,
    tx_hash: txHash,
    subject_address: checksumAddress(subjectAddress),
    raw_rpc: {
      eth_getTransactionByHash: tx as Record<string, unknown>,
      eth_getTransactionReceipt: receiptRecord,
      eth_getBlockByNumber: (block ?? {}) as Record<string, unknown>,
      eth_call_token_metadata: tokenMetadata,
      eth_getCode_results: codeResults,
    },
  };
}

function collectCandidateAddresses(tx: Record<string, unknown>, receipt: Record<string, unknown>): string[] {
  const addresses = new Set<string>();
  addAddress(addresses, tx.to);

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  for (const log of logs) {
    if (log !== null && typeof log === "object") {
      addAddress(addresses, (log as Record<string, unknown>).address);
    }
  }

  return [...addresses];
}

async function collectTokenMetadata(
  provider: JsonRpcProviderLike,
  addresses: string[],
  blockTag: string,
): Promise<RawTokenMetadataResult[]> {
  const results: RawTokenMetadataResult[] = [];

  for (const address of addresses) {
    const calls: Record<string, RawEthCallResult> = {};

    for (const functionName of metadataFunctionNames) {
      const data = erc20Interface.encodeFunctionData(functionName);
      calls[functionName] = await safeEthCall(provider, address, data, blockTag);
    }

    results.push({
      address,
      calls,
    });
  }

  return results;
}

async function collectCode(provider: JsonRpcProviderLike, addresses: string[], blockTag: string): Promise<RawCodeResult[]> {
  const results: RawCodeResult[] = [];

  for (const address of addresses) {
    const code = await provider.send("eth_getCode", [address, blockTag]);
    results.push({
      address,
      block_tag: blockTag,
      code: typeof code === "string" ? code : "0x",
    });
  }

  return results;
}

async function safeEthCall(
  provider: JsonRpcProviderLike,
  to: string,
  data: string,
  blockTag: string,
): Promise<RawEthCallResult> {
  try {
    const result = await provider.send("eth_call", [{ to, data }, blockTag]);
    return {
      data,
      result: typeof result === "string" ? result : undefined,
    };
  } catch (error) {
    return {
      data,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function addAddress(addresses: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value === "") {
    return;
  }

  try {
    addresses.add(checksumAddress(value));
  } catch {
    // Ignore malformed RPC fields.
  }
}
