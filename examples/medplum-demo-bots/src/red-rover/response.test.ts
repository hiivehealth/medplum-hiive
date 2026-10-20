import { describe, expect, it } from 'vitest';
import { readPage, readPatient, readRecords, sourceId } from './response';

describe('Red Rover response boundary', () => {
  it('accepts success and explicit zero records', () => {
    expect(readPatient({ meta: { status: 'S' }, data: [{ patientId: 19128435 }] }, '19128435')).toEqual({
      patientId: 19128435,
    });
    expect(readRecords({ meta: { status: 'Z' }, data: [] })).toEqual([]);
  });

  it.each([
    null,
    { data: [] },
    { meta: { status: 'F' }, data: [] },
    { meta: { status: 'unexpected' }, data: [] },
    { meta: { status: 'S' } },
    { meta: { status: 'Z' }, data: [{}] },
    { meta: { status: 'S' }, data: [null] },
  ])('rejects malformed or failed envelopes', (response) => {
    expect(() => readRecords(response)).toThrow();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '01', '', null])('rejects unsafe IDs', (value) => {
    expect(() => sourceId(value)).toThrow();
  });

  it('preserves string identifiers and rejects success envelopes carrying failures', () => {
    expect(sourceId('9007199254740993')).toBe('9007199254740993');
    expect(() => readRecords({ meta: { status: 'S', statusCode: '403' }, data: [] })).toThrow();
    expect(() => readRecords({ meta: { status: 'S', messages: [{ severity: 'Fatal' }] }, data: [] })).toThrow();
  });

  it('reads page metadata and refuses incomplete or inconsistent pagination', () => {
    expect(
      readPage({ meta: { status: 'S', returnedCount: 1, totalCount: 2, pagination: { id: 22 } }, data: [{}] })
    ).toEqual({ records: [{}], nextId: '22' });
    expect(readPage({ meta: { status: 'Z', returnedCount: 0, totalCount: 0 }, data: [] })).toEqual({ records: [] });
    for (const meta of [
      { status: 'S' },
      { status: 'S', returnedCount: 1, totalCount: 2 },
      { status: 'S', returnedCount: 0, totalCount: 1, pagination: { id: 22 } },
      { status: 'S', returnedCount: -1, totalCount: -1 },
    ]) {
      expect(() => readPage({ meta, data: [] })).toThrow();
    }
  });

  it.each([
    { data: [] },
    { data: [{ patientId: 19128437 }] },
    { data: [{ patientId: 19128435 }, { patientId: 19128435 }] },
  ])('rejects missing, wrong or ambiguous patient identity', ({ data }) => {
    expect(() => readPatient({ meta: { status: 'S' }, data }, '19128435')).toThrow();
  });
});
