import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Deployment {
  network: string;
  chainId: string;
  deployer: string;
  contracts: Record<string, string>;
  transactions: Record<string, string>;
  initialConfig: { finalOwner: string };
}

interface AuditResponse {
  model: string;
  score_version: string;
  overall_risk_score: number;
  overall_severity: string;
  overall_summary: string;
  vulnerabilities: unknown[];
}

const API_URL = process.env.AUDIT_API_URL ?? "http://127.0.0.1:13000";
const DEPLOYMENT_PATH = resolve("escrow-hook/deployments/sepolia-demo.json");

async function postJson<T>(path: string, body: unknown, timeoutMs = 180_000): Promise<{ status: number; data: T | null; raw: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data: T | null = null;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      // leave null
    }
    return { status: res.status, data, raw };
  } finally {
    clearTimeout(timer);
  }
}

function assertAuditShape(label: string, audit: AuditResponse): void {
  const failures: string[] = [];
  if (audit.score_version !== "risk-v1") failures.push(`score_version=${audit.score_version}`);
  if (typeof audit.overall_risk_score !== "number" || audit.overall_risk_score < 0 || audit.overall_risk_score > 100) {
    failures.push(`overall_risk_score=${audit.overall_risk_score}`);
  }
  const allowedSeverities = new Set(["info", "low", "medium", "high", "critical"]);
  if (!allowedSeverities.has(audit.overall_severity)) failures.push(`overall_severity=${audit.overall_severity}`);
  if (typeof audit.overall_summary !== "string" || audit.overall_summary.length === 0) failures.push("overall_summary missing");
  if (!Array.isArray(audit.vulnerabilities)) failures.push("vulnerabilities not array");
  if (typeof audit.model !== "string" || audit.model.length === 0) failures.push("model missing");
  if (failures.length > 0) {
    throw new Error(`[${label}] schema check failed: ${failures.join(", ")}`);
  }
}

async function runCase(label: string, endpoint: string, body: unknown): Promise<AuditResponse> {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===`);
  console.log(`POST ${API_URL}${endpoint} body=${JSON.stringify(body)}`);
  const { status, data, raw } = await postJson<AuditResponse>(endpoint, body);
  const dur = ((Date.now() - t0) / 1000).toFixed(2);
  if (status !== 200) {
    throw new Error(`[${label}] HTTP ${status} (${dur}s): ${raw.slice(0, 500)}`);
  }
  if (!data) {
    throw new Error(`[${label}] non-JSON response: ${raw.slice(0, 500)}`);
  }
  assertAuditShape(label, data);
  console.log(
    `OK (${dur}s) severity=${data.overall_severity} score=${data.overall_risk_score} model=${data.model} vulns=${data.vulnerabilities.length}`,
  );
  console.log(`summary: ${data.overall_summary.slice(0, 200)}`);
  return data;
}

async function checkInvalid400(label: string, endpoint: string, body: unknown): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log(`POST ${API_URL}${endpoint} body=${JSON.stringify(body)}`);
  const { status, raw } = await postJson<unknown>(endpoint, body, 30_000);
  if (status === 200) {
    throw new Error(`[${label}] expected non-200 for invalid input, got 200`);
  }
  console.log(`OK rejected with HTTP ${status}: ${raw.trim().slice(0, 200)}`);
}

async function main(): Promise<void> {
  const deployment = JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8")) as Deployment;
  console.log(`Loaded submodule deployment: chainId=${deployment.chainId} network=${deployment.network}`);
  console.log(`Targeting API at ${API_URL}`);

  const txAegisDeployer = deployment.transactions.aegisDemoDeployer;
  const txDeployDemo = deployment.transactions.deployDemo;
  const deployer = deployment.deployer;

  if (!txAegisDeployer || !txDeployDemo || !deployer) {
    throw new Error("submodule deployment file missing transactions or deployer");
  }

  const results: Array<{ label: string; severity: string; score: number; vulns: number }> = [];

  // Case 1: /audit/from-tx using a real Sepolia deployment tx hash from the submodule.
  const c1 = await runCase("from-tx | aegisDemoDeployer (Sepolia)", "/audit/from-tx", { tx_hash: txAegisDeployer });
  results.push({ label: "from-tx aegisDemoDeployer", severity: c1.overall_severity, score: c1.overall_risk_score, vulns: c1.vulnerabilities.length });

  // Case 2: /audit/subject using deployer address as subject on the deployDemo tx.
  const c2 = await runCase("subject | deployDemo (Sepolia)", "/audit/subject", { tx_hash: txDeployDemo, subject_address: deployer });
  results.push({ label: "subject deployDemo", severity: c2.overall_severity, score: c2.overall_risk_score, vulns: c2.vulnerabilities.length });

  // Case 3: invalid-shape rejection (missing required field).
  await checkInvalid400("reject | missing tx_hash", "/audit/subject", { subject_address: deployer });

  // Case 4: invalid-address rejection.
  await checkInvalid400("reject | bad subject address", "/audit/subject", { tx_hash: txDeployDemo, subject_address: "0xnot-an-address" });

  console.log("\n=== summary ===");
  for (const r of results) {
    console.log(`  ${r.label}: severity=${r.severity} score=${r.score} vulns=${r.vulns}`);
  }
  console.log("\nALL E2E API CASES PASSED");
}

main().catch((err) => {
  console.error(`\nE2E FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
