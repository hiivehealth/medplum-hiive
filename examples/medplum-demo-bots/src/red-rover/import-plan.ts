import { randomUUID } from 'node:crypto';
import type { Bundle, BundleEntry, Resource, Task } from '@medplum/fhirtypes';
import { fingerprint } from './dry-run';
import type { DryRunResult } from './dry-run';

export interface ImportContext {
  identifierBase: string;
  expectedProjectId: string;
  currentProjectId: string;
  agentReference: string;
}

export function prepareImportLedger(result: DryRunResult, context: ImportContext): Task {
  if (
    !context.expectedProjectId ||
    context.expectedProjectId !== context.currentProjectId ||
    !/^(Device|Practitioner|Organization)\/[A-Za-z0-9.-]{1,64}$/.test(context.agentReference) ||
    result.report.mode !== 'dry-run' ||
    result.report.unsupportedFields.length !== 0
  ) {
    throw new Error('Import requires an isolated matching project and a fully mapped dry run');
  }
  return {
    resourceType: 'Task',
    status: 'requested',
    intent: 'order',
    identifier: [{ system: `${context.identifierBase}/import-operation`, value: result.report.operationKey }],
    code: { coding: [{ system: `${context.identifierBase}/workflow`, code: 'import-chart' }] },
    owner: { reference: context.agentReference },
    input: [{ type: { text: 'approved-plan-sha256' }, valueString: fingerprint(result.bundle) }],
  };
}

function rewriteReferences(value: unknown, references: ReadonlyMap<string, string>): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteReferences(item, references));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'reference' && typeof item === 'string'
        ? (references.get(item) ?? item)
        : rewriteReferences(item, references),
    ])
  );
}

export function prepareImportTransaction(result: DryRunResult, ledger: Task, context: ImportContext): Bundle {
  const expected = prepareImportLedger(result, context);
  if (
    !ledger.id ||
    !ledger.meta?.versionId ||
    !/^[A-Za-z0-9.-]{1,64}$/.test(ledger.meta.versionId) ||
    ledger.status !== 'requested' ||
    ledger.intent !== 'order' ||
    ledger.owner?.reference !== context.agentReference ||
    fingerprint(ledger.identifier) !== fingerprint(expected.identifier) ||
    fingerprint(ledger.code) !== fingerprint(expected.code) ||
    fingerprint(ledger.input) !== fingerprint(expected.input)
  ) {
    throw new Error('Import ledger is missing, changed, already claimed or approved for a different plan');
  }
  const resources = result.bundle.entry?.map((entry) => entry.resource);
  if (
    !resources ||
    resources.some((resource) => !resource) ||
    resources.filter((resource) => resource?.resourceType === 'Patient').length !== 1 ||
    resources.filter((resource) => resource?.resourceType === 'Provenance').length !== 1 ||
    resources.some((resource) => !['Patient', 'Encounter', 'Provenance'].includes(resource?.resourceType ?? ''))
  ) {
    throw new Error('Unsupported import bundle structure');
  }
  const references = new Map<string, string>();
  for (const resource of resources) {
    if (resource?.id) {
      const reference = `${resource.resourceType}/${resource.id}`;
      if (references.has(reference)) {
        throw new Error('Duplicate import reference');
      }
      references.set(reference, `urn:uuid:${randomUUID()}`);
    }
  }
  const entries: BundleEntry[] = resources.map((original) => {
    const resource = rewriteReferences(original, references) as Resource;
    const fullUrl = resource.id
      ? references.get(`${resource.resourceType}/${resource.id}`)
      : `urn:uuid:${randomUUID()}`;
    delete resource.id;
    delete resource.meta;
    let ifNoneExist: string | undefined;
    if (resource.resourceType === 'Patient' || resource.resourceType === 'Encounter') {
      const system = `${context.identifierBase}/${resource.resourceType.toLowerCase()}`;
      const identifiers = resource.identifier?.filter((value) => value.system === system);
      if (identifiers?.length !== 1 || !identifiers[0].value) {
        throw new Error('Import identifier namespace does not match its ledger');
      }
      ifNoneExist = new URLSearchParams({ identifier: `${system}|${identifiers[0].value}` }).toString();
    }
    return { fullUrl, resource, request: { method: 'POST', url: resource.resourceType, ifNoneExist } };
  });
  entries.push({
    resource: { ...ledger, status: 'completed' },
    request: { method: 'PUT', url: `Task/${ledger.id}`, ifMatch: `W/"${ledger.meta.versionId}"` },
  });
  return { resourceType: 'Bundle', type: 'transaction', entry: entries };
}
