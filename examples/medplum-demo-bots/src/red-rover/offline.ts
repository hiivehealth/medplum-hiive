import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { indexStructureDefinitionBundle } from '@medplum/core';
import { readJson } from '@medplum/definitions';
import type { Bundle } from '@medplum/fhirtypes';
import { prepareChart, prepareMappingReview } from './dry-run';
import type { ChartSnapshot, DryRunContext, DryRunResult, MappingReview } from './dry-run';
import type { MappingPolicy } from './mapping';
import { object } from './response';
import type { JsonObject } from './response';

function privatePath(mode: number, uid: number): void {
  if ((mode & 0o077) !== 0 || uid !== process.getuid?.()) {
    throw new Error('Owner-only filesystem permissions are required');
  }
}

async function readPrivateJson(inputPath: string): Promise<JsonObject> {
  const input = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await input.stat();
    privatePath(metadata.mode, metadata.uid);
    if (!metadata.isFile() || metadata.size > 20_000_000) {
      throw new Error('Invalid input file');
    }
    return object(JSON.parse(await input.readFile('utf8')));
  } finally {
    await input.close();
  }
}

async function writePrivateJson(outputPath: string, value: unknown): Promise<void> {
  const directory = await lstat(dirname(outputPath));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Private output directory required');
  }
  privatePath(directory.mode, directory.uid);
  const output = await open(outputPath, 'wx', 0o600);
  try {
    await output.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, 'utf8');
    await output.sync();
  } finally {
    await output.close();
  }
}

function loadDefinitions(): void {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
}

export async function runOffline(inputPath: string, outputPath: string): Promise<DryRunResult['report']> {
  try {
    const value = await readPrivateJson(inputPath);
    loadDefinitions();
    const result = prepareChart(
      object(value.snapshot) as unknown as ChartSnapshot,
      object(value.policy) as unknown as MappingPolicy,
      object(value.context) as unknown as DryRunContext
    );
    await writePrivateJson(outputPath, result);
    return result.report;
  } catch {
    throw new Error(
      'Offline dry run failed; check mapping, private-file permissions and a new output path. Details withheld.'
    );
  }
}

/**
 * Reviews an already saved snapshot without network access, imports or policy approval.
 * @param inputPath - Owner-only completed sandbox-read artifact.
 * @param outputPath - New owner-only review artifact containing sensitive draft resources.
 * @returns A private mapping review report; do not print its source terminology details.
 */
export async function runMappingReview(inputPath: string, outputPath: string): Promise<MappingReview['report']> {
  try {
    const value = await readPrivateJson(inputPath);
    if (value.status !== 'complete' || object(value.report).mode !== 'read-only') {
      throw new Error('A completed read-only snapshot is required');
    }
    loadDefinitions();
    const result = prepareMappingReview(object(value.snapshot) as unknown as ChartSnapshot, {
      recorded: new Date().toISOString(),
      agentReference: 'Device/unprovisioned-offline-review',
      mappingRevision: 'unapproved-review-v1',
    });
    await writePrivateJson(outputPath, result);
    return result.report;
  } catch {
    throw new Error(
      'Mapping review failed; check completed snapshot, source values and private paths. Details withheld.'
    );
  }
}
