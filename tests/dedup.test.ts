import assert from "node:assert/strict";
import test from "node:test";
import { dedupeSignals } from "../src/pipeline/dedup.js";
import type { RawSignal } from "../src/shared/types.js";

const signal = (overrides: Partial<RawSignal> = {}): RawSignal => ({
  domain: "design",
  ruleId: "AXE_COLOR_CONTRAST",
  title: "Contraste",
  message: "baixo",
  severity: "P2",
  url: "https://example.com",
  evidence: "evidência curta",
  ...overrides,
});

test("remove duplicatas por regra + local", () => {
  const result = dedupeSignals([
    signal({ evidence: "curta" }),
    signal({ evidence: "evidência muito mais longa e detalhada" }),
  ]);
  assert.equal(result.length, 1);
  assert.match(result[0].evidence, /muito mais longa/);
});

test("mantém sinais de revisão humana separados", () => {
  const result = dedupeSignals([
    signal({ ruleId: "AXE_INCOMPLETE", metadata: { requiresHuman: true } }),
    signal({ ruleId: "AXE_INCOMPLETE", metadata: { requiresHuman: true } }),
  ]);
  assert.equal(result.length, 2);
});

test("não mescla domínios diferentes", () => {
  const result = dedupeSignals([
    signal(),
    signal({ domain: "backend", ruleId: "AXE_COLOR_CONTRAST" }),
  ]);
  assert.equal(result.length, 2);
});
