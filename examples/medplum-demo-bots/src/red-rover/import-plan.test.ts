import { beforeAll, describe, expect, it } from 'vitest';
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle, Encounter, Provenance, Task } from '@medplum/fhirtypes';
import { prepareChart } from './dry-run';
import type { DryRunResult } from './dry-run';
import { prepareImportLedger, prepareImportTransaction } from './import-plan';

const namespace = 'https://example.test/rr/uat';
const context = {
  identifierBase: namespace,
  expectedProjectId: 'isolated-uat',
  currentProjectId: 'isolated-uat',
  agentReference: 'Device/connector',
};
let result: DryRunResult;
let ledger: Task;

describe('Conditional import transaction proposal', () => {
  beforeAll(() => {
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
    indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
    result = prepareChart(
      {
        patientId: '19128435',
        patient: { patientId: 19128435 },
        encounters: [
          { patientId: '19128435', encounterId: '61221038', encounterClass: { code: 391 }, status: { code: 856 } },
        ],
      },
      {
        identifierBase: namespace,
        genderCodes: {},
        encounterClassCodes: { '391': 'IMP' },
        encounterStatusCodes: { '856': 'finished' },
      },
      { recorded: '2026-10-19T10:00:00Z', agentReference: 'Device/connector', mappingRevision: 'v1' }
    );
    ledger = { ...prepareImportLedger(result, context), id: 'ledger', meta: { versionId: 'version-1' } };
  });

  it('uses native conditional creates and a version-guarded completion in one proposed transaction', () => {
    const proposal = prepareImportTransaction(result, ledger, context);
    expect(proposal.type).toBe('transaction');
    expect(proposal.entry?.map((entry) => entry.request?.method)).toEqual(['POST', 'POST', 'POST', 'PUT']);
    expect(proposal.entry?.[0].request?.ifNoneExist).toContain('identifier=');
    expect(proposal.entry?.[1].request?.ifNoneExist).toContain('61221038');
    expect(proposal.entry?.[3].request).toEqual({ method: 'PUT', url: 'Task/ledger', ifMatch: 'W/"version-1"' });
    expect(validateResource(proposal)).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'structure',
        expression: ['Bundle.entry[1].resource.subject'],
        details: { text: expect.stringContaining(proposal.entry?.[0].fullUrl ?? 'missing-fullUrl') },
      }),
    ]);
    expect(validateResource(ledger)).toEqual([]);
  });

  it('rewrites patient, encounter and provenance references to transaction fullUrls without mutating the dry run', () => {
    const before = JSON.stringify(result);
    const proposal = prepareImportTransaction(result, ledger, context);
    const entries = proposal.entry ?? [];
    expect((entries[1].resource as Encounter).subject?.reference).toBe(entries[0].fullUrl);
    expect((entries[2].resource as Provenance).target.map((value) => value.reference)).toEqual([
      entries[0].fullUrl,
      entries[1].fullUrl,
    ]);
    expect(entries[0].resource?.id).toBeUndefined();
    expect(JSON.stringify(result)).toBe(before);
  });

  it('refuses unapproved, changed, completed or unversioned ledgers', () => {
    for (const changes of [
      { status: 'completed' },
      { meta: {} },
      { input: [] },
      { identifier: [] },
      { owner: { reference: 'Device/other' } },
    ] as Partial<Task>[]) {
      expect(() => prepareImportTransaction(result, { ...ledger, ...changes }, context)).toThrow();
    }
    const changed = structuredClone(result);
    changed.bundle.entry?.pop();
    expect(() => prepareImportTransaction(changed, ledger, context)).toThrow();
  });

  it('refuses the wrong project and unresolved mapping gaps', () => {
    expect(() => prepareImportLedger(result, { ...context, currentProjectId: 'shared-project' })).toThrow();
    expect(() =>
      prepareImportLedger(
        { ...result, report: { ...result.report, unsupportedFields: ['patient.additionalPatientData'] } },
        context
      )
    ).toThrow();
  });
});
