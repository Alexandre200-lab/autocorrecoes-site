import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedIp } from "../src/security/network.js";
import { redactSecrets, redactWithStats } from "../src/security/redact.js";

test("redator mascara secrets em código e texto", () => {
  const input = [
    'const apiKey = "supersecretvalue123";',
    "PASSWORD=hunter2",
    "Authorization: Bearer sk-abcdefghijklmnop",
    "https://user:pass@example.com/path",
    "-----BEGIN RSA PRIVATE KEY-----\nAAA\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { text, count } = redactWithStats(input);
  assert.ok(count >= 5, `redações: ${count}`);
  assert.doesNotMatch(text, /supersecretvalue123/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(text, /user:pass/);
  assert.doesNotMatch(text, /BEGIN RSA PRIVATE KEY/);
});

test("redator preserva texto sem segredos", () => {
  assert.equal(redactSecrets("const soma = (a, b) => a + b;"), "const soma = (a, b) => a + b;");
});

test("bloqueia IPs privados, loopback e link-local", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});
