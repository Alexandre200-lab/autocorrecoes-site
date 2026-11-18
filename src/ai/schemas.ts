import { z } from "zod";

const domain = z.enum(["design", "backend", "code"]);
const severity = z.enum(["P1", "P2", "P3", "P4"]);
const confidence = z.enum(["high", "medium", "low"]);

export const ProposedFindingSchema = z.object({
  domain,
  severity,
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  url: z.string().optional(),
  title: z.string().min(3),
  observedBehavior: z.string().min(3),
  impact: z.string().min(3),
  evidence: z.string().min(1),
  suggestedFix: z.string().min(3),
  confidence,
  checksRun: z.array(z.string()).default([]),
  checksSuggested: z.array(z.string()).default([]),
  uncertainty: z.string().default("Não informado pelo modelo."),
  patch: z
    .object({
      format: z.enum(["unified-diff", "full-file", "css-rule", "config-change"]),
      files: z.array(z.string()).min(1),
      content: z.string().min(1),
      riskNotes: z.array(z.string()).default([]),
      untouchedAssertion: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
});

export const ProposalSchema = z.object({
  findings: z.array(ProposedFindingSchema).default([]),
});

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposedFinding = z.infer<typeof ProposedFindingSchema>;

export const VerificationSchema = z.object({
  valid: z.boolean(),
  reason: z.string().min(5),
  confidence,
  suppressionDetected: z.boolean().default(false),
  severityAdjusted: severity.optional(),
  recommendedStatus: z.enum(["verified", "rejected"]).default("verified"),
});

export type Verification = z.infer<typeof VerificationSchema>;
