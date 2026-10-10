import { readFile } from "node:fs/promises";

/** Invalid TAXY input. `code` becomes the reason code of a rejected document. */
export class InputError extends Error {
  override name = "InputError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TaxyClient {
  klientId: number;
  nazev: string;
  ico: string;
  kaktusFirma: string;
}

/** Reads klienti.json. A malformed file is a configuration error and stops the run. */
export async function loadClients(path: string): Promise<Map<number, TaxyClient>> {
  const root = JsonReader.object(await readJson(path), path);
  const clients = new Map<number, TaxyClient>();
  for (const [index, raw] of root.array("klienti").entries()) {
    const item = JsonReader.object(raw, `${path}: klienti[${index}]`);
    const client = {
      klientId: item.integer("klientId"),
      nazev: item.string("nazev"),
      ico: item.string("ico"),
      kaktusFirma: item.string("kaktusFirma"),
    };
    if (clients.has(client.klientId)) {
      throw new InputError("INVALID_FIELD", `${path}: duplicate klientId ${client.klientId}`);
    }
    clients.set(client.klientId, client);
  }
  return clients;
}

/** Reads the documents to write. Elements are validated one by one later, so a bad document does not stop the others. */
export async function loadDocuments(path: string): Promise<unknown[]> {
  const documents = await readJson(path);
  if (!Array.isArray(documents)) throw new InputError("INVALID_FIELD", `${path}: expected an array of documents`);
  return documents;
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new InputError("UNREADABLE_FILE", `${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new InputError("INVALID_JSON", `${path}: ${(error as Error).message}`);
  }
}

/** Typed access to a JSON object; every problem throws an InputError naming the field. */
export class JsonReader {
  private constructor(
    private readonly value: Readonly<Record<string, unknown>>,
    private readonly path: string,
  ) {}

  static object(value: unknown, path: string): JsonReader {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new InputError("INVALID_FIELD", `${path || "document"} must be an object`);
    }
    return new JsonReader(value as Record<string, unknown>, path);
  }

  /** Trimmed and in composed Unicode (NFC): a decomposed "ř" would reach Kaktus as "r?" (findings I1). */
  optionalString(field: string): string | null {
    const value = this.value[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw this.invalid(field, "must be a string");
    const trimmed = value.normalize("NFC").trim();
    return trimmed === "" ? null : trimmed;
  }

  string(field: string): string {
    return this.optionalString(field) ?? this.missing(field);
  }

  optionalNumber(field: string): number | null {
    const value = this.value[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) throw this.invalid(field, "must be a number");
    return value;
  }

  number(field: string): number {
    return this.optionalNumber(field) ?? this.missing(field);
  }

  integer(field: string): number {
    const value = this.number(field);
    if (!Number.isSafeInteger(value)) throw this.invalid(field, "must be an integer");
    return value;
  }

  object(field: string): JsonReader {
    const value = this.value[field];
    if (value === undefined || value === null) this.missing(field);
    return JsonReader.object(value, this.name(field));
  }

  array(field: string): unknown[] {
    const value = this.value[field];
    if (value === undefined || value === null) this.missing(field);
    if (!Array.isArray(value)) throw this.invalid(field, "must be an array");
    return value;
  }

  name(field: string): string {
    return this.path ? `${this.path}.${field}` : field;
  }

  private invalid(field: string, problem: string): InputError {
    return new InputError("INVALID_FIELD", `${this.name(field)} ${problem}`);
  }

  private missing(field: string): never {
    throw new InputError("MISSING_FIELD", `${this.name(field)} is missing`);
  }
}
