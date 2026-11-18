import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Proteção contra SSRF: bloqueia hosts privados, loopback, link-local e multicast. */

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

export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  if (clean.startsWith("::ffff:")) {
    return isBlockedIp(clean.slice(7));
  }
  if (clean === "::" || clean === "::1") return true;
  const lower = clean.toLowerCase();
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10
  if (isIP(clean) !== 4) return isIP(clean) === 6; // outros IPv6 são bloqueados por padrão
  return BLOCKED_V4.some(([base, bits]) => inRange(clean, base, bits));
}

export class BlockedHostError extends Error {
  constructor(host: string, ip: string) {
    super(`Host bloqueado por proteção SSRF: ${host} (${ip}). Use --allow-private-hosts para auditorias locais.`);
    this.name = "BlockedHostError";
  }
}

export async function assertPublicUrl(
  target: string,
  allowPrivateHosts = false,
): Promise<URL> {
  const value = /^https?:\/\//i.test(target) ? target : `https://${target}`;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Protocolo não suportado: ${url.protocol}`);
  }
  if (allowPrivateHosts) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`Host sem resolução DNS: ${host}`);

  const blocked = addresses.find(isBlockedIp);
  if (blocked) throw new BlockedHostError(host, blocked);
  return url;
}
