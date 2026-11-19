import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/security/redact.js";

test("redator mascara Bearer/JWT sem aspas e valores nomeados sem aspas", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const bearer = redactSecrets(`Authorization: Bearer ${jwt}`);
  assert.doesNotMatch(bearer, /eyJ/);
  assert.match(bearer, /REDACTED/);

  const opaque = redactSecrets("Authorization: Bearer abcdef1234567890");
  assert.doesNotMatch(opaque, /abcdef1234567890/);

  const named = redactSecrets("token = abcdefgh12345678");
  assert.match(named, /REDACTED/);
  assert.doesNotMatch(named, /abcdefgh12345678/);
});
