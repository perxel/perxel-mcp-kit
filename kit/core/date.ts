/**
 * Today's date in Vietnam as YYYY-MM-DD. The IP caller key rotates daily on
 * Vietnam's day, not UTC or the viewer's.
 */
export function vietnamDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(now);
}
