import assert from "node:assert/strict";
import test from "node:test";
import { applyUnifiedDiff } from "../src/patches/diff.js";

test("aplicador de unified diff substitui linhas e preserva o restante", () => {
  const original = "const a = 1;\nconsole.log('debug');\nconst b = 2;\n";
  const diff = [
    "@@ -1,3 +1,2 @@",
    " const a = 1;",
    "-console.log('debug');",
    " const b = 2;",
  ].join("\n");
  assert.equal(applyUnifiedDiff(original, diff), "const a = 1;\nconst b = 2;\n");
});

test("aplicador rejeita diff sem hunks", () => {
  assert.throws(() => applyUnifiedDiff("a\n", "sem hunk"), /hunks/i);
});
