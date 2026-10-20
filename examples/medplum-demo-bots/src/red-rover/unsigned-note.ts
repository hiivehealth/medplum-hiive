import type { DocumentReference, Encounter, Patient, Task } from '@medplum/fhirtypes';
import { fingerprint } from './dry-run';
import { sourceId } from './response';

export interface UnsignedNotePolicy {
  identifierBase: string;
  allowedPatientIds: readonly string[];
  authorReference: string;
  authorId: string;
  templateRefId: string;
  documentTypeCode: string;
}

export interface UnsignedNoteRequest {
  patientId: string;
  encounterId: string;
  templateRefId: string;
  documentTypeCode: string;
  authorId: string;
  body: string;
}

export interface PreparedUnsignedNote {
  method: 'POST';
  path: '/api/v2/unsignedDynamicDocument';
  body: UnsignedNoteRequest;
  operationKey: string;
  sourceVersion: string;
  approvalVersion: string;
}

function externalId(resource: Patient | Encounter, system: string): string {
  const matches = resource.identifier?.filter((value) => value.system === system);
  if (matches?.length !== 1) {
    throw new Error('Missing or ambiguous source identifier');
  }
  return sourceId(matches[0].value);
}

function textBody(document: DocumentReference): string {
  if (document.content.length !== 1) {
    throw new Error('Exactly one inline plain-text attachment is required');
  }
  const attachment = document.content[0].attachment;
  if (
    attachment.contentType !== 'text/plain' ||
    !attachment.data ||
    attachment.url ||
    attachment.data.length > 350_000
  ) {
    throw new Error('Only bounded inline plain-text notes are supported');
  }
  const bytes = Buffer.from(attachment.data, 'base64');
  if (bytes.length > 256_000 || bytes.toString('base64') !== attachment.data) {
    throw new Error('Invalid or oversized note encoding');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const invalidXml = [...text].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return (point < 32 && ![9, 10, 13].includes(point)) || point === 0xfffe || point === 0xffff;
  });
  if (!text.trim() || invalidXml) {
    throw new Error('Empty note or invalid XML characters');
  }
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\r\n?|\n/g, '<br/>');
  return Buffer.from(`<div xmlns="http://www.w3.org/1999/xhtml"><p>${escaped}</p></div>`, 'utf8').toString('base64');
}

export function prepareUnsignedNote(
  document: DocumentReference,
  patient: Patient,
  encounter: Encounter,
  approval: Task,
  policy: UnsignedNotePolicy
): PreparedUnsignedNote {
  const namespace = new URL(policy.identifierBase);
  if (
    namespace.protocol !== 'https:' ||
    namespace.username ||
    namespace.password ||
    namespace.search ||
    namespace.hash ||
    policy.identifierBase.endsWith('/') ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(policy.templateRefId)
  ) {
    throw new Error('Invalid note export namespace or template');
  }
  if (
    !document.id ||
    !document.meta?.versionId ||
    !approval.id ||
    !approval.meta?.versionId ||
    !patient.id ||
    !encounter.id ||
    document.status !== 'current' ||
    document.docStatus !== 'preliminary' ||
    document.relatesTo?.length ||
    document.meta.source === policy.identifierBase
  ) {
    throw new Error('Export requires a versioned, local, preliminary note and approval');
  }
  const sourceVersion = `DocumentReference/${document.id}/_history/${document.meta.versionId}`;
  if (
    approval.status !== 'ready' ||
    approval.intent !== 'order' ||
    approval.focus?.reference !== sourceVersion ||
    !approval.businessStatus?.coding?.some(
      (coding) => coding.system === `${policy.identifierBase}/export-approval` && coding.code === 'approved'
    ) ||
    !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(approval.requester?.reference ?? '')
  ) {
    throw new Error('Approval must name this exact document version and an approving practitioner');
  }
  if (
    document.subject?.reference !== `Patient/${patient.id}` ||
    encounter.subject?.reference !== `Patient/${patient.id}` ||
    document.context?.encounter?.length !== 1 ||
    document.context.encounter[0].reference !== `Encounter/${encounter.id}` ||
    document.author?.length !== 1 ||
    document.author[0].reference !== policy.authorReference ||
    !/^Practitioner\/[A-Za-z0-9.-]{1,64}$/.test(policy.authorReference)
  ) {
    throw new Error('Note patient, encounter or author does not match the approved crosswalk');
  }
  const patientId = externalId(patient, `${policy.identifierBase}/patient`);
  if (!policy.allowedPatientIds.includes(patientId)) {
    throw new Error('Note patient is outside the approved UAT cohort');
  }
  const body: UnsignedNoteRequest = {
    patientId,
    encounterId: externalId(encounter, `${policy.identifierBase}/encounter`),
    templateRefId: policy.templateRefId,
    documentTypeCode: sourceId(policy.documentTypeCode),
    authorId: sourceId(policy.authorId),
    body: textBody(document),
  };
  return {
    method: 'POST',
    path: '/api/v2/unsignedDynamicDocument',
    body,
    sourceVersion,
    approvalVersion: `Task/${approval.id}/_history/${approval.meta.versionId}`,
    operationKey: fingerprint({ sourceVersion, namespace: policy.identifierBase, body }),
  };
}

export type DeliveryState =
  | { status: 'approved'; operationKey: string }
  | { status: 'in-flight'; operationKey: string }
  | { status: 'uncertain'; operationKey: string }
  | { status: 'read-back'; operationKey: string; documentId: string }
  | { status: 'completed'; operationKey: string; documentId: string }
  | { status: 'quarantined'; operationKey: string };

export type DeliveryEvent =
  | { type: 'claimed' }
  | { type: 'transport-uncertain' }
  | { type: 'created'; documentId: string }
  | { type: 'reconciled'; documentId: string }
  | { type: 'verified'; documentId: string; bodyMatches: boolean; identityMatches: boolean; unsigned: boolean }
  | { type: 'quarantine' };

export function advanceDelivery(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  const operationKey = state.operationKey;
  if (event.type === 'quarantine' && state.status !== 'completed') {
    return { status: 'quarantined', operationKey };
  }
  if (event.type === 'claimed' && state.status === 'approved') {
    return { status: 'in-flight', operationKey };
  }
  if (event.type === 'transport-uncertain' && state.status === 'in-flight') {
    return { status: 'uncertain', operationKey };
  }
  if (
    (event.type === 'created' && state.status === 'in-flight') ||
    (event.type === 'reconciled' && state.status === 'uncertain')
  ) {
    return { status: 'read-back', operationKey, documentId: sourceId(event.documentId) };
  }
  if (event.type === 'verified' && state.status === 'read-back' && event.documentId === state.documentId) {
    return event.bodyMatches && event.identityMatches && event.unsigned
      ? { status: 'completed', operationKey, documentId: state.documentId }
      : { status: 'quarantined', operationKey };
  }
  throw new Error('Invalid delivery transition; uncertain writes must never be retried blindly');
}
