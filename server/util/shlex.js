/**
 * POSIX shell quoting for remote command construction.
 *
 * SparkDash builds remote commands as a single string that the REMOTE login
 * shell parses (ssh joins argv). Any interpolated value — model paths, work
 * dirs, env values, CPU affinity ranges — is therefore shell-live. Every such
 * value MUST pass through `shlexQuote` before interpolation.
 *
 * The single-quote form is the safe default: inside single quotes, POSIX
 * leaves no metacharacter alive. A literal single quote is the only thing
 * that needs escaping (`'\''` closes, escapes, reopens).
 */

/** True when the string is safe to embed in a shell command unquoted. */
export function isShlexSafe(value) {
  return typeof value === "string" && /^[A-Za-z0-9._/:@%+=,-]+$/.test(value) && !value.startsWith("-");
}

/**
 * Quote a single value for POSIX shell interpolation.
 * @param {string} value
 * @returns {string} single-quoted (or verified-safe bare) token
 */
export function shlexQuote(value) {
  if (typeof value !== "string") {
    throw new TypeError(`shlexQuote requires a string, got ${typeof value}`);
  }
  if (value === "") return "''";
  if (isShlexSafe(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote every value and join with spaces into one shell command fragment. */
export function shlexJoin(values) {
  return values.map(shlexQuote).join(" ");
}