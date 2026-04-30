import { z } from "zod";
import { collectPayloadReferenceIds } from "./payload.js";
import type { AuditOutput, AuditPayload } from "./types.js";

export const AuditFindingSchema = z.object({
  type: z.string().min(1),
  severity: z.string().min(1),
  title_ko: z.string().min(1),
  description_ko: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)),
  confidence: z.number().min(0).max(1),
});

export const AuditOutputSchema = z.object({
  risk_level: z.enum(["low", "medium", "high", "critical"]),
  risk_score: z.number().min(0).max(100),
  one_line_summary_ko: z.string().min(1),
  executive_summary_ko: z.string().min(1),
  findings: z.array(AuditFindingSchema),
  benign_explanations_to_check: z.array(z.string()),
  missing_evidence: z.array(z.string()),
  recommended_actions_ko: z.array(z.string()),
  final_assessment_ko: z.string().min(1),
});

export function parseAndValidateAuditOutput(raw: unknown, payload: AuditPayload): AuditOutput {
  const parsed = AuditOutputSchema.parse(raw);
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
