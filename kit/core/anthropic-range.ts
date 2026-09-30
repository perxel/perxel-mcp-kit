/**
 * Anthropic's published outbound IP range for connectors: claude.ai, Claude Desktop,
 * mobile and Cowork call MCP servers from Anthropic's cloud, not the user's device,
 * from this CIDR block (https://platform.claude.com/docs/en/api/ip-addresses). Those
 * callers share the bigger `RATE_LIMITER_ANTHROPIC` bucket instead of the per-IP one,
 * since many real users can otherwise look like a handful of IPs hammering the normal
 * bucket. Anthropic may change this range with notice — check the docs page above if
 * requests from claude.ai start hitting the wrong bucket.
 *
 * Matched against `CF-Connecting-IP`, which Cloudflare sets and a client can't fake, not
 * the user-agent. Clients on the user's own machine (Claude Code, Cursor, `mcp-remote`)
 * call from the user's own IP and are never in this range.
 */
export const ANTHROPIC_CLOUD_CIDR = "160.79.104.0/21";

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = (n << 8) | byte;
  }
  return n >>> 0;
}

/** True when `ip` (IPv4, dotted-quad) falls inside `cidr` (e.g. "160.79.104.0/21"). */
export function isIpInCidr(ip: string | undefined, cidr: string): boolean {
  if (!ip) return false;
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

export function isAnthropicCloudCaller(ip: string | undefined): boolean {
  return isIpInCidr(ip, ANTHROPIC_CLOUD_CIDR);
}
