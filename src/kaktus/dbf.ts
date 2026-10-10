import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { decode, type KaktusEncoding } from "./encoding.js";

export type DbfFieldType = "C" | "N" | "D" | "L";

export interface DbfField {
  name: string;
  type: DbfFieldType;
  length: number;
  decimals: number;
}

export interface DbfRecord {
  deleted: boolean;
  /** Decoded, untrimmed field values by field name. */
  values: Map<string, string>;
}

export interface DbfTable {
  source: string;
  fields: DbfField[];
  records: DbfRecord[];
}

export class DbfFormatError extends Error {
  override name = "DbfFormatError";
}

const HEADER_SIZE = 32;
const DESCRIPTOR_SIZE = 32;
const HEADER_TERMINATOR = 0x0d;
const END_OF_FILE = 0x1a;
const ACTIVE = 0x20;
const DELETED = 0x2a;

const LANGUAGE_DRIVERS: Readonly<Record<number, KaktusEncoding>> = { 0x64: "cp852", 0xc8: "cp1250" };

/**
 * Parses a dBase III file. Every structural inconsistency (truncated file, size not matching
 * the header, unknown encoding) throws, because a half-written file must never be read as data.
 */
export function parseDbf(bytes: Buffer, source: string): DbfTable {
  const fail = (message: string) => new DbfFormatError(`${source}: ${message}`);

  if (bytes.length <= HEADER_SIZE) throw fail(`file too short (${bytes.length} B)`);
  if (bytes[0] !== 0x03) throw fail(`unsupported version byte 0x${hex(bytes[0])}`);
  const recordCount = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt16LE(8);
  const recordLength = bytes.readUInt16LE(10);
  const encoding = LANGUAGE_DRIVERS[bytes[29] ?? -1];
  if (!encoding) throw fail(`unknown language driver 0x${hex(bytes[29])}`);

  const fields: DbfField[] = [];
  for (let offset = HEADER_SIZE; bytes[offset] !== HEADER_TERMINATOR; offset += DESCRIPTOR_SIZE) {
    if (offset + DESCRIPTOR_SIZE >= headerLength || offset + DESCRIPTOR_SIZE > bytes.length) {
      throw fail("field descriptors exceed the header");
    }
    const descriptor = bytes.subarray(offset, offset + DESCRIPTOR_SIZE);
    const nameEnd = descriptor.indexOf(0);
    const name = descriptor.toString("latin1", 0, nameEnd >= 0 && nameEnd < 11 ? nameEnd : 11);
    const type = String.fromCharCode(descriptor[11] ?? 0);
    if (!isFieldType(type)) throw fail(`field ${name} has unsupported type "${type}"`);
    fields.push({ name, type, length: descriptor[16] ?? 0, decimals: descriptor[17] ?? 0 });
  }

  const fieldsLength = fields.reduce((sum, field) => sum + field.length, 1);
  if (fieldsLength !== recordLength) throw fail(`record length ${recordLength} does not match fields (${fieldsLength})`);

  const dataEnd = headerLength + recordCount * recordLength;
  const sizeMatches = bytes.length === dataEnd || (bytes.length === dataEnd + 1 && bytes[dataEnd] === END_OF_FILE);
  if (!sizeMatches) throw fail(`size ${bytes.length} B does not match ${recordCount} records in the header (${dataEnd} B)`);

  const records: DbfRecord[] = [];
  for (let index = 0; index < recordCount; index++) {
    const start = headerLength + index * recordLength;
    const flag = bytes[start];
    if (flag !== ACTIVE && flag !== DELETED) throw fail(`record ${index + 1} has invalid deletion flag 0x${hex(flag)}`);
    const values = new Map<string, string>();
    let position = start + 1;
    for (const field of fields) {
      values.set(field.name, decode(bytes.subarray(position, position + field.length), encoding));
      position += field.length;
    }
    records.push({ deleted: flag === DELETED, values });
  }
  return { source, fields, records };
}

/**
 * Reads a DBF file and maps it. Kaktus rewrites files in place during an import, so a read that fails
 * to parse or map is retried before it is reported as corruption.
 */
export async function readDbf<T>(
  path: string,
  map: (table: DbfTable) => T,
  { attempts = 3, retryDelayMs = 200 } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const bytes = await readFile(path);
    try {
      return map(parseDbf(bytes, path));
    } catch (error) {
      if (!(error instanceof DbfFormatError) || attempt >= attempts) throw error;
      await sleep(retryDelayMs);
    }
  }
}

function isFieldType(type: string): type is DbfFieldType {
  return type === "C" || type === "N" || type === "D" || type === "L";
}

function hex(byte: number | undefined): string {
  return (byte ?? 0).toString(16).padStart(2, "0");
}
