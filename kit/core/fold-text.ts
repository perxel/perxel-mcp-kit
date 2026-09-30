/**
 * Folds text for accent-insensitive matching: "Giải chạy Vũng Tàu" -> "giai chay vung tau".
 * Vietnamese đ isn't a base letter plus a mark, so it needs its own replace.
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
