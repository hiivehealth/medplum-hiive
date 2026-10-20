export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as JsonObject;
}

export function sourceId(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    return value;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid or unsafe source identifier');
  }
  return String(value);
}

export function readRecords(value: unknown): JsonObject[] {
  const envelope = object(value);
  const meta = object(envelope.meta);
  if (meta.status !== 'S' && meta.status !== 'Z') {
    throw new Error('Red Rover operation did not succeed');
  }
  if (meta.statusCode !== undefined && (typeof meta.statusCode !== 'string' || !/^2[0-9]{2}$/.test(meta.statusCode))) {
    throw new Error('Red Rover operation returned an unsuccessful status code');
  }
  if (meta.messages !== undefined) {
    if (
      !Array.isArray(meta.messages) ||
      meta.messages.some((message) => /^(fatal|error)$/i.test(String(object(message).severity)))
    ) {
      throw new Error('Red Rover operation returned an error message');
    }
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error('Missing Red Rover data array');
  }
  if (meta.status === 'Z' && envelope.data.length !== 0) {
    throw new Error('Inconsistent zero-record response');
  }
  return envelope.data.map(object);
}

export function readPatient(value: unknown, patientId: string): JsonObject {
  const records = readRecords(value);
  if (records.length !== 1 || sourceId(records[0].patientId) !== patientId) {
    throw new Error('Expected exactly the requested patient');
  }
  return records[0];
}

export function readPage(value: unknown): { records: JsonObject[]; nextId?: string } {
  const records = readRecords(value);
  const meta = object(object(value).meta);
  if (
    typeof meta.returnedCount !== 'number' ||
    typeof meta.totalCount !== 'number' ||
    !Number.isSafeInteger(meta.returnedCount) ||
    !Number.isSafeInteger(meta.totalCount) ||
    meta.returnedCount !== records.length ||
    meta.totalCount < meta.returnedCount
  ) {
    throw new Error('Missing or inconsistent pagination counts');
  }
  if (meta.totalCount === meta.returnedCount) {
    return { records };
  }
  if (records.length === 0) {
    throw new Error('Pagination made no progress');
  }
  return { records, nextId: sourceId(object(meta.pagination).id) };
}
