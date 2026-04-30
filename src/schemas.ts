import { z } from "zod";
import { collectPayloadReferenceIds } from "./payload.js";
import type { AuditOutput, AuditPayload, RiskLevel } from "./types.js";

export const AuditFindingSchema = z.object({
  type: z.string().min(1),
  severity: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
});

export const AuditOutputSchema = z.object({
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  risk_score: z.number().min(0).max(100),
  one_line_summary: z.string().min(1),
  executive_summary: z.string().min(1),
  findings: z.array(AuditFindingSchema),
  benign_explanations_to_check: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  recommended_actions: z.array(z.string()),
  final_assessment: z.string().min(1),
});

export function parseAndValidateAuditOutput(raw: unknown, payload: AuditPayload): AuditOutput {
  const parsed = normalizeAuditOutput(AuditOutputSchema.parse(raw));
  const allowedRefs = collectPayloadReferenceIds(payload);
  const findings = parsed.findings.filter((finding) => {
    return finding.evidence_refs.length > 0 && finding.evidence_refs.every((ref) => allowedRefs.has(ref));
  });

  return {
    ...parsed,
    findings,
  };
}

export function parseModelJson(content: string): unknown {
  return JSON.parse(content);
}

function normalizeAuditOutput(output: AuditOutput): AuditOutput {
  return {
    ...output,
    risk_level: riskLevelForScore(output.risk_score),
    one_line_summary: toAscii(output.one_line_summary),
    executive_summary: toAscii(output.executive_summary),
    findings: output.findings.map((finding) => ({
      ...finding,
      type: toAscii(finding.type),
      severity: toAscii(finding.severity),
      title: toAscii(finding.title),
      description: toAscii(finding.description),
      evidence_refs: finding.evidence_refs.map(toAscii),
    })),
    benign_explanations_to_check: output.benign_explanations_to_check.map(toAscii),
    missing_evidence: output.missing_evidence.map(toAscii),
    recommended_actions: output.recommended_actions.map(toAscii),
    final_assessment: toAscii(output.final_assessment),
  };
}

function riskLevelForScore(score: number): RiskLevel {
  if (score < 25) {
    return "low";
  }

  if (score < 60) {
    return "medium";
  }

  if (score < 85) {
    return "high";
  }

  return "critical";
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
