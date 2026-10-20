import { beforeAll, describe, expect, it } from 'vitest';
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle } from '@medplum/fhirtypes';
import { mapEncounter, mapPatient } from './mapping';
import type { MappingPolicy } from './mapping';

const policy: MappingPolicy = {
  identifierBase: 'https://example.test/red-rover/uat/site-a',
  genderCodes: { '363': 'female' },
  encounterClassCodes: { '391': 'IMP' },
  encounterStatusCodes: { '856': 'finished' },
};
const patientSource = {
  patientId: 19128435,
  firstName: 'Synthetic',
  lastName: 'Patient',
  activeInd: false,
  birthDateTime: '1985-09-27T05:00:00.000+00:00',
  gender: { code: 363, display: 'Female' },
  deceased: false,
};
const encounterSource = {
  encounterId: '61221038',
  patientId: '19128435',
  encounterClass: { code: 391 },
  status: { code: 856 },
  arrivalDateTime: '2022-06-15T08:00:00Z',
  dischargeDateTime: '2022-06-22T08:00:00Z',
};

describe('Patient and encounter FHIR mapping', () => {
  beforeAll(() => {
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  });

  it('produces base-R4 validated resources with stable identifiers and references', () => {
    const patient = mapPatient(patientSource, policy);
    const encounter = mapEncounter(encounterSource, patient, policy);
    expect(validateResource(patient)).toEqual([]);
    expect(validateResource(encounter)).toEqual([]);
    expect(patient.birthDate).toBe('1985-09-27');
    expect(patient.active).toBe(false);
    expect(patient.deceasedBoolean).toBe(false);
    expect(patient.identifier?.[0].value).toBe('19128435');
    expect(encounter.subject?.reference).toBe(`Patient/${patient.id}`);
    expect(encounter.status).toBe('finished');
    expect(mapPatient(patientSource, policy)).toEqual(patient);
    expect(mapPatient(patientSource, { ...policy, identifierBase: `${policy.identifierBase}-other` }).id).not.toBe(
      patient.id
    );
  });

  it('does not invent missing demographics', () => {
    const patient = mapPatient({ patientId: 19128435 }, policy);
    expect(patient.gender).toBeUndefined();
    expect(patient.birthDate).toBeUndefined();
    expect(patient.name).toBeUndefined();
  });

  it.each([
    { birthDateTime: '2023-02-29T00:00:00Z' },
    { birthDateTime: '1985-09-27T05:00:00' },
    { gender: { code: 999 } },
    { activeInd: 'true' },
    { deceasedDateTime: '1980-01-01T00:00:00Z' },
    { confidentiality: { code: 438 } },
    { vipStatus: { code: 1 } },
  ])('quarantines invalid or unsupported patient values', (changes) => {
    expect(() => mapPatient({ ...patientSource, ...changes }, policy)).toThrow();
  });

  it.each([
    { patientId: '19128437' },
    { encounterClass: { code: 999 } },
    { status: { code: 999 } },
    { dischargeDateTime: '2020-01-01T00:00:00Z' },
  ])('rejects unresolved encounter identity, codes and times', (changes) => {
    expect(() => mapEncounter({ ...encounterSource, ...changes }, mapPatient(patientSource, policy), policy)).toThrow();
  });

  it('preserves the birth calendar date rather than shifting it to UTC', () => {
    expect(mapPatient({ patientId: 19128435, birthDateTime: '2000-01-01T00:00:00+14:00' }, policy).birthDate).toBe(
      '2000-01-01'
    );
  });
});
