/** Integer amount in hundredths (haléře). Money is never stored as a float. */
export type Money = number;

/** Exchange rate scaled by 10 000 (Kaktus stores 4 decimals). */
export type Rate = number;

export const MONEY_SCALE = 2;
export const RATE_SCALE = 4;

/**
 * Parses a decimal string ("-12426.3", "15", "") into an integer scaled by 10^scale.
 * Blank means 0. Throws on anything else, including more decimals than the scale.
 */
export function parseFixed(text: string, scale: number): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match || (match[3] ?? "").length > scale) {
    throw new RangeError(`invalid decimal "${text}" (max ${scale} decimals)`);
  }
  const [, sign, whole = "", fraction = ""] = match;
  const value = Number(whole + fraction.padEnd(scale, "0"));
  if (!Number.isSafeInteger(value)) throw new RangeError(`decimal out of range "${text}"`);
  return sign === "-" ? -value : value;
}

/** Converts a scaled integer to a JSON number (12426.32). */
export function fixedToNumber(value: number, scale: number): number {
  return value / 10 ** scale;
}
