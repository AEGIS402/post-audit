import { aegisAdapterInterface, aegisEscrowInterface, erc20Interface, uniswapV3RouterInterface } from "./abis.js";
import { decodeTokenMetadata, tokenMetadataMap } from "./metadata.js";
import { findTokenPrice, resolveTokenPrices } from "./prices.js";
import type {
  ApprovalChange,
  AssetFlow,
  AuditPayload,
  BuildPayloadOptions,
  DecodedCall,
  DecodedEvent,
  EvidenceItem,
  ExecutionInfo,
  RawRpcInput,
  RuleSignal,
  TokenMetadata,
  TokenPrice,
} from "./types.js";
import {
  amountToNumber,
  checksumAddress,
  formatNativeEth,
  formatRatio,
  formatTokenAmount,
  formatUsd,
  hexToBigInt,
  hexToNumber,
  isMaxUint256,
  sameAddress,
} from "./utils.js";

export function buildAuditPayload(rawInput: RawRpcInput, options: BuildPayloadOptions = {}): AuditPayload {
  const rawEvidence = buildRawEvidence(rawInput);
  const tokenMetadata = decodeTokenMetadata(rawInput.raw_rpc.eth_call_token_metadata);
  const prices = resolveTokenPrices(tokenMetadata, options.priceOverrides);
  const execution = buildExecution(rawInput);
  const decodedCall = decodeCall(rawInput, tokenMetadata);
  const decodedEvents = decodeEvents(rawInput, tokenMetadata);
  const assetFlows = buildAssetFlows(rawInput, decodedEvents, tokenMetadata, prices);
  const approvalChanges = buildApprovalChanges(rawInput, decodedEvents, tokenMetadata);
  const ruleSignals = buildRuleSignals(decodedCall, decodedEvents, assetFlows, approvalChanges, execution);

  return {
    task: "post_transaction_audit",
    chain_id: rawInput.chain_id,
    tx_hash: rawInput.tx_hash,
    subject_address: checksumAddress(rawInput.subject_address),
    raw_evidence: rawEvidence,
    token_metadata: tokenMetadata,
    price_context: prices,
    execution,
    decoded_call: decodedCall,
    decoded_events: decodedEvents,
    asset_flows: assetFlows,
    approval_changes: approvalChanges,
    rule_signals: ruleSignals,
    known_limitations: [
      "debug_traceTransaction was not used.",
      "Full internal call tree is unavailable.",
      "Full state diff is unavailable.",
      "External labels and phishing/compliance lists were not used.",
    ],
  };
}

export function collectPayloadReferenceIds(payload: AuditPayload): Set<string> {
  const refs = new Set<string>();

  for (const evidence of payload.raw_evidence) {
    refs.add(evidence.evidence_id);
  }
  for (const event of payload.decoded_events) {
    refs.add(event.event_id);
  }
  for (const flow of payload.asset_flows) {
    refs.add(flow.flow_id);
  }
  for (const approval of payload.approval_changes) {
    refs.add(approval.approval_id);
  }
  for (const signal of payload.rule_signals) {
    refs.add(signal.signal_id);
  }

  return refs;
}

function buildRawEvidence(rawInput: RawRpcInput): EvidenceItem[] {
  const receipt = rawInput.raw_rpc.eth_getTransactionReceipt;
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];

  const evidence: EvidenceItem[] = [
    {
      evidence_id: "tx.raw",
      source: "eth_getTransactionByHash",
      data: rawInput.raw_rpc.eth_getTransactionByHash,
    },
    {
      evidence_id: "tx.raw.input",
      source: "eth_getTransactionByHash.input",
      data: rawInput.raw_rpc.eth_getTransactionByHash.input,
    },
    {
      evidence_id: "receipt.raw",
      source: "eth_getTransactionReceipt",
      data: rawInput.raw_rpc.eth_getTransactionReceipt,
    },
    {
      evidence_id: "block.raw",
      source: "eth_getBlockByNumber",
      data: rawInput.raw_rpc.eth_getBlockByNumber,
    },
  ];

  logs.forEach((log, index) => {
    evidence.push({
      evidence_id: `receipt.raw.logs[${index}]`,
      source: "eth_getTransactionReceipt.logs",
      data: log,
    });
  });

  rawInput.raw_rpc.eth_call_token_metadata.forEach((metadata, index) => {
    evidence.push({
      evidence_id: `token_metadata.raw#${index}`,
      source: "eth_call_token_metadata",
      data: metadata,
    });
  });

  rawInput.raw_rpc.eth_getCode_results.forEach((code, index) => {
    evidence.push({
      evidence_id: `code.raw#${index}`,
      source: "eth_getCode",
      data: code,
    });
  });

  return evidence;
}

