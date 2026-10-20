import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMappingReview, runOffline } from './offline';

const directories: string[] = [];
const inputData = {
  snapshot: { patientId: '19128435', patient: { patientId: 19128435 }, encounters: [] },
  policy: {
    identifierBase: 'https://example.test/rr/uat',
    genderCodes: {},
    encounterClassCodes: {},
    encounterStatusCodes: {},
  },
  context: { recorded: '2026-10-19T10:00:00Z', agentReference: 'Device/connector', mappingRevision: 'v1' },
};

async function setup(): Promise<{ directory: string; input: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'red-rover-offline-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify(inputData), { mode: 0o600 });
  return { directory, input, output: join(directory, 'chart.json') };
}

describe('Protected offline file runner', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('creates a private dry-run artifact and refuses to overwrite it', async () => {
    const { input, output } = await setup();
    expect(await runOffline(input, output)).toMatchObject({ mode: 'dry-run', patientCount: 1, encounterCount: 0 });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(await readFile(output, 'utf8'));
    expect(artifact.bundle.type).toBe('collection');
    await expect(runOffline(input, output)).rejects.toThrow('Details withheld');
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(artifact);
  });

  it('rejects a shared-readable source file', async () => {
    const { input, output } = await setup();
    await chmod(input, 0o644);
    await expect(runOffline(input, output)).rejects.toThrow('Details withheld');
    await expect(stat(output)).rejects.toThrow();
  });

  it('rejects a shared output directory', async () => {
    const { directory, input, output } = await setup();
    await chmod(directory, 0o755);
    await expect(runOffline(input, output)).rejects.toThrow('Details withheld');
  });

  it('rejects symlink input and hides malformed input values', async () => {
    const { directory, input, output } = await setup();
    const linked = join(directory, 'linked.json');
    await symlink(input, linked);
    await expect(runOffline(linked, output)).rejects.toThrow('Details withheld');
    await writeFile(input, 'private-invalid-value');
    await expect(runOffline(input, output)).rejects.toThrow(/^Offline dry run failed;.*Details withheld\.$/);
  });

  it('saves a private review-only draft from a completed snapshot without any network access', async () => {
    const { input, output } = await setup();
    await writeFile(
      input,
      JSON.stringify({
        status: 'complete',
        report: { mode: 'read-only' },
        snapshot: {
          ...inputData.snapshot,
          patient: { ...inputData.snapshot.patient, confidentiality: { code: 0, display: '' } },
        },
      })
    );
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await runMappingReview(input, output)).toMatchObject({
        mode: 'mapping-review',
        importAllowed: false,
        fhirValidation: 'passed',
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, 'utf8')).bundle.type).toBe('collection');
    await expect(runMappingReview(input, output)).rejects.toThrow('Details withheld');
  });

  it('rejects incomplete or shared-readable review input', async () => {
    const { input, output } = await setup();
    await writeFile(
      input,
      JSON.stringify({ status: 'incomplete', report: { mode: 'read-only' }, snapshot: inputData.snapshot })
    );
    await expect(runMappingReview(input, output)).rejects.toThrow('Details withheld');
    await writeFile(
      input,
      JSON.stringify({ status: 'complete', report: { mode: 'read-only' }, snapshot: inputData.snapshot })
    );
    await chmod(input, 0o644);
    await expect(runMappingReview(input, output)).rejects.toThrow('Details withheld');
    await expect(stat(output)).rejects.toThrow();
  });
});
