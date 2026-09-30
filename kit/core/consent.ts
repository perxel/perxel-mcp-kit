/**
 * The Allow/Deny consent page (task 3.5). Plain HTML, no JS frameworks. The
 * anti-forgery comes from the library's `beginConsent` handle (single-use and
 * bound to the browser via a cookie), so the form only carries the handle.
 */

export interface ConsentScope {
  name: string;
  description: string;
}

export function consentSecurityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  };
}

/** Escape untrusted strings (client names and URIs are client-controlled). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderConsentPage(opts: {
  mcpName: string;
  clientName: string;
  redirectHost: string;
  redirectIsLoopback: boolean;
  scopes: ConsentScope[];
  handle: string;
}): string {
  const scopes =
    opts.scopes.length > 0
      ? `<ul>${opts.scopes
          .map(
            (s) =>
              `<li><label><input type="checkbox" name="scope" value="${escapeHtml(s.name)}" checked> ` +
              `<strong>${escapeHtml(s.name)}</strong> &mdash; ${escapeHtml(s.description)}</label></li>`,
          )
          .join("")}</ul>`
      : `<p>This app asks for basic access only.</p>`;
  const loopbackWarning = opts.redirectIsLoopback
    ? `<p style="background:#fef3c7;border:1px solid #f59e0b;padding:8px 12px;border-radius:6px">` +
      `This app runs on your own computer. Only approve if you started this sign-in yourself.</p>`
    : ``;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${escapeHtml(opts.clientName)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px">
<h1>${escapeHtml(opts.clientName)} wants to access ${escapeHtml(opts.mcpName)}</h1>
<p>After you approve and sign in, the app returns to <strong>${escapeHtml(opts.redirectHost)}</strong>.</p>
${loopbackWarning}
<h2>Permissions</h2>
${scopes}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(opts.handle)}">
<button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body>
</html>`;
}

/** A locally rendered error (never a redirect: the target may be untrusted). */
export function renderOAuthErrorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}
