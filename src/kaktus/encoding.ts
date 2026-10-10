import iconv from "iconv-lite";

/** DBF files use CP852, import batches and responses use Windows-1250 (docs/findings.md D1, I1). */
export type KaktusEncoding = "cp852" | "cp1250";

export function decode(bytes: Uint8Array, encoding: KaktusEncoding): string {
  return iconv.decode(Buffer.from(bytes), encoding);
}