function buildExecution(rawInput: RawRpcInput): ExecutionInfo {
  const tx = rawInput.raw_rpc.eth_getTransactionByHash;
  const receipt = rawInput.raw_rpc.eth_getTransactionReceipt;
  const block = rawInput.raw_rpc.eth_getBlockByNumber;
  const statusRaw = receipt.status;
  const status = statusRaw === "0x1" ? "success" : statusRaw === "0x0" ? "failed" : "unknown";

  return {
    status,
    block_number: hexToNumber(receipt.blockNumber),
    timestamp: hexToNumber(block.timestamp),
    gas_used: hexToBigInt(receipt.gasUsed).toString(),
    effective_gas_price_wei:
      receipt.effectiveGasPrice === undefined ? undefined : hexToBigInt(receipt.effectiveGasPrice).toString(),
    tx_value_eth: formatNativeEth(hexToBigInt(tx.value)),
    evidence_refs: ["tx.raw", "receipt.raw", "block.raw"],
  };
}

function decodeCall(rawInput: RawRpcInput, tokenMetadata: TokenMetadata[]): DecodedCall | undefined {
  const tx = rawInput.raw_rpc.eth_getTransactionByHash;
  const input = typeof tx.input === "string" ? tx.input : undefined;
  if (input === undefined || input === "0x" || input.length < 10) {
    return undefined;
  }

  const methodId = input.slice(0, 10);
  const value = tx.value === undefined ? 0 : hexToBigInt(tx.value);
  const tokens = tokenMetadataMap(tokenMetadata);

  for (const iface of [erc20Interface, uniswapV3RouterInterface, aegisAdapterInterface]) {
    try {
      const parsed = iface.parseTransaction({ data: input, value });
      if (parsed === null) {
        continue;
      }

      if (["transfer", "approve", "transferFrom"].includes(parsed.name)) {
        return decodeErc20Call(parsed.name, parsed.args, methodId, tx.to, tokens);
      }

      if (parsed.name === "exactInputSingle") {
        return decodeExactInputSingle(parsed.args[0], methodId, tokens);
      }

      if (parsed.name === "protectedExactInputSingle") {
        return decodeProtectedExactInputSingle(parsed.args[0], methodId, tokens);
      }
    } catch {
      // Try the next ABI.
    }
  }

  return {
    function: "unknown",
    method_id: methodId,
    params: {},
    evidence_refs: ["tx.raw.input"],
  };
}

function decodeErc20Call(
  functionName: string,
  args: unknown[],
  methodId: string,
  tokenAddressRaw: unknown,
  tokens: Map<string, TokenMetadata>,
): DecodedCall {
  const token = typeof tokenAddressRaw === "string" ? checksumAddress(tokenAddressRaw) : undefined;
  const metadata = token === undefined ? undefined : tokens.get(token.toLowerCase());
  const asset = metadata?.symbol ?? token ?? "UNKNOWN";
  const decimals = metadata?.decimals;

  if (functionName === "transfer") {
    const to = checksumAddress(String(args[0]));
    const valueRaw = BigInt(String(args[1])).toString();
    const value = formatTokenAmount(valueRaw, decimals);

    return {
      function: "transfer",
      method_id: methodId,
      params: {
        token,
        asset,
        to,
        value_raw: valueRaw,
        value_human: value === undefined ? undefined : `${value} ${asset}`,
      },
      evidence_refs: ["tx.raw.input"],
    };
  }

  if (functionName === "approve") {
    const spender = checksumAddress(String(args[0]));
    const valueRaw = BigInt(String(args[1])).toString();
    const value = formatTokenAmount(valueRaw, decimals);

    return {
      function: "approve",
      method_id: methodId,
      params: {
        token,
        asset,
        spender,
        value_raw: valueRaw,
        value_human: value === undefined ? undefined : `${value} ${asset}`,
        is_unlimited: isMaxUint256(valueRaw),
      },
      evidence_refs: ["tx.raw.input"],
    };
  }

  const from = checksumAddress(String(args[0]));
  const to = checksumAddress(String(args[1]));
  const valueRaw = BigInt(String(args[2])).toString();
  const value = formatTokenAmount(valueRaw, decimals);

  return {
    function: "transferFrom",
    method_id: methodId,
    params: {
      token,
      asset,
      from,
      to,
      value_raw: valueRaw,
      value_human: value === undefined ? undefined : `${value} ${asset}`,
    },
    evidence_refs: ["tx.raw.input"],
  };
}

