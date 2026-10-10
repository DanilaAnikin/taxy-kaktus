import iconv from "iconv-lite";

/** DBF files use CP852, import batches and responses use Windows-1250 (docs/findings.md D1, I1). */
export type KaktusEncoding = "cp852" | "cp1250";

export function decode(bytes: Uint8Array, encoding: KaktusEncoding): string {
  return iconv.decode(Buffer.from(bytes), encoding);
}

/** Encodes text; throws if any character is not representable (iconv would silently write "?"). */
export function encode(text: string, encoding: KaktusEncoding): Buffer {
  if (!canEncode(text, encoding)) throw new RangeError(`text is not representable in ${encoding}: "${text}"`);
  return iconv.encode(text, encoding);
}

export function canEncode(text: string, encoding: KaktusEncoding): boolean {
  return iconv.decode(iconv.encode(text, encoding), encoding) === text;
}
