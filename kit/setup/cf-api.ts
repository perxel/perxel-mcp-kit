/** A minimal Cloudflare REST client using a global API key (X-Auth-Email + X-Auth-Key). */

export interface Credentials {
  email: string;
  key: string;
}

export interface CfApi {
  /** Call the API and return `result`; throws with Cloudflare's error messages. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Raw text value endpoints (Workers KV values). */
  requestText(method: string, path: string, body?: string): Promise<string | null>;
}

const BASE = "https://api.cloudflare.com/client/v4";

export class CfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

export function createCfApi(creds: Credentials, fetchImpl: typeof fetch = fetch): CfApi {
  const headers = { "X-Auth-Email": creds.email, "X-Auth-Key": creds.key };
  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let json: Envelope<T> | null = null;
      try {
        json = (await res.json()) as Envelope<T>;
      } catch {
        // fall through to the status error below
      }
      if (!res.ok || !json?.success) {
        const msg = json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
        throw new CfApiError(`${method} ${path} failed: ${msg}`, res.status);
      }
      return json.result;
    },
    async requestText(method: string, path: string, body?: string): Promise<string | null> {
      const res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "text/plain" },
        body,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new CfApiError(`${method} ${path} failed: HTTP ${res.status}`, res.status);
      return res.text();
    },
  };
}