function decodeProtectedExactInputSingle(
  request: Record<string, unknown>,
  methodId: string,
  tokens: Map<string, TokenMetadata>,
): DecodedCall {
  const key = (request.key ?? {}) as Record<string, unknown>;
  const zeroForOne = Boolean(request.zeroForOne);
  const currency0 = checksumAddress(String(key.currency0));
  const currency1 = checksumAddress(String(key.currency1));
  const inputToken = zeroForOne ? currency0 : currency1;
  const outputToken = zeroForOne ? currency1 : currency0;
  const inputMetadata = tokens.get(inputToken.toLowerCase());
  const outputMetadata = tokens.get(outputToken.toLowerCase());
  const inputAsset = inputMetadata?.symbol ?? inputToken;
  const outputAsset = outputMetadata?.symbol ?? outputToken;
  const amountInRaw = BigInt(String(request.amountIn)).toString();
  const expectedOutputRaw = BigInt(String(request.expectedOutput)).toString();
  const amountInHuman = formatTokenAmount(amountInRaw, inputMetadata?.decimals);
  const expectedOutputHuman = formatTokenAmount(expectedOutputRaw, outputMetadata?.decimals);

  return {
    function: "protectedExactInputSingle",
    method_id: methodId,
    protocol: "AEGIS Protected Swap Adapter (Uniswap v4)",
    params: {
      tradeId: String(request.tradeId),
      settlementRecipient: checksumAddress(String(request.settlementRecipient)),
      tokenIn: inputToken,
      tokenOut: outputToken,
      fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing),
      hooks: checksumAddress(String(key.hooks)),
      zeroForOne,
      amountIn_raw: amountInRaw,
      amountIn_human: amountInHuman === undefined ? undefined : `${amountInHuman} ${inputAsset}`,
      expectedOutput_raw: expectedOutputRaw,
      expectedOutput_human: expectedOutputHuman === undefined ? undefined : `${expectedOutputHuman} ${outputAsset}`,
      sqrtPriceLimitX96: BigInt(String(request.sqrtPriceLimitX96)).toString(),
    },
    evidence_refs: ["tx.raw.input"],
  };
}

function decodeExactInputSingle(params: Record<string, unknown>, methodId: string, tokens: Map<string, TokenMetadata>): DecodedCall {
  const tokenIn = checksumAddress(String(params.tokenIn));
  const tokenOut = checksumAddress(String(params.tokenOut));
  const tokenInMetadata = tokens.get(tokenIn.toLowerCase());
  const tokenOutMetadata = tokens.get(tokenOut.toLowerCase());
  const tokenInAsset = tokenInMetadata?.symbol ?? tokenIn;
  const tokenOutAsset = tokenOutMetadata?.symbol ?? tokenOut;
  const amountInRaw = BigInt(String(params.amountIn)).toString();
  const amountOutMinimumRaw = BigInt(String(params.amountOutMinimum)).toString();
  const amountIn = formatTokenAmount(amountInRaw, tokenInMetadata?.decimals);
  const amountOutMinimum = formatTokenAmount(amountOutMinimumRaw, tokenOutMetadata?.decimals);

  return {
    function: "exactInputSingle",
    method_id: methodId,
    protocol: "Uniswap V3 Router",
    params: {
      tokenIn,
      tokenOut,
      fee: Number(params.fee),
      recipient: checksumAddress(String(params.recipient)),
      deadline: BigInt(String(params.deadline)).toString(),
      amountIn_raw: amountInRaw,
      amountIn_human: amountIn === undefined ? undefined : `${amountIn} ${tokenInAsset}`,
      amountOutMinimum_raw: amountOutMinimumRaw,
      amountOutMinimum_human: amountOutMinimum === undefined ? undefined : `${amountOutMinimum} ${tokenOutAsset}`,
      sqrtPriceLimitX96: BigInt(String(params.sqrtPriceLimitX96)).toString(),
    },
    evidence_refs: ["tx.raw.input"],
  };
}

