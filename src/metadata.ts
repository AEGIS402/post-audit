import { BytesLike, decodeBytes32String } from "ethers";
import { erc20Interface } from "./abis.js";
import type { RawTokenMetadataResult, TokenMetadata } from "./types.js";
import { checksumAddress, hexToNumber } from "./utils.js";

const KNOWN_MAINNET_TOKEN_METADATA: Record<string, Omit<TokenMetadata, "address">> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
  },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": {
    name: "Tether USD",
    symbol: "USDT",
    decimals: 6,
  },
};

export function decodeTokenMetadata(results: RawTokenMetadataResult[]): TokenMetadata[] {
  const tokens = new Map<string, TokenMetadata>();

  for (const result of results) {
    const address = checksumAddress(result.address);
    const metadata: TokenMetadata = {
      address,
      ...KNOWN_MAINNET_TOKEN_METADATA[address.toLowerCase()],
      ...result.decoded,
    };

    if (result.calls !== undefined) {
      metadata.name = decodeOptionalString("name", result.calls.name?.result) ?? metadata.name;
      metadata.symbol = decodeOptionalString("symbol", result.calls.symbol?.result) ?? metadata.symbol;
      metadata.decimals = decodeOptionalUint8("decimals", result.calls.decimals?.result) ?? metadata.decimals;
    }

    tokens.set(address.toLowerCase(), metadata);
  }

  return [...tokens.values()];
}

export function tokenMetadataMap(tokens: TokenMetadata[]): Map<string, TokenMetadata> {
  return new Map(tokens.map((token) => [token.address.toLowerCase(), token]));
}

function decodeOptionalString(functionName: "name" | "symbol", result?: string): string | undefined {
  if (result === undefined || result === "0x") {
    return undefined;
  }

  try {
    const decoded = erc20Interface.decodeFunctionResult(functionName, result)[0];
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return decodeOptionalBytes32String(result);
  }
}

function decodeOptionalBytes32String(result: BytesLike): string | undefined {
  try {
    return decodeBytes32String(result);
  } catch {
    return undefined;
  }
}

function decodeOptionalUint8(functionName: "decimals", result?: string): number | undefined {
  if (result === undefined || result === "0x") {
    return undefined;
  }

  try {
    const decoded = erc20Interface.decodeFunctionResult(functionName, result)[0];
    return Number(decoded);
  } catch {
    return hexToNumber(result);
  }
}
