/**
 * Personal-detail stripping for Ask conversations.
 * Applied to every user message before D1 storage and before /ask/summary.
 * The raw message still goes to the model.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Matches Vietnamese phone numbers with prefixes 0, +84, 84.
 * Separators: space, dot, dash allowed between digit groups.
 * Total digits: 9-11 (counting leading 0 for local format, or digits after +84/84 plus leading-0 equivalent).
 * Structured pattern: prefix, optional separators, digit, then 7-10 groups of (optional separators + digit).
 * Ends with a digit to avoid consuming trailing whitespace.
 */
// Never starts inside a longer number ("2026100512", "2 000 000 000"): those fall through to [number].
const VIETNAMESE_PHONE_RE = /(?<!\d[\s.-]?)(?:[+]84|84|0)[\s.-]*\d(?:[\s.-]*\d){7,10}/g;

/**
 * Matches runs of 9+ digits (with optional single spaces between groups)
 * that are not part of prices, versions, dates, times, percentages, or short numbers.
 * This runs after emails, phones, and URLs are handled.
 */
const LONG_NUMBER_RE = /\b\d(?:[\s]?\d){8,}\b|\b\d{9,}\b/g;

/**
 * Matches URLs with a query string. Captures scheme, host, and path only.
 */
const URL_WITH_QUERY_RE = /(https?:\/\/[^\s?#]+)\?[^\s#]*/g;

/**
 * Checks if a matched digit sequence should be preserved (not redacted as [number]).
 * Returns true if the match looks like a price, version, date, time, percentage, etc.
 */
function isPreservedNumber(match: string, fullText: string, index: number): boolean {
  // Get surrounding context
  const before = fullText.slice(Math.max(0, index - 3), index);
  const after = fullText.slice(index + match.length, index + match.length + 3);

  // Version prefix (v7.0.116, V1.2.3)
  if (/[vV]$/.test(before)) return true;

  // Currency prefix ($1,200, €500, £100)
  if (/[$€£]$/.test(before)) return true;

  // Currency suffix (1.500.000đ, 15.000.000 VND, 500đ)
  if (/^(đ|VND\b)/i.test(after)) return true;

  // Percentage suffix
  if (/^%/.test(after)) return true;

  // Date/time separators within the match (10/10/2026, 16:01)
  if (match.includes("/") || match.includes(":")) return true;

  // Version-like: multiple dots (16.2.2, 1.2.3.4)
  if ((match.match(/\./g) || []).length >= 2) return true;

  // Price-like: dots as thousand separators with 3-digit groups (1.500.000)
  // But only if followed by currency or stands alone as a large number with dots
  if (/\.\d{3}(\.\d{3})+/.test(match) && /^(đ|VND\b|$)/i.test(after)) return true;

  // Comma as thousand separator with currency ($1,200)
  if (/,\d{3}/.test(match) && /^[$€£]/.test(before.slice(-1))) return true;

  return false;
}

/**
 * Redacts personal details from text.
 * - Emails -> "[email]"
 * - Vietnamese phone numbers -> "[phone]"
 * - Other runs of 9+ digits -> "[number]"
 * - URLs with query strings -> keep scheme, host, path only
 */
export function redact(text: string): string {
  let result = text;

  // 1. Strip query strings from URLs (keep scheme, host, path)
  result = result.replace(URL_WITH_QUERY_RE, "$1");

  // 2. Redact emails
  result = result.replace(EMAIL_RE, "[email]");

  // 3. Redact Vietnamese phone numbers
  result = result.replace(VIETNAMESE_PHONE_RE, (match) => {
    // Count digits in the match (excluding prefix +84/84/0)
    const digits = match.replace(/\D/g, "");
    const prefixMatch = match.match(/^([+]84|84|0)/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    // Digits contributed by prefix: "+84" -> 2, "84" -> 2, "0" -> 1
    const prefixDigitLength = prefix === "0" ? 1 : 2;
    const digitsAfterPrefix = digits.slice(prefixDigitLength);

    // Local format (0xxx): 9-11 digits total including leading 0 -> 8-10 after prefix digit
    // International format (+84/84xxx): digits after prefix + leading-0-equivalent = 9-11
    //   -> digits after prefix = 8-10
    const minDigits = 8;
    const maxDigits = 10;

    if (digitsAfterPrefix.length >= minDigits && digitsAfterPrefix.length <= maxDigits) {
      return "[phone]";
    }
    return match; // Not a valid phone number, leave as-is for other rules
  });

  // 4. Redact other 9+ digit runs (bank accounts, IDs, etc.)
  result = result.replace(LONG_NUMBER_RE, (match, offset) => {
    if (isPreservedNumber(match, result, offset)) {
      return match;
    }
    // Only redact if it's mostly digits (allow single spaces between groups)
    const digitCount = (match.match(/\d/g) || []).length;
    if (digitCount >= 9) {
      return "[number]";
    }
    return match;
  });

  return result;
}