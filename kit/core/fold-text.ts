/**
 * Folds text for accent-insensitive matching: "Giải chạy Vũng Tàu" -> "giai chay vung tau".
 * Same approach as openrace-api's src/lib/search.ts (đ isn't a base letter plus a mark,
 * so it needs its own replace); this copy is small enough not to need the arg-summary
 * pact of staying byte-identical.
 */
export function foldText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
