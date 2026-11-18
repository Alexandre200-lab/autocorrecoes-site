import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSuppression, isSuppression } from "../src/patches/antiSuppression.js";

test("detecta supressões conhecidas", () => {
  assert.ok(isSuppression('button.setAttribute("aria-hidden", "true")').length > 0);
  assert.ok(isSuppression(".erro { display: none; }").length > 0);
  assert.ok(isSuppression("// eslint-disable-next-line no-console").length > 0);
  assert.ok(isSuppression("AxeBuilder.disableRules(['color-contrast'])").length > 0);
});

test("nãoFLAG código legítimo", () => {
  assert.deepEqual(isSuppression("button.setAttribute('aria-label', 'Fechar')"), []);
  assert.deepEqual(isSuppression("const visible = !hidden;"), []);
});

test("AST detecta supressão em CSS e JS/TS", () => {
  assert.ok(
    isSuppression(".erro { display: none !important; }", "css-rule").some((r) => r.includes("AST")),
  );
  assert.ok(
    isSuppression("opacity: 0; pointer-events: none;", "css-rule").some((r) => r.includes("AST")),
  );
  assert.ok(
    isSuppression("button.setAttribute('aria-hidden', 'true');", "full-file").some((r) =>
      r.includes("AST"),
    ),
  );
  assert.ok(
    isSuppression("element.hidden = true;", "full-file").some((r) => r.includes("AST")),
  );
});

test("valores legítimos não são confundidos com supressão", () => {
  assert.deepEqual(isSuppression(".erro { opacity: 0.001; }", "css-rule"), []);
  assert.deepEqual(isSuppression("button.setAttribute('aria-label', 'Fechar');", "full-file"), []);
});

test("lança erro ao encontrar supressão", () => {
  assert.throws(() => assertNoSuppression("display:none"), /supressivo/i);
});