function decodeEvents(rawInput: RawRpcInput, tokenMetadata: TokenMetadata[]): DecodedEvent[] {
  const receipt = rawInput.raw_rpc.eth_getTransactionReceipt;
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const tokens = tokenMetadataMap(tokenMetadata);
  const decodedEvents: DecodedEvent[] = [];

  logs.forEach((log, index) => {
    if (log === null || typeof log !== "object") {
      return;
    }

    const logRecord = log as Record<string, unknown>;
    const topics = Array.isArray(logRecord.topics) ? (logRecord.topics as string[]) : [];
    const data = typeof logRecord.data === "string" ? logRecord.data : "0x";
    const address = typeof logRecord.address === "string" ? checksumAddress(logRecord.address) : undefined;
    if (address === undefined) {
      return;
    }

    try {
      const escrowParsed = aegisEscrowInterface.parseLog({ topics, data });
      if (escrowParsed !== null) {
        if (escrowParsed.name === "ProtectedSwapEscrowed") {
          const inputToken = checksumAddress(String(escrowParsed.args.inputToken));
          const outputToken = checksumAddress(String(escrowParsed.args.outputToken));
          const inputMeta = tokens.get(inputToken.toLowerCase());
          const outputMeta = tokens.get(outputToken.toLowerCase());
          const inputAsset = inputMeta?.symbol ?? inputToken;
          const outputAsset = outputMeta?.symbol ?? outputToken;
          const inputAmountRaw = BigInt(String(escrowParsed.args.inputAmount)).toString();
          const outputAmountRaw = BigInt(String(escrowParsed.args.outputAmount)).toString();
          const expectedOutputRaw = BigInt(String(escrowParsed.args.expectedOutput)).toString();
          const inputAmountHuman = formatTokenAmount(inputAmountRaw, inputMeta?.decimals);
          const outputAmountHuman = formatTokenAmount(outputAmountRaw, outputMeta?.decimals);
          const expectedOutputHuman = formatTokenAmount(expectedOutputRaw, outputMeta?.decimals);
          const outputAmountNumber = amountToNumber(outputAmountRaw, outputMeta?.decimals);
          const expectedOutputNumber = amountToNumber(expectedOutputRaw, outputMeta?.decimals);
          let outputVsExpectedRatio: string | undefined;
          let outputShortfallPct: string | undefined;
          if (
            outputAmountNumber !== undefined &&
            expectedOutputNumber !== undefined &&
            expectedOutputNumber > 0
          ) {
            const ratio = outputAmountNumber / expectedOutputNumber;
            outputVsExpectedRatio = formatRatio(ratio);
            outputShortfallPct = `${formatRatio((1 - ratio) * 100, 2)}%`;
          }
          decodedEvents.push({
            event_id: `log#${index}`,
            log_index: index,
            contract: address,
            event_name: "ProtectedSwapEscrowed",
            decoded: {
              trade_id: String(escrowParsed.args.tradeId),
              user: checksumAddress(String(escrowParsed.args.user)),
              settlement_recipient: checksumAddress(String(escrowParsed.args.settlementRecipient)),
              input_token: inputToken,
              input_asset: inputAsset,
              input_amount_raw: inputAmountRaw,
              input_amount_human: inputAmountHuman === undefined ? undefined : `${inputAmountHuman} ${inputAsset}`,
              output_token: outputToken,
              output_asset: outputAsset,
              output_amount_raw: outputAmountRaw,
              output_amount_human: outputAmountHuman === undefined ? undefined : `${outputAmountHuman} ${outputAsset}`,
              expected_output_raw: expectedOutputRaw,
              expected_output_human:
                expectedOutputHuman === undefined ? undefined : `${expectedOutputHuman} ${outputAsset}`,
              output_vs_expected_ratio: outputVsExpectedRatio,
              output_shortfall_pct: outputShortfallPct,
            },
            evidence_refs: [`receipt.raw.logs[${index}]`],
          });
          return;
        }
        if (escrowParsed.name === "EscrowRegistered") {
          decodedEvents.push({
            event_id: `log#${index}`,
            log_index: index,
            contract: address,
            event_name: "EscrowRegistered",
            decoded: {
              escrow_id: String(escrowParsed.args.escrowId),
              subject: checksumAddress(String(escrowParsed.args.subject)),
              beneficiary: checksumAddress(String(escrowParsed.args.beneficiary)),
              policy_hash: String(escrowParsed.args.policyHash),
            },
            evidence_refs: [`receipt.raw.logs[${index}]`],
          });
          return;
        }
      }
    } catch {
      // Not an escrow event; fall through.
    }

    try {
      const parsed = erc20Interface.parseLog({ topics, data });
      if (parsed === null || (parsed.name !== "Transfer" && parsed.name !== "Approval")) {
        return;
      }

      const metadata = tokens.get(address.toLowerCase());
      const asset = metadata?.symbol ?? address;
      const decimals = metadata?.decimals;

      if (parsed.name === "Transfer") {
        const valueRaw = BigInt(String(parsed.args.value)).toString();
        const value = formatTokenAmount(valueRaw, decimals);
        decodedEvents.push({
          event_id: `log#${index}`,
          log_index: index,
          contract: address,
          event_name: "Transfer",
          decoded: {
            from: checksumAddress(String(parsed.args.from)),
            to: checksumAddress(String(parsed.args.to)),
            value_raw: valueRaw,
            value_human: value === undefined ? undefined : `${value} ${asset}`,
          },
          evidence_refs: [`receipt.raw.logs[${index}]`],
        });
        return;
      }

      const valueRaw = BigInt(String(parsed.args.value)).toString();
      const value = formatTokenAmount(valueRaw, decimals);
      decodedEvents.push({
        event_id: `log#${index}`,
        log_index: index,
        contract: address,
        event_name: "Approval",
        decoded: {
          owner: checksumAddress(String(parsed.args.owner)),
          spender: checksumAddress(String(parsed.args.spender)),
          value_raw: valueRaw,
          value_human: value === undefined ? undefined : `${value} ${asset}`,
          is_unlimited: isMaxUint256(valueRaw),
        },
        evidence_refs: [`receipt.raw.logs[${index}]`],
      });
    } catch {
      // Non-ERC20 logs are outside v1 scope.
    }
  });

  return decodedEvents;
}

