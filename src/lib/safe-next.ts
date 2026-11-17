/**
 * Where to send someone after sign-in / sign-up (VEC-260). Only same-origin paths pass: the value must start
 * with a single "/" (not "//" or "/\", which browsers read as a protocol-relative URL to another host), carry no
 * control characters (browsers drop tab/CR/LF, so "/\t/evil.example" would become "//evil.example"), and still
 * resolve to this origin. Anything else falls back to "/". Pure, so the pages, the actions and the tests share it.
 */
export function safeNext(next: string | undefined | null): string {
  if (typeof next !== "string" || !next.startsWith("/")) return "/";
  if (next[1] === "/" || next[1] === "\\") return "/";
  if (/[\u0000-\u001f\u007f]/.test(next)) return "/";
  try {
    const base = "http://same-origin.invalid";
    if (new URL(next, base).origin !== base) return "/";
  } catch {
    return "/";
  }
  return next;
}
