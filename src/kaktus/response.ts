import { decode } from "./encoding.js";

export type ResponseDocument =
  { order: number; ok: true; number: string } | { order: number; ok: false; code: string; message: string };

export class ResponseFormatError extends Error {
  override name = "ResponseFormatError";
}

/**
 * Strict parser of the import response. Anything unexpected throws; the batch outcome is then
 * established from FAKPRI.DBF instead of a response we do not fully understand.
 */
export function parseResponse(bytes: Buffer, company: string, documentCount: number): ResponseDocument[] {
  const text = decode(bytes, "cp1250")
    .trim()
    .replace(/^<\?xml\s[^>]*\?>/, "")
    .trim();
  const root = /^<KaktusOdpoved\b([^>]*)>([\s\S]*)<\/KaktusOdpoved>$/.exec(text);
  if (!root) throw new ResponseFormatError("missing KaktusOdpoved root element");

  const attributes = parseAttributes(root[1] ?? "", ["firma", "zapsano", "odmitnuto"]);
  if (attributes.get("firma") !== company) {
    throw new ResponseFormatError(`response is for company "${attributes.get("firma")}", expected ${company}`);
  }

  const documents: ResponseDocument[] = [];
  const rest = (root[2] ?? "").replace(/<Doklad((?:\s+[A-Za-z]+="[^"]*")*)\s*\/>/g, (_, source: string) => {
    documents.push(
      toDocument(parseAttributes(source, ["poradi", "stav", "doklad", "kod", "zprava"]), documents.length + 1),
    );
    return "";
  });
  if (rest.trim() !== "") throw new ResponseFormatError(`unexpected content: ${rest.trim().slice(0, 80)}`);
  if (documents.length !== documentCount) {
    throw new ResponseFormatError(`response lists ${documents.length} documents, batch had ${documentCount}`);
  }
  const written = documents.filter((document) => document.ok).length;
  if (count(attributes, "zapsano") !== written || count(attributes, "odmitnuto") !== documents.length - written) {
    throw new ResponseFormatError("zapsano/odmitnuto do not match the listed documents");
  }
  return documents;
}

function toDocument(attributes: Map<string, string>, expectedOrder: number): ResponseDocument {
  if (attributes.get("poradi") !== String(expectedOrder)) {
    throw new ResponseFormatError(`document ${expectedOrder} has poradi "${attributes.get("poradi")}"`);
  }
  const state = attributes.get("stav");
  if (state === "OK") {
    const number = attributes.get("doklad") ?? "";
    if (!/^[A-Z0-9]{1,10}$/.test(number) || attributes.has("kod")) {
      throw new ResponseFormatError(`document ${expectedOrder}: invalid OK entry`);
    }
    return { order: expectedOrder, ok: true, number };
  }
  if (state === "CHYBA") {
    const code = attributes.get("kod") ?? "";
    if (!/^E\d{3}$/.test(code) || attributes.has("doklad")) {
      throw new ResponseFormatError(`document ${expectedOrder}: invalid CHYBA entry`);
    }
    return { order: expectedOrder, ok: false, code, message: attributes.get("zprava") ?? "" };
  }
  throw new ResponseFormatError(`document ${expectedOrder}: unknown stav "${state}"`);
}

function parseAttributes(source: string, allowed: readonly string[]): Map<string, string> {
  const attributes = new Map<string, string>();
  const rest = source.replace(/\s+([A-Za-z]+)="([^"<]*)"/g, (_, name: string, value: string) => {
    if (!allowed.includes(name) || attributes.has(name)) throw new ResponseFormatError(`unexpected attribute ${name}`);
    attributes.set(name, decodeEntities(value));
    return "";
  });
  if (rest.trim() !== "") throw new ResponseFormatError(`malformed attributes: ${source.trim().slice(0, 80)}`);
  return attributes;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&([^;&\s]*);|&/g, (_, entity: string | undefined) => {
    const named = entity === undefined ? undefined : NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    const numeric = /^#(?:x([0-9a-fA-F]+)|(\d+))$/.exec(entity ?? "");
    if (!numeric) throw new ResponseFormatError(`invalid entity in "${value}"`);
    return String.fromCodePoint(numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]));
  });
}

function count(attributes: Map<string, string>, name: string): number {
  const value = attributes.get(name) ?? "";
  if (!/^\d+$/.test(value)) throw new ResponseFormatError(`invalid ${name} "${value}"`);
  return Number(value);
}