function buildAssetFlows(
  rawInput: RawRpcInput,
  events: DecodedEvent[],
  tokenMetadata: TokenMetadata[],
  prices: TokenPrice[],
): AssetFlow[] {
  const flows: AssetFlow[] = [];
  const subject = checksumAddress(rawInput.subject_address);
  const tokens = tokenMetadataMap(tokenMetadata);

  for (const event of events) {
    if (event.event_name !== "Transfer") {
      continue;
    }

    const from = String(event.decoded.from);
    const to = String(event.decoded.to);
    const rawAmount = String(event.decoded.value_raw);
    const direction = sameAddress(from, subject) ? "out" : sameAddress(to, subject) ? "in" : undefined;
    if (direction === undefined) {
      continue;
    }

    const metadata = tokens.get(event.contract.toLowerCase());
    const amount = formatTokenAmount(rawAmount, metadata?.decimals) ?? rawAmount;
    const asset = metadata?.symbol ?? event.contract;
    const price = findTokenPrice(prices, event.contract);
    const amountNumber = amountToNumber(rawAmount, metadata?.decimals);
    const amountUsd = amountNumber !== undefined && price !== undefined ? formatUsd(amountNumber * Number(price.price_usd)) : undefined;

    flows.push({
      flow_id: `flow#${flows.length}`,
      subject,
      asset,
      token: event.contract,
      direction,
      amount,
      amount_raw: rawAmount,
      amount_human: `${amount} ${asset}`,
      amount_usd: amountUsd,
      counterparty: direction === "out" ? to : from,
      evidence_refs: [event.event_id],
    });
  }

  const nativeFlow = buildNativeFlow(rawInput);
  if (nativeFlow !== undefined) {
    nativeFlow.flow_id = `flow#${flows.length}`;
    flows.push(nativeFlow);
  }

  return flows;
}

