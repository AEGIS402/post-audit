import { z } from "zod";
import { collectPayloadReferenceIds } from "./payload.js";
import type { AuditOutput, AuditPayload, Severity } from "./types.js";

const SeveritySchema = z.enum(["info", "low", "medium", "high", "critical"]);
const ScoreSchema = z.number().min(0).max(100);

export const VulnerabilityEvidenceSchema = z.object({
  line_start: z.null(),
  line_end: z.null(),
  description: z.string().min(1),
}).strict();

export const AuditVulnerabilitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: SeveritySchema,
  risk_score: ScoreSchema,
  confidence_score: ScoreSchema,
  impact_score: ScoreSchema,
  exploitability_score: ScoreSchema,
  summary: z.string().min(1),
  remediation: z.string().min(1),
  evidence: z.array(VulnerabilityEvidenceSchema).min(1),
}).strict();

export const AuditOutputSchema = z.object({
  model: z.string().min(1),
  score_version: z.string().min(1),
  overall_risk_score: ScoreSchema,
  overall_severity: SeveritySchema,
  overall_summary: z.string().min(1),
  vulnerabilities: z.array(AuditVulnerabilitySchema),
}).strict();

export function parseAndValidateAuditOutput(raw: unknown, payload: AuditPayload, model = "unknown"): AuditOutput {
  const parsed = normalizeAuditOutput(AuditOutputSchema.parse(raw), model);
  const allowedRefs = collectPayloadReferenceIds(payload);
  const vulnerabilities = parsed.vulnerabilities
    .map((vulnerability) => ({
      ...vulnerability,
      evidence: vulnerability.evidence.filter((evidence) => evidenceMentionsKnownRef(evidence.description, allowedRefs)),
    }))
    .filter((vulnerability) => vulnerability.evidence.length > 0);

  return {
    ...parsed,
    vulnerabilities,
  };
}

export function parseModelJson(content: string): unknown {
  return JSON.parse(content);
}

function normalizeAuditOutput(output: z.infer<typeof AuditOutputSchema>, model: string): AuditOutput {
  return {
    model: toAscii(model),
    score_version: "risk-v1",
    overall_risk_score: output.overall_risk_score,
    overall_severity: severityForScore(output.overall_risk_score),
    overall_summary: toAscii(output.overall_summary),
    vulnerabilities: output.vulnerabilities.map((vulnerability) => ({
      id: toAscii(vulnerability.id),
      title: toAscii(vulnerability.title),
      severity: severityForScore(vulnerability.risk_score),
      risk_score: vulnerability.risk_score,
      confidence_score: vulnerability.confidence_score,
      impact_score: vulnerability.impact_score,
      exploitability_score: vulnerability.exploitability_score,
      summary: toAscii(vulnerability.summary),
      remediation: toAscii(vulnerability.remediation),
      evidence: vulnerability.evidence.map((evidence) => ({
        line_start: evidence.line_start,
        line_end: evidence.line_end,
        description: toAscii(evidence.description),
      })),
    })),
  };
}

function severityForScore(score: number): Severity {
  if (score < 20) {
    return "info";
  }

  if (score < 45) {
    return "low";
  }

  if (score < 75) {
    return "medium";
  }

  if (score < 90) {
    return "high";
  }

  return "critical";
}

function evidenceMentionsKnownRef(description: string, allowedRefs: Set<string>): boolean {
  for (const ref of allowedRefs) {
    if (description.includes(ref)) {
      return true;
    }
  }

  return false;
}

function toAscii(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/gu, "-")
    .replace(/\u00a0/gu, " ")
    .replace(/\u2248/gu, "approximately")
    .replace(/\u2264/gu, "<=")
    .replace(/\u2265/gu, ">=")
    .replace(/\u2192/gu, "->")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\x20-\x7e]/gu, "");
}
