import { canEncode } from "./encoding.js";

/** Kaktus keeps only text that survives the batch (Windows-1250) and the DBF (CP852); the rest becomes "?" (findings I1). */
export function isStorable(text: string): boolean {
  return canEncode(text, "cp1250") && canEncode(text, "cp852");
}

// Characters without a Unicode decomposition that are common in invoices.
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "€": "EUR",
  "„": '"',
  "“": '"',
  "”": '"',
  "‚": "'",
  "‘": "'",
  "’": "'",
  "–": "-",
  "—": "-",
  "•": "-",
  "→": "->",
  "←": "<-",
};

export interface FittedText {
  value: string;
  transliterated: boolean;
  truncated: boolean;
}

/**
 * Prepares free text for a Kaktus field: control characters become spaces, characters Kaktus cannot
 * store are transliterated (or "?"), and the result is cut to the field length.
 */
export function fitText(text: string, maxLength: number): FittedText {
  let value = "";
  let transliterated = false;
  for (const char of text) {
    if (isStorable(char) && !/[\u0000-\u001f\u007f]/.test(char)) {
      value += char;
      continue;
    }
    transliterated = true;
    value += transliterate(char);
  }
  value = value.trim();
  const truncated = value.length > maxLength;
  if (truncated) value = value.slice(0, maxLength).trimEnd();
  return { value, transliterated, truncated };
}

function transliterate(char: string): string {
  if (/[\u0000-\u001f\u007f]/.test(char)) return " ";
  const candidate = REPLACEMENTS[char] ?? char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return candidate !== "" && isStorable(candidate) ? candidate : "?";
}