function buildNativeFlow(rawInput: RawRpcInput): AssetFlow | undefined {
  const tx = rawInput.raw_rpc.eth_getTransactionByHash;
  const valueRaw = hexToBigInt(tx.value).toString();
  if (valueRaw === "0") {
    return undefined;
  }

  const subject = checksumAddress(rawInput.subject_address);
  const from = typeof tx.from === "string" ? checksumAddress(tx.from) : undefined;
  const to = typeof tx.to === "string" ? checksumAddress(tx.to) : undefined;
  const direction = sameAddress(from, subject) ? "out" : sameAddress(to, subject) ? "in" : undefined;
  if (direction === undefined) {
    return undefined;
  }

  const amount = formatNativeEth(valueRaw);
  return {
    flow_id: "flow#pending",
    subject,
    asset: "ETH",
    direction,
    amount,
    amount_raw: valueRaw,
    amount_human: `${amount} ETH`,
    counterparty: direction === "out" ? to : from,
    evidence_refs: ["tx.raw"],
  };
}

function buildApprovalChanges(
  rawInput: RawRpcInput,
  events: DecodedEvent[],
  tokenMetadata: TokenMetadata[],
): ApprovalChange[] {
  const subject = checksumAddress(rawInput.subject_address);
  const tokens = tokenMetadataMap(tokenMetadata);
  const approvals: ApprovalChange[] = [];

  for (const event of events) {
    if (event.event_name !== "Approval" || !sameAddress(String(event.decoded.owner), subject)) {
      continue;
    }

    const metadata = tokens.get(event.contract.toLowerCase());
    const amountRaw = String(event.decoded.value_raw);
    const amount = formatTokenAmount(amountRaw, metadata?.decimals) ?? amountRaw;
    const asset = metadata?.symbol ?? event.contract;

    approvals.push({
      approval_id: `approval#${approvals.length}`,
      owner: subject,
      spender: checksumAddress(String(event.decoded.spender)),
      token: event.contract,
      asset,
      amount,
      amount_raw: amountRaw,
      amount_human: `${amount} ${asset}`,
      is_unlimited: isMaxUint256(amountRaw),
      evidence_refs: [event.event_id],
    });
  }

  return approvals;
}

function buildRuleSignals(
  decodedCall: DecodedCall | undefined,
  events: DecodedEvent[],
  flows: AssetFlow[],
  approvals: ApprovalChange[],
  execution: ExecutionInfo,
): RuleSignal[] {
  const signals: RuleSignal[] = [];

  if (execution.status === "failed") {
    signals.push({
      signal_id: `sig#${signals.length}`,
      type: "transaction_failed",
      severity_hint: "medium",
      description: "Transaction receipt status is failed.",
      evidence_refs: ["receipt.raw"],
    });
  }

  if (decodedCall?.function === "transfer" && flows.length === 1 && approvals.length === 0) {
    signals.push({
      signal_id: `sig#${signals.length}`,
      type: "simple_erc20_transfer",
      severity_hint: "info",
      description: `Subject sent or received ${flows[0].amount_human ?? flows[0].amount} in a single ERC20 transfer.`,
      evidence_refs: [flows[0].flow_id],
    });
  }

  for (const approval of approvals) {
    signals.push({
      signal_id: `sig#${signals.length}`,
      type: approval.is_unlimited ? "unlimited_erc20_approval" : "erc20_approval_change",
      severity_hint: approval.is_unlimited ? "high" : "medium",
      description: approval.is_unlimited
        ? `Subject granted unlimited ${approval.asset} allowance to ${approval.spender}.`
        : `Subject set ${approval.amount_human ?? approval.amount} allowance for ${approval.spender}.`,
      computed: {
        spender: approval.spender,
        token: approval.token,
        amount_raw: approval.amount_raw,
        is_unlimited: approval.is_unlimited,
      },
      evidence_refs: [approval.approval_id],
    });
  }

  addSwapSignals(signals, decodedCall, flows);
  addProtectedSwapShortfallSignal(signals, events);

  return signals;
}

