import assert from "node:assert/strict";
import test from "node:test";
import { applyUnifiedDiff } from "../src/patches/diff.js";

test("aplica hunk simples com contexto", () => {
  const original = "a\nb\nc\n";
  const diff = "--- a.txt\n+++ b.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
  assert.equal(applyUnifiedDiff(original, diff), "a\nB\nc\n");
});

test("localiza hunk deslocado por mudanças anteriores", () => {
  const original = "intro\n\nfunction greet() {\n  return 'oi';\n}\n";
  const diff = "@@ -4,2 +4,2 @@\n function greet() {\n-  return 'oi';\n+  return 'olá';\n";
  assert.equal(applyUnifiedDiff(original, diff), "intro\n\nfunction greet() {\n  return 'olá';\n}\n");
});

test("rejeita diff sem hunks", () => {
  assert.throws(() => applyUnifiedDiff("a\n", "sem hunk"), /sem hunks/i);
});

test("aplica adição pura", () => {
  const diff = "@@ -0,0 +1,2 @@\n+primeira\n+segunda\n";
  assert.equal(applyUnifiedDiff("", diff), "primeira\nsegunda");
});
