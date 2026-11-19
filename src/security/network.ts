import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * Proteção SSRF completa:
 *  - valida o host inicial e TODOS os redirects;
 *  - fixa (pina) o IP resolvido na conexão, eliminando DNS rebinding;
 *  - bloqueia loopback, privados, link-local, multicast e IPv6 ULA.
 */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(ip);
  const network = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Faixas IPv6 especiais que podem tunelar para IPv4 interno. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7));
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 (ULA)
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 (link-local)
  if (/^fec[0-9a-f]/.test(lower)) return true; // fec0::/10 (site-local)
  if (/^ff/.test(lower)) return true; // ff00::/8 (multicast)
  if (/^2002:/.test(lower)) return true; // 2002::/16 (6to4)
  if (lower.startsWith("64:ff9b:")) return true; // 64:ff9b::/96 (NAT64)
  if (/^2001:0:/.test(lower)) return true; // 2001::/32 (Teredo)
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  const lower = clean.toLowerCase();
  if (lower.startsWith("::ffff:")) return isBlockedIp(lower.slice(7));
  if (isBlockedIpv6(lower)) return true;
  // Política conservadora desta versão: todo IPv6 é bloqueado. A rotina acima
  // documenta as faixas especiais (6to4, NAT64, Teredo) que jamais devem ser
  // liberadas se esse quadro for alterado.
  if (isIP(clean) !== 4) return isIP(clean) === 6;
  return BLOCKED_V4.some(([base, bits]) => inRange(clean, base, bits));
}

export class BlockedHostError extends Error {
  constructor(host: string, ip: string) {
    super(
      `Host bloqueado por proteção SSRF: ${host} (${ip}). Use --allow-private-hosts para auditorias locais.`,
    );
    this.name = "BlockedHostError";
  }
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: number;
}

export async function resolveSafeTarget(
  target: string,
  allowPrivateHosts = false,
): Promise<ResolvedTarget> {
  const value = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Protocolo não suportado: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  if (addresses.length === 0) throw new Error(`Host sem resolução DNS: ${host}`);

  if (!allowPrivateHosts) {
    const blocked = addresses.find((entry) => isBlockedIp(entry.address));
    if (blocked) throw new BlockedHostError(host, blocked.address);
  }
  const chosen = addresses[0];
  return { url, address: chosen.address, family: chosen.family };
}

/** Compatibilidade com chamadas anteriores. */
export async function assertPublicUrl(
  target: string,
  allowPrivateHosts = false,
): Promise<URL> {
  return (await resolveSafeTarget(target, allowPrivateHosts)).url;
}

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowPrivateHosts?: boolean;
  maxRedirects?: number;
  maxBytes?: number;
  onRedirect?: (url: string) => void;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  hops: number;
}

function performRequest(
  target: ResolvedTarget,
  options: SafeRequestOptions,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const request = transport(
      target.url,
      {
        method: options.method ?? "GET",
        // Host original preservado para SNI e virtual hosts, embora a conexão use o IP fixado.
        headers: { ...(options.headers ?? {}), Host: target.url.host },
        lookup: (_hostname, _opts, callback) =>
          callback(null, target.address, target.family),
        timeout: options.timeoutMs ?? 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new Error("Resposta excedeu o limite de tamanho."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as Record<string, string>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("Timeout na requisição.")));
    request.on("error", reject);
    request.end();
  });
}

/** Requisição HTTP com validação de redirects e IP fixado. */
export async function safeRequest(
  target: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let resolved = await resolveSafeTarget(target, options.allowPrivateHosts ?? false);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await performRequest(resolved, options);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === maxRedirects) throw new Error("Número excessivo de redirects.");
      const next = new URL(location, resolved.url).toString();
      options.onRedirect?.(next);
      // Revalida o destino: é aqui que um host público tentaria voltar para a rede interna.
      resolved = await resolveSafeTarget(next, options.allowPrivateHosts ?? false);
      continue;
    }
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      url: resolved.url.toString(),
      hops: hop,
    };
  }
  throw new Error("Falha ao resolver redirects.");
}

/** Valida explicitamente um destino de redirect (útil em testes e no Playwright). */
export async function validateRedirect(
  location: string,
  base: string,
  allowPrivateHosts = false,
): Promise<string> {
  const next = new URL(location, base).toString();
  return (await resolveSafeTarget(next, allowPrivateHosts)).url.toString();
}
