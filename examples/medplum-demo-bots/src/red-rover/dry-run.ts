import { createHash } from 'node:crypto';
import { validateResource } from '@medplum/core';
import type { Bundle, Encounter, Patient, Provenance } from '@medplum/fhirtypes';
import { mapEncounter, mapPatient } from './mapping';
import type { MappingPolicy } from './mapping';
import { object, sourceId } from './response';
import type { JsonObject } from './response';

export interface ChartSnapshot {
  patientId: string;
  patient: JsonObject;
  encounters: JsonObject[];
}

export interface DryRunContext {
  recorded: string;
  agentReference: string;
  mappingRevision: string;
}

export interface DryRunResult {
  bundle: Bundle;
  report: {
    mode: 'dry-run';
    patientCount: number;
    encounterCount: number;
    unsupportedFields: string[];
    operationKey: string;
    mappingRevision: string;
  };
}

function canonical(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Non-finite numbers cannot be fingerprinted');
  }
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) {
      throw new Error('Snapshot must contain only JSON data');
    }
    return result;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const PATIENT_FIELDS = new Set([
  'patientId',
  'firstName',
  'middleName',
  'lastName',
  'prefix',
  'suffix',
  'activeInd',
  'birthDateTime',
  'gender',
  'deceased',
  'deceasedDateTime',
]);
const ENCOUNTER_FIELDS = new Set([
  'patientId',
  'encounterId',
  'encounterClass',
  'status',
  'encounterType',
  'arrivalDateTime',
  'dischargeDateTime',
  'reasonForVisit',
]);

export function prepareChart(snapshot: ChartSnapshot, policy: MappingPolicy, context: DryRunContext): DryRunResult {
  if (
    sourceId(snapshot.patient.patientId) !== snapshot.patientId ||
    !context.mappingRevision.trim() ||
    !/^(Device|Practitioner|Organization)\/[A-Za-z0-9.-]{1,64}$/.test(context.agentReference) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(context.recorded) ||
    !Number.isFinite(Date.parse(context.recorded))
  ) {
    throw new Error('Invalid dry-run identity or provenance context');
  }
  const patient = mapPatient(snapshot.patient, policy);
  const encounters = snapshot.encounters.map((record) => mapEncounter(record, patient, policy));
  if (new Set(encounters.map((record) => record.id)).size !== encounters.length) {
    throw new Error('Duplicate encounters in chart snapshot');
  }
  const operationKey = fingerprint({ snapshot, policy, mappingRevision: context.mappingRevision });
  const resources: (Patient | Encounter | Provenance)[] = [patient, ...encounters];
  const provenance: Provenance = {
    resourceType: 'Provenance',
    target: resources.map((resource) => ({ reference: `${resource.resourceType}/${resource.id}` })),
    recorded: context.recorded,
    agent: [{ who: { reference: context.agentReference } }],
    entity: [
      {
        role: 'source',
        what: { identifier: { system: `${policy.identifierBase}/snapshot-sha256`, value: operationKey } },
      },
    ],
  };
  resources.push(provenance);
  for (const resource of resources) {
    if (validateResource(resource).length !== 0) {
      throw new Error('FHIR validation failed; resource details withheld');
    }
  }
  const unsupported = new Set(
    Object.keys(snapshot.patient)
      .filter((key) => !PATIENT_FIELDS.has(key))
      .map((key) => `patient.${key}`)
  );
  for (const record of snapshot.encounters) {
    for (const key of Object.keys(record).filter((key) => !ENCOUNTER_FIELDS.has(key))) {
      unsupported.add(`encounter.${key}`);
    }
  }
  return {
    bundle: { resourceType: 'Bundle', type: 'collection', entry: resources.map((resource) => ({ resource })) },
    report: {
      mode: 'dry-run',
      patientCount: 1,
      encounterCount: encounters.length,
      unsupportedFields: [...unsupported].sort(),
      operationKey,
      mappingRevision: context.mappingRevision,
    },
  };
}

export async function retrieveChart(
  client: {
    getPatientRecord(patientId: string): Promise<JsonObject>;
    getEncounters(patientId: string): Promise<JsonObject[]>;
  },
  patientId: string
): Promise<ChartSnapshot> {
  const patient = await client.getPatientRecord(patientId);
  const encounters = await client.getEncounters(patientId);
  return { patientId, patient, encounters };
}

export interface MappingProposal {
  field: 'gender' | 'encounterClass' | 'status';
  sourceCode: string;
  sourceDisplay?: string;
  proposedFhirCode?: string;
  approved: false;
}

export interface MappingReview {
  bundle?: Bundle;
  report: {
    mode: 'mapping-review';
    importAllowed: false;
    patientCount: number;
    encounterCount: number;
    proposals: MappingProposal[];
    unsupportedFields: string[];
    blockers: string[];
    warnings: string[];
    fhirValidation: 'passed' | 'not-generated';
  };
}

const DISPLAY_CANDIDATES: Readonly<Record<MappingProposal['field'], Readonly<Record<string, string>>>> = {
  gender: { female: 'female', male: 'male', other: 'other', unknown: 'unknown' },
  encounterClass: { inpatient: 'IMP', outpatient: 'AMB', ambulatory: 'AMB', emergency: 'EMER', observation: 'OBSENC' },
  status: {
    discharged: 'finished',
    finished: 'finished',
    planned: 'planned',
    arrived: 'arrived',
    'in progress': 'in-progress',
    cancelled: 'cancelled',
  },
};

