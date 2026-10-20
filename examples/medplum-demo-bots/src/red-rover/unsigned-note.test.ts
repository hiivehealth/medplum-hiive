import { describe, expect, it } from 'vitest';
import type { DocumentReference, Encounter, Patient, Task } from '@medplum/fhirtypes';
import { advanceDelivery, prepareUnsignedNote } from './unsigned-note';
import type { DeliveryState, UnsignedNotePolicy } from './unsigned-note';

const namespace = 'https://example.test/rr/uat';
const patient: Patient = {
  resourceType: 'Patient',
  id: 'patient',
  identifier: [{ system: `${namespace}/patient`, value: '19128435' }],
};
const encounter: Encounter = {
  resourceType: 'Encounter',
  id: 'encounter',
  status: 'finished',
  class: { code: 'AMB' },
  subject: { reference: 'Patient/patient' },
  identifier: [{ system: `${namespace}/encounter`, value: '61221038' }],
};
const document: DocumentReference = {
  resourceType: 'DocumentReference',
  id: 'note',
  meta: { versionId: 'v1' },
  status: 'current',
  docStatus: 'preliminary',
  subject: { reference: 'Patient/patient' },
  author: [{ reference: 'Practitioner/author' }],
  context: { encounter: [{ reference: 'Encounter/encounter' }] },
  content: [
    { attachment: { contentType: 'text/plain', data: Buffer.from('A < B & C\nSynthetic note.').toString('base64') } },
  ],
};
const approval: Task = {
  resourceType: 'Task',
  id: 'approval',
  meta: { versionId: 'a1' },
  status: 'ready',
  intent: 'order',
  focus: { reference: 'DocumentReference/note/_history/v1' },
  requester: { reference: 'Practitioner/reviewer' },
  businessStatus: { coding: [{ system: `${namespace}/export-approval`, code: 'approved' }] },
};
const policy: UnsignedNotePolicy = {
  identifierBase: namespace,
  allowedPatientIds: ['19128435'],
  authorReference: 'Practitioner/author',
  authorId: '3456789',
  templateRefId: '233455',
  documentTypeCode: '21369300',
};

describe('Unsigned note request preparation', () => {
  it('creates the documented base64 XHTML request without any network capability', () => {
    const result = prepareUnsignedNote(document, patient, encounter, approval, policy);
    expect(result.path).toBe('/api/v2/unsignedDynamicDocument');
    expect(result.body).toMatchObject({ patientId: '19128435', encounterId: '61221038', authorId: '3456789' });
    expect(Buffer.from(result.body.body, 'base64').toString('utf8')).toBe(
      '<div xmlns="http://www.w3.org/1999/xhtml"><p>A &lt; B &amp; C<br/>Synthetic note.</p></div>'
    );
    expect(result.sourceVersion).toBe('DocumentReference/note/_history/v1');
    expect(prepareUnsignedNote(document, patient, encounter, approval, policy).operationKey).toBe(result.operationKey);
  });

  it.each([
    { meta: { versionId: 'v2' } },
    { meta: { versionId: 'v1', source: namespace } },
    { docStatus: 'final' },
    { subject: { reference: 'Patient/other' } },
    { context: { encounter: [{ reference: 'Encounter/other' }] } },
    { author: [{ reference: 'Practitioner/other' }] },
    { content: [{ attachment: { contentType: 'text/html', data: 'PHNjcmlwdD4=' } }] },
    { content: [{ attachment: { contentType: 'text/plain', data: '%%%invalid%%%' } }] },
    { content: [{ attachment: { contentType: 'text/plain', data: Buffer.from('\u0000').toString('base64') } }] },
    { content: [{ attachment: { contentType: 'text/plain', url: 'https://example.test/note' } }] },
  ] as Partial<DocumentReference>[])('rejects stale, foreign, signed or unsupported notes', (changes) => {
    expect(() => prepareUnsignedNote({ ...document, ...changes }, patient, encounter, approval, policy)).toThrow();
  });

  it('rejects missing approval, ambiguous crosswalks and out-of-cohort patients', () => {
    expect(() => prepareUnsignedNote(document, patient, encounter, { ...approval, status: 'draft' }, policy)).toThrow();
    expect(() =>
      prepareUnsignedNote(
        document,
        { ...patient, identifier: [...(patient.identifier ?? []), ...(patient.identifier ?? [])] },
        encounter,
        approval,
        policy
      )
    ).toThrow();
    expect(() =>
      prepareUnsignedNote(document, patient, encounter, approval, { ...policy, allowedPatientIds: [] })
    ).toThrow();
  });
});

describe('Outbound delivery transition policy', () => {
  const approved: DeliveryState = { status: 'approved', operationKey: 'operation-key' };

  it('requires claim, remote identity and matching unsigned read-back before completion', () => {
    const sending = advanceDelivery(approved, { type: 'claimed' });
    const readBack = advanceDelivery(sending, { type: 'created', documentId: '5699884019' });
    expect(readBack.status).toBe('read-back');
    expect(
      advanceDelivery(readBack, {
        type: 'verified',
        documentId: '5699884019',
        bodyMatches: true,
        identityMatches: true,
        unsigned: true,
      }).status
    ).toBe('completed');
    expect(
      advanceDelivery(readBack, {
        type: 'verified',
        documentId: '5699884019',
        bodyMatches: false,
        identityMatches: true,
        unsigned: true,
      }).status
    ).toBe('quarantined');
  });

  it('cannot resend after an uncertain result and requires reconciliation first', () => {
    const uncertain = advanceDelivery(advanceDelivery(approved, { type: 'claimed' }), { type: 'transport-uncertain' });
    expect(() => advanceDelivery(uncertain, { type: 'claimed' })).toThrow();
    expect(() => advanceDelivery(uncertain, { type: 'created', documentId: '5699884019' })).toThrow();
    expect(advanceDelivery(uncertain, { type: 'reconciled', documentId: '5699884019' }).status).toBe('read-back');
  });

  it('does not accept read-back of a different remote document or replay a completed delivery', () => {
    const readBack = advanceDelivery(advanceDelivery(approved, { type: 'claimed' }), {
      type: 'created',
      documentId: '5699884019',
    });
    expect(() =>
      advanceDelivery(readBack, {
        type: 'verified',
        documentId: '999',
        bodyMatches: true,
        identityMatches: true,
        unsigned: true,
      })
    ).toThrow();
    const complete = advanceDelivery(readBack, {
      type: 'verified',
      documentId: '5699884019',
      bodyMatches: true,
      identityMatches: true,
      unsigned: true,
    });
    expect(() => advanceDelivery(complete, { type: 'claimed' })).toThrow();
  });
});
