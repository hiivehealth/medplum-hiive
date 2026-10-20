import { beforeAll, describe, expect, it, vi } from 'vitest';
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle, Patient, Provenance } from '@medplum/fhirtypes';
import { fingerprint, prepareChart, prepareMappingReview, retrieveChart } from './dry-run';
import type { DryRunResult } from './dry-run';
import { prepareImportLedger } from './import-plan';
import type { MappingPolicy } from './mapping';

const policy: MappingPolicy = {
  identifierBase: 'https://example.test/rr/uat',
  genderCodes: {},
  encounterClassCodes: { '391': 'IMP' },
  encounterStatusCodes: { '856': 'finished' },
};
const context = {
  recorded: '2026-10-19T10:00:00Z',
  agentReference: 'Device/connector',
  mappingRevision: 'patient-encounter-v1',
};
const snapshot = {
  patientId: '19128435',
  patient: { patientId: 19128435 },
  encounters: [
    { encounterId: '61221038', patientId: '19128435', encounterClass: { code: 391 }, status: { code: 856 } },
  ],
};

describe('Read-only chart dry run', () => {
  beforeAll(() => {
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  });

  it('retrieves an allowlisted chart and prepares FHIR plus provenance without a writer', async () => {
    const client = {
      getPatientRecord: vi.fn().mockResolvedValue(snapshot.patient),
      getEncounters: vi.fn().mockResolvedValue(snapshot.encounters),
    };
    const result = prepareChart(await retrieveChart(client, snapshot.patientId), policy, context);
    expect(result.bundle.type).toBe('collection');
    expect(result.bundle.entry?.map((entry) => entry.resource?.resourceType)).toEqual([
      'Patient',
      'Encounter',
      'Provenance',
    ]);
    expect(result.report).toMatchObject({ mode: 'dry-run', patientCount: 1, encounterCount: 1, unsupportedFields: [] });
    expect(prepareChart(snapshot, policy, { ...context, recorded: '2026-10-20T10:00:00Z' }).report.operationKey).toBe(
      result.report.operationKey
    );
    expect(prepareChart(snapshot, policy, { ...context, mappingRevision: 'v2' }).report.operationKey).not.toBe(
      result.report.operationKey
    );
  });

  it('reports unsupported fields without copying their values to the report', () => {
    const result = prepareChart(
      { ...snapshot, patient: { ...snapshot.patient, additionalPatientData: { private: 'withheld' } } },
      policy,
      context
    );
    expect(result.report.unsupportedFields).toEqual(['patient.additionalPatientData']);
    expect(JSON.stringify(result.report)).not.toContain('withheld');
  });

  it('refuses wrong identity and duplicate records before producing a chart', () => {
    expect(() => prepareChart({ ...snapshot, patientId: '19128437' }, policy, context)).toThrow();
    expect(() =>
      prepareChart({ ...snapshot, encounters: [...snapshot.encounters, ...snapshot.encounters] }, policy, context)
    ).toThrow();
  });

  it('does not fetch encounters after a patient validation failure', async () => {
    const client = { getPatientRecord: vi.fn().mockRejectedValue(new Error('identity')), getEncounters: vi.fn() };
    await expect(retrieveChart(client, snapshot.patientId)).rejects.toThrow('identity');
    expect(client.getEncounters).not.toHaveBeenCalled();
  });

  it('canonicalizes object keys without conflating changed data', () => {
    expect(fingerprint({ first: 1, second: 2 })).toBe(fingerprint({ second: 2, first: 1 }));
    expect(fingerprint({ first: 2 })).not.toBe(fingerprint({ first: 1 }));
    expect(fingerprint({ first: 1, second: undefined })).toBe(fingerprint({ first: 1 }));
    expect(() => fingerprint({ value: Infinity })).toThrow();
  });

  const reviewSnapshot = {
    ...snapshot,
    patient: {
      ...snapshot.patient,
      firstName: 'Synthetic',
      lastName: 'Review',
      birthDateTime: null,
      gender: { code: 363, display: 'Female' },
      confidentiality: { code: 0, display: '' },
      vipStatus: { code: 1, display: 'Site VIP' },
      militaryData: { rank: { code: 42, display: 'Unmapped' } },
    },
    encounters: [
      {
        ...snapshot.encounters[0],
        encounterClass: { code: 391, display: 'Inpatient' },
        status: { code: 856, display: 'Discharged' },
      },
    ],
  };

  it('produces a validated but non-importable review with unapproved terminology and preserved security', () => {
    const before = JSON.stringify(reviewSnapshot);
    const result = prepareMappingReview(reviewSnapshot, context);
    expect(result.report).toMatchObject({ mode: 'mapping-review', importAllowed: false, fhirValidation: 'passed' });
    expect(result.report.proposals.map((proposal) => [proposal.proposedFhirCode, proposal.approved])).toEqual([
      ['female', false],
      ['IMP', false],
      ['finished', false],
    ]);
    expect(result.report.unsupportedFields).toEqual([
      'patient.confidentiality',
      'patient.militaryData',
      'patient.vipStatus',
    ]);
    expect(result.report.warnings).toContain('Birth date is missing at source; no date was inferred from age');
    const patient = result.bundle?.entry?.[0].resource as Patient;
    expect(patient.birthDate).toBeUndefined();
    expect(patient.meta?.security?.map((coding) => coding.code)).toEqual(['0', '1']);
    for (const entry of result.bundle?.entry ?? []) {
      expect(validateResource(entry.resource as Patient)).toEqual([]);
      expect(entry.resource?.meta?.tag?.[0].code).toBe('review-only-not-for-import');
    }
    const provenance = result.bundle?.entry?.[2].resource as Provenance;
    expect(provenance.entity?.[0].what.identifier?.value).toBe(fingerprint(reviewSnapshot));
    expect(JSON.stringify(reviewSnapshot)).toBe(before);
  });

  it('refuses the review at the native import-plan boundary even with a matching project', () => {
    const review = prepareMappingReview(reviewSnapshot, context);
    expect(() =>
      prepareImportLedger(review as unknown as DryRunResult, {
        identifierBase: 'https://example.test/rr/uat',
        expectedProjectId: 'isolated',
        currentProjectId: 'isolated',
        agentReference: 'Device/connector',
      })
    ).toThrow();
    expect(() => prepareChart(reviewSnapshot, policy, context)).toThrow('confidentiality');
  });

  it('does not fabricate a draft when display candidates are missing', () => {
    const review = prepareMappingReview(
      {
        ...reviewSnapshot,
        patient: { ...reviewSnapshot.patient, gender: { code: 777, display: 'Unverified local gender' } },
      },
      context
    );
    expect(review.bundle).toBeUndefined();
    expect(review.report.fhirValidation).toBe('not-generated');
    expect(review.report.importAllowed).toBe(false);
  });

  it('refuses conflicting candidates for the same source code', () => {
    const review = prepareMappingReview(
      {
        ...reviewSnapshot,
        encounters: [
          ...reviewSnapshot.encounters,
          {
            ...reviewSnapshot.encounters[0],
            encounterId: '61221039',
            encounterClass: { code: 391, display: 'Outpatient' },
          },
        ],
      },
      context
    );
    expect(review.bundle).toBeUndefined();
    expect(review.report.blockers).toContain('Missing or conflicting display-based terminology candidate');
  });
});
