import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { BlockedHostError, safeRequest, validateRedirect } from "../src/security/network.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

test("safeRequest segue redirects e revalida cada destino", async () => {
  const target = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("destino-final");
  });
  const targetPort = await listen(target);
  const origin = createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/` });
    response.end();
  });
  const originPort = await listen(origin);

  const redirects: string[] = [];
  try {
    const result = await safeRequest(`http://127.0.0.1:${originPort}/`, {
      allowPrivateHosts: true,
      onRedirect: (url) => redirects.push(url),
    });
    assert.equal(result.hops, 1);
    assert.equal(result.body, "destino-final");
    assert.equal(redirects.length, 1);
  } finally {
    origin.close();
    target.close();
  }
});

test("redirect para host privado é bloqueado", async () => {
  const result = await validateRedirect("http://127.0.0.1:4310/admin", "https://exemplo.com/").catch(
    (error) => error,
  );
  assert.ok(result instanceof BlockedHostError);
});

test("requisição inicial para host privado é bloqueada por padrão", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  try {
    await assert.rejects(
      () => safeRequest(`http://127.0.0.1:${port}/`),
      /bloqueado por proteção SSRF/i,
    );
  } finally {
    server.close();
  }
});