/**
 * Builds a non-importable clinical mapping review; display-based candidates are never approved mappings.
 * @param snapshot - Previously retrieved, protected source chart.
 * @param context - Explicit draft recording context, not a claim of a provisioned clinical actor.
 * @returns A private review with optional validated draft resources and unresolved approval gates.
 */
export function prepareMappingReview(snapshot: ChartSnapshot, context: DryRunContext): MappingReview {
  const identifierBase = 'https://example.invalid/red-rover/uat/mapping-review';
  const proposals: MappingProposal[] = [];
  function propose(value: unknown, field: MappingProposal['field']): void {
    const source = object(value);
    const sourceCode = sourceId(source.code);
    const sourceDisplay = typeof source.display === 'string' ? source.display : undefined;
    const display = sourceDisplay?.trim().toLowerCase() ?? '';
    const candidates = DISPLAY_CANDIDATES[field];
    proposals.push({
      field,
      sourceCode,
      sourceDisplay,
      proposedFhirCode: Object.hasOwn(candidates, display) ? candidates[display] : undefined,
      approved: false,
    });
  }
  if (snapshot.patient.gender !== undefined) {
    propose(snapshot.patient.gender, 'gender');
  }
  for (const encounter of snapshot.encounters) {
    propose(encounter.encounterClass, 'encounterClass');
    propose(encounter.status, 'status');
  }
  const unsupported = new Set(
    Object.keys(snapshot.patient)
      .filter((key) => !PATIENT_FIELDS.has(key))
      .map((key) => `patient.${key}`)
  );
  for (const encounter of snapshot.encounters) {
    for (const key of Object.keys(encounter).filter((field) => !ENCOUNTER_FIELDS.has(field))) {
      unsupported.add(`encounter.${key}`);
    }
  }
  const report: MappingReview['report'] = {
    mode: 'mapping-review',
    importAllowed: false,
    patientCount: 1,
    encounterCount: snapshot.encounters.length,
    proposals,
    unsupportedFields: [...unsupported].sort(),
    blockers: [
      'Source-to-FHIR terminology mappings require approval',
      'Confidentiality/VIP handling and access enforcement require approval',
      'Source namespace and provenance actor are review-only placeholders',
      'Unmapped source fields require disposition before import',
    ],
    warnings:
      snapshot.patient.birthDateTime === null ||
      snapshot.patient.birthDateTime === undefined ||
      snapshot.patient.birthDateTime === ''
        ? ['Birth date is missing at source; no date was inferred from age']
        : [],
    fhirValidation: 'not-generated',
  };
  const mappings = {
    gender: new Map<string, string>(),
    encounterClass: new Map<string, string>(),
    status: new Map<string, string>(),
  };
  for (const proposal of proposals) {
    const previous = mappings[proposal.field].get(proposal.sourceCode);
    if (!proposal.proposedFhirCode || (previous && previous !== proposal.proposedFhirCode)) {
      report.blockers.push('Missing or conflicting display-based terminology candidate');
      return { report };
    }
    mappings[proposal.field].set(proposal.sourceCode, proposal.proposedFhirCode);
  }
  const policy: MappingPolicy = {
    identifierBase,
    genderCodes: Object.fromEntries(mappings.gender) as MappingPolicy['genderCodes'],
    encounterClassCodes: Object.fromEntries(mappings.encounterClass),
    encounterStatusCodes: Object.fromEntries(mappings.status) as MappingPolicy['encounterStatusCodes'],
  };
  const { confidentiality, vipStatus, ...projectedPatient } = snapshot.patient;
  const draft = prepareChart({ ...snapshot, patient: projectedPatient }, policy, context);
  const patient = draft.bundle.entry?.[0].resource as Patient;
  const security = [];
  for (const [field, value] of [
    ['confidentiality', confidentiality],
    ['vip-status', vipStatus],
  ] as const) {
    if (value === undefined) {
      continue;
    }
    const source = object(value);
    const code =
      typeof source.code === 'number' && Number.isSafeInteger(source.code) && source.code >= 0
        ? String(source.code)
        : sourceId(source.code);
    security.push({
      system: `${identifierBase}/code/${field}`,
      code,
      display: typeof source.display === 'string' && source.display.trim() ? source.display : undefined,
    });
  }
  patient.meta = { security: security.length ? security : undefined };
  const provenance = draft.bundle.entry?.find((entry) => entry.resource?.resourceType === 'Provenance')
    ?.resource as Provenance;
  provenance.entity = [
    {
      role: 'source',
      what: {
        identifier: {
          system: `${identifierBase}/review-source-sha256`,
          value: fingerprint(snapshot),
        },
      },
    },
  ];
  for (const entry of draft.bundle.entry ?? []) {
    const resource = entry.resource;
    if (!resource) {
      throw new Error('Missing draft resource');
    }
    resource.meta = {
      ...resource.meta,
      tag: [{ system: `${identifierBase}/purpose`, code: 'review-only-not-for-import' }],
    };
    if (validateResource(resource).length !== 0) {
      throw new Error('Review draft FHIR validation failed; resource details withheld');
    }
  }
  report.fhirValidation = 'passed';
  return { bundle: draft.bundle, report };
}
