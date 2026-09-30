import { isAnthropicCloudCaller } from "./anthropic-range.js";
import { vietnamDate } from "./date.js";

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The metrics caller key (blobs' index): `u:` + first 16 hex of
 * SHA-256(salt + userId) when signed in, else `ip:` + first 16 hex of
 * SHA-256(salt + ip + Vietnam date) so anonymous keys rotate daily.
 * Returns "" when there is no salt or no identity to hash.
 */
export async function callerKeyFor(
  salt: string | undefined,
  userId: string | null | undefined,
  ip: string | undefined,
  now = new Date(),
): Promise<string> {
  if (!salt) return "";
  if (userId) return `u:${(await sha256Hex(`${salt}:${userId}`)).slice(0, 16)}`;
  if (!ip) return "";
  return `ip:${(await sha256Hex(`${salt}:${ip}:${vietnamDate(now)}`)).slice(0, 16)}`;
}

/** The anonymous (IP-based) caller key, used for the per-IP rate-limit bucket. */
export async function ipCallerKey(
  salt: string | undefined,
  ip: string | undefined,
  now = new Date(),
): Promise<string | null> {
  if (!salt || !ip) return null;
  return `ip:${(await sha256Hex(`${salt}:${ip}:${vietnamDate(now)}`)).slice(0, 16)}`;
}

export type ClientFamily = "claude-ai" | "claude-code" | "inspector" | "other";

/**
 * Client family for the metrics `client` blob: Anthropic's cloud range wins
 * (matched on CF-Connecting-IP, which a client can't fake), then the 2026
 * client identity (`clientInfo.name`), then the User-Agent.
 */
export function clientFamily(
  ip: string | undefined,
  clientName: string | undefined,
  userAgent: string | undefined,
): ClientFamily {
  if (isAnthropicCloudCaller(ip)) return "claude-ai";
  const hay = `${clientName ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (hay.includes("claude-code") || hay.includes("claude code")) return "claude-code";
  if (hay.includes("inspector")) return "inspector";
  return "other";
}
