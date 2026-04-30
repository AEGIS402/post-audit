import { formatEther, formatUnits, getAddress, MaxUint256, toBigInt } from "ethers";

export function checksumAddress(address: string): string {
  return getAddress(address);
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  if (a === undefined || a === null || b === undefined || b === null) {
    return false;
  }

  try {
    return checksumAddress(a).toLowerCase() === checksumAddress(b).toLowerCase();
  } catch {
    return false;
  }
}

export function hexToBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(value);
  }

  if (typeof value === "string" && value.length > 0) {
    return toBigInt(value);
  }

  return 0n;
}

export function hexToNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = hexToBigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return Number(parsed);
}

export function formatTokenAmount(raw: string | bigint, decimals?: number): string | undefined {
  if (decimals === undefined) {
    return undefined;
  }

  return normalizeDecimalString(formatUnits(raw, decimals));
}

export function formatNativeEth(rawWei: string | bigint): string {
  return normalizeDecimalString(formatEther(rawWei));
}

export function normalizeDecimalString(value: string): string {
  if (!value.includes(".")) {
    return value;
  }

  return value.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

export function formatRatio(value: number, digits = 10): string {
  return normalizeDecimalString(value.toFixed(digits));
}

export function formatUsd(value: number): string {
  return normalizeDecimalString(value.toFixed(6));
}

export function amountToNumber(raw: string, decimals?: number): number | undefined {
  const formatted = formatTokenAmount(raw, decimals);
  if (formatted === undefined) {
    return undefined;
  }

  const numeric = Number(formatted);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function isMaxUint256(raw: string): boolean {
  return BigInt(raw) === MaxUint256;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  return value;
}

export function getOutputPath(argv = process.argv): string | undefined {
  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0) {
    const value = argv[outIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--out requires a file path");
    }
    return value;
  }

  return process.env.OUTPUT_PATH;
}
