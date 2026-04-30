import type { TokenMetadata, TokenPrice } from "./types.js";

const DEFAULT_PRICE_BY_ADDRESS: Record<string, TokenPrice> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    price_usd: "1",
    source: "static:mainnet-usdc",
  },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": {
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    price_usd: "1",
    source: "static:mainnet-usdt",
  },
};

export function parsePriceOverrides(raw = process.env.PRICE_OVERRIDES_JSON): Record<string, string> {
  if (raw === undefined || raw.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`PRICE_OVERRIDES_JSON value for ${key} must be a string or number`);
    }

    normalized[key.toLowerCase()] = String(value);
  }

  return normalized;
}

export function resolveTokenPrices(tokens: TokenMetadata[], overrides: Record<string, string | number> = {}): TokenPrice[] {
  const normalizedOverrides = Object.fromEntries(
    Object.entries(overrides).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  const prices: TokenPrice[] = [];

  for (const token of tokens) {
    const lowerAddress = token.address.toLowerCase();
    const override = normalizedOverrides[lowerAddress];

    if (override !== undefined) {
      prices.push({
        token: token.address,
        symbol: token.symbol,
        price_usd: override,
        source: "env:PRICE_OVERRIDES_JSON",
      });
      continue;
    }

    const defaultPrice = DEFAULT_PRICE_BY_ADDRESS[lowerAddress];
    if (defaultPrice !== undefined) {
      prices.push({
        ...defaultPrice,
        token: token.address,
        symbol: token.symbol ?? defaultPrice.symbol,
      });
    }
  }

  return prices;
}

export function findTokenPrice(prices: TokenPrice[], tokenAddress?: string): TokenPrice | undefined {
  if (tokenAddress === undefined) {
    return undefined;
  }

  return prices.find((price) => price.token.toLowerCase() === tokenAddress.toLowerCase());
}
