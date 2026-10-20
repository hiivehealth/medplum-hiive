import { createHash } from 'node:crypto';
import type { Coding, Encounter, Patient } from '@medplum/fhirtypes';
import { object, sourceId } from './response';
import type { JsonObject } from './response';

export interface MappingPolicy {
  identifierBase: string;
  genderCodes: Readonly<Record<string, NonNullable<Patient['gender']>>>;
  encounterClassCodes: Readonly<Record<string, string>>;
  encounterStatusCodes: Readonly<Record<string, Encounter['status']>>;
}

function base(policy: MappingPolicy): string {
  const url = new URL(policy.identifierBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href.endsWith('/')) {
    throw new Error('Expected an owned HTTPS source namespace without a trailing slash');
  }
  return url.href;
}

function identifier(kind: string, value: unknown, policy: MappingPolicy): { system: string; value: string } {
  return { system: `${base(policy)}/${kind}`, value: sourceId(value) };
}

function localId(system: string, value: string): string {
  return `rr-${createHash('sha256')
    .update(JSON.stringify([system, value]))
    .digest('hex')
    .slice(0, 48)}`;
}

function optionalText(record: JsonObject, key: string): string | undefined {
  if (record[key] === undefined || record[key] === null || record[key] === '') {
    return undefined;
  }
  if (typeof record[key] !== 'string' || !record[key].trim()) {
    throw new Error(`Invalid source ${key}`);
  }
  return record[key];
}

function calendarDate(value: string): string {
  const date = value.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error('Invalid source calendar date');
  }
  return date;
}

function timestamp(value: string): string {
  calendarDate(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(
      value
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error('Invalid or timezone-free source timestamp');
  }
  return value;
}

function localCoding(value: unknown, kind: string, policy: MappingPolicy): Coding {
  const source = object(value);
  return {
    system: `${base(policy)}/code/${kind}`,
    code: sourceId(source.code),
    display: optionalText(source, 'display'),
  };
}

function mapped<Value extends string>(values: Readonly<Record<string, Value>>, code: string): Value {
  if (!Object.hasOwn(values, code)) {
    throw new Error('Unmapped source terminology');
  }
  return values[code];
}

function sensitive(record: JsonObject): void {
  if (record.confidentiality !== undefined || record.vipStatus !== undefined) {
    throw new Error('Source confidentiality/VIP controls require an approved security mapping');
  }
}

export function mapPatient(record: JsonObject, policy: MappingPolicy): Patient {
  sensitive(record);
  const source = identifier('patient', record.patientId, policy);
  const patient: Patient = { resourceType: 'Patient', id: localId(source.system, source.value), identifier: [source] };
  const first = optionalText(record, 'firstName');
  const middle = optionalText(record, 'middleName');
  const last = optionalText(record, 'lastName');
  const prefix = optionalText(record, 'prefix');
  const suffix = optionalText(record, 'suffix');
  if (first || middle || last || prefix || suffix) {
    patient.name = [
      {
        family: last,
        given: [first, middle].filter((value): value is string => !!value),
        prefix: prefix ? [prefix] : undefined,
        suffix: suffix ? [suffix] : undefined,
      },
    ];
  }
  if (record.activeInd !== undefined) {
    if (typeof record.activeInd !== 'boolean') {
      throw new Error('Invalid source active indicator');
    }
    patient.active = record.activeInd;
  }
  const birth = optionalText(record, 'birthDateTime');
  if (birth) {
    patient.birthDate = calendarDate(timestamp(birth));
  }
  if (record.gender !== undefined) {
    const coding = localCoding(record.gender, 'gender', policy);
    const gender = mapped(policy.genderCodes, coding.code as string);
    if (!['male', 'female', 'other', 'unknown'].includes(gender)) {
      throw new Error('Invalid FHIR gender mapping');
    }
    patient.gender = gender;
    patient.extension = [{ url: `${base(policy)}/source-gender`, valueCoding: coding }];
  }
  const death = optionalText(record, 'deceasedDateTime');
  if (record.deceased !== undefined && typeof record.deceased !== 'boolean') {
    throw new Error('Invalid deceased indicator');
  }
  if (death) {
    if (record.deceased === false || (birth && Date.parse(death) < Date.parse(birth))) {
      throw new Error('Inconsistent deceased date');
    }
    patient.deceasedDateTime = timestamp(death);
  } else if (typeof record.deceased === 'boolean') {
    patient.deceasedBoolean = record.deceased;
  }
  return patient;
}

export function mapEncounter(record: JsonObject, patient: Patient, policy: MappingPolicy): Encounter {
  const sourcePatient = identifier('patient', record.patientId, policy);
  if (
    !patient.id ||
    !patient.identifier?.some((value) => value.system === sourcePatient.system && value.value === sourcePatient.value)
  ) {
    throw new Error('Encounter patient crosswalk mismatch');
  }
  const source = identifier('encounter', record.encounterId, policy);
  const originalClass = localCoding(record.encounterClass, 'encounter-class', policy);
  const originalStatus = localCoding(record.status, 'encounter-status', policy);
  const classCode = mapped(policy.encounterClassCodes, originalClass.code as string);
  const status = mapped(policy.encounterStatusCodes, originalStatus.code as string);
  if (
    !['AMB', 'EMER', 'FLD', 'HH', 'IMP', 'ACUTE', 'NONAC', 'OBSENC', 'PRENC', 'SS', 'VR'].includes(classCode) ||
    ![
      'planned',
      'arrived',
      'triaged',
      'in-progress',
      'onleave',
      'finished',
      'cancelled',
      'entered-in-error',
      'unknown',
    ].includes(status)
  ) {
    throw new Error('Invalid FHIR encounter terminology mapping');
  }
  const encounter: Encounter = {
    resourceType: 'Encounter',
    id: localId(source.system, source.value),
    identifier: [source],
    status,
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: classCode },
    subject: { reference: `Patient/${patient.id}` },
    extension: [
      { url: `${base(policy)}/source-encounter-class`, valueCoding: originalClass },
      { url: `${base(policy)}/source-encounter-status`, valueCoding: originalStatus },
    ],
  };
  if (record.encounterType !== undefined) {
    encounter.type = [{ coding: [localCoding(record.encounterType, 'encounter-type', policy)] }];
  }
  const start = optionalText(record, 'arrivalDateTime');
  const end = optionalText(record, 'dischargeDateTime');
  if (start || end) {
    encounter.period = { start: start ? timestamp(start) : undefined, end: end ? timestamp(end) : undefined };
    if (start && end && Date.parse(start) > Date.parse(end)) {
      throw new Error('Encounter ends before it starts');
    }
  }
  const reason = optionalText(record, 'reasonForVisit');
  if (reason) {
    encounter.reasonCode = [{ text: reason }];
  }
  return encounter;
}