function addProtectedSwapShortfallSignal(signals: RuleSignal[], events: DecodedEvent[]): void {
  for (const event of events) {
    if (event.event_name !== "ProtectedSwapEscrowed") {
      continue;
    }
    const outputRaw = String(event.decoded.output_amount_raw ?? "0");
    const expectedRaw = String(event.decoded.expected_output_raw ?? "0");
    const outputBig = BigInt(outputRaw);
    const expectedBig = BigInt(expectedRaw);
    if (expectedBig === 0n) {
      // User did not assert an expected output; nothing to compare against.
      continue;
    }
    if (outputBig >= expectedBig) {
      // Met or exceeded user expectation; no shortfall.
      continue;
    }

    const shortfallBig = expectedBig - outputBig;
    const shortfallPctNumber = Number((shortfallBig * 10000n) / expectedBig) / 100;
    let severityHint: "medium" | "high" | "critical";
    if (shortfallPctNumber >= 30) {
      severityHint = "critical";
    } else if (shortfallPctNumber >= 15) {
      severityHint = "high";
    } else if (shortfallPctNumber >= 5) {
      severityHint = "medium";
    } else {
      // Within normal slippage tolerance.
      continue;
    }

    signals.push({
      signal_id: `sig#${signals.length}`,
      type: "protected_swap_output_shortfall",
      severity_hint: severityHint,
      description:
        `AEGIS protected swap escrow output is ${event.decoded.output_amount_human ?? outputRaw} ` +
        `against user-stated expected output ${event.decoded.expected_output_human ?? expectedRaw} ` +
        `(${formatRatio(shortfallPctNumber, 2)}% shortfall). ` +
        "A shortfall this large versus the user's own expected output is a strong indicator of sandwich, MEV, or other adversarial price impact on the protected swap.",
      computed: {
        output_amount_raw: outputRaw,
        expected_output_raw: expectedRaw,
        shortfall_raw: shortfallBig.toString(),
        shortfall_pct: `${formatRatio(shortfallPctNumber, 2)}%`,
        output_vs_expected_ratio: event.decoded.output_vs_expected_ratio ?? undefined,
      },
      evidence_refs: [event.event_id],
    });
  }
}

function addSwapSignals(signals: RuleSignal[], decodedCall: DecodedCall | undefined, flows: AssetFlow[]): void {
  const outflows = flows.filter((flow) => flow.direction === "out" && flow.amount_usd !== undefined);
  const inflows = flows.filter((flow) => flow.direction === "in" && flow.amount_usd !== undefined);

  const totalOutUsd = sumUsd(outflows);
  const totalInUsd = sumUsd(inflows);

  if (totalOutUsd > 0 && totalInUsd >= 0 && outflows.length > 0 && inflows.length > 0) {
    const ratio = totalInUsd / totalOutUsd;
    if (ratio < 0.5) {
      signals.push({
        signal_id: `sig#${signals.length}`,
        type: "extreme_value_imbalance",
        severity_hint: "critical",
        description: `Subject sent approximately ${formatUsd(totalOutUsd)} USD and received approximately ${formatUsd(totalInUsd)} USD.`,
        computed: {
          output_input_ratio: formatRatio(ratio),
          approx_loss_vs_input: `${formatRatio((1 - ratio) * 100, 2)}%`,
          input_value_usd: formatUsd(totalOutUsd),
          output_value_usd: formatUsd(totalInUsd),
        },
        evidence_refs: [...outflows, ...inflows].map((flow) => flow.flow_id),
      });
    }
  }

  if (decodedCall?.function === "exactInputSingle" && decodedCall.params.amountOutMinimum_raw === "0") {
    signals.push({
      signal_id: `sig#${signals.length}`,
      type: "missing_slippage_protection",
      severity_hint: "critical",
      description: "Decoded exactInputSingle calldata has amountOutMinimum set to zero.",
      computed: {
        amountOutMinimum: decodedCall.params.amountOutMinimum_human ?? decodedCall.params.amountOutMinimum_raw,
      },
      evidence_refs: ["tx.raw.input"],
    });
  }
}

function sumUsd(flows: AssetFlow[]): number {
  return flows.reduce((total, flow) => total + Number(flow.amount_usd ?? "0"), 0);
}
