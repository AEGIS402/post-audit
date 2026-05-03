export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Direction = "in" | "out";

export interface RawRpcInput {
  chain_id: number;
  tx_hash: string;
  subject_address: string;
  raw_rpc: {
    eth_getTransactionByHash: Record<string, unknown>;
    eth_getTransactionReceipt: Record<string, unknown>;
    eth_getBlockByNumber: Record<string, unknown>;
    eth_call_token_metadata: RawTokenMetadataResult[];
    eth_getCode_results: RawCodeResult[];
  };
}

export interface RawTokenMetadataResult {
  address: string;
  calls?: Record<string, RawEthCallResult>;
  decoded?: {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
}

export interface RawEthCallResult {
  data: string;
  result?: string;
  error?: string;
}

export interface RawCodeResult {
  address: string;
  block_tag?: string;
  code: string;
}

export interface EvidenceItem {
  evidence_id: string;
  source: string;
  data: unknown;
}

export interface TokenMetadata {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface TokenPrice {
  token: string;
  symbol?: string;
  price_usd: string;
  source: string;
}

export interface ExecutionInfo {
  status: "success" | "failed" | "unknown";
  block_number?: number;
  timestamp?: number;
  gas_used?: string;
  effective_gas_price_wei?: string;
  tx_value_eth?: string;
  evidence_refs: string[];
}

export interface DecodedCall {
  function: string;
  method_id: string;
  protocol?: string;
  params: Record<string, unknown>;
  evidence_refs: string[];
}

export interface DecodedEvent {
  event_id: string;
  log_index: number;
  contract: string;
  event_name: "Transfer" | "Approval" | "ProtectedSwapEscrowed" | "EscrowRegistered";
  decoded: Record<string, unknown>;
  evidence_refs: string[];
}

export interface AssetFlow {
  flow_id: string;
  subject: string;
  asset: string;
  token?: string;
  direction: Direction;
  amount: string;
  amount_raw: string;
  amount_human?: string;
  amount_usd?: string;
  counterparty?: string;
  evidence_refs: string[];
}

export interface ApprovalChange {
  approval_id: string;
  owner: string;
  spender: string;
  token: string;
  asset: string;
  amount: string;
  amount_raw: string;
  amount_human?: string;
  is_unlimited: boolean;
  evidence_refs: string[];
}

export interface RuleSignal {
  signal_id: string;
  type: string;
  severity_hint: Severity;
  description: string;
  computed?: Record<string, unknown>;
  evidence_refs: string[];
}

export interface AuditPayload {
  task: "post_transaction_audit";
  chain_id: number;
  tx_hash: string;
  subject_address: string;
  raw_evidence: EvidenceItem[];
  token_metadata: TokenMetadata[];
  price_context: TokenPrice[];
  execution: ExecutionInfo;
  decoded_call?: DecodedCall;
  decoded_events: DecodedEvent[];
  asset_flows: AssetFlow[];
  approval_changes: ApprovalChange[];
  rule_signals: RuleSignal[];
  known_limitations: string[];
}

export interface VulnerabilityEvidence {
  line_start: null;
  line_end: null;
  description: string;
}

export interface AuditVulnerability {
  id: string;
  title: string;
  severity: Severity;
  risk_score: number;
  confidence_score: number;
  impact_score: number;
  exploitability_score: number;
  summary: string;
  remediation: string;
  evidence: VulnerabilityEvidence[];
}

export interface AuditOutput {
  model: string;
  score_version: "risk-v1";
  overall_risk_score: number;
  overall_severity: Severity;
  overall_summary: string;
  vulnerabilities: AuditVulnerability[];
}

export interface BuildPayloadOptions {
  priceOverrides?: Record<string, string | number>;
}
