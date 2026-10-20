import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preflightSandbox, runSandboxRead } from './sandbox';
import type { SandboxReadRequest } from './sandbox';

const directories: string[] = [];
const environment = {
  RED_ROVER_ENVIRONMENT: 'uat',
  RED_ROVER_UAT_ENDPOINTS_CONFIRMED: 'true',
  RED_ROVER_API_BASE_URL: 'https://api.example.test/uat',
  RED_ROVER_TOKEN_URL: 'https://auth.example.test/token',
  RED_ROVER_CLIENT_ID: 'synthetic-client',
  RED_ROVER_CLIENT_SECRET: 'synthetic-secret',
  RED_ROVER_USER_ID: 'test-audit',
  RED_ROVER_SCOPE: 'rrh/patientsEncounters:read',
  RED_ROVER_PATIENT_IDS: '19128435',
  RED_ROVER_ENABLE_WRITES: 'false',
  RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED: 'true',
  RED_ROVER_READ_ACCESS_CONFIRMED: 'true',
};

async function setup(changes: Readonly<Record<string, string | undefined>> = {}): Promise<SandboxReadRequest> {
  const directory = await mkdtemp(join(tmpdir(), 'red-rover-sandbox-'));
  directories.push(directory);
  await chmod(directory, 0o700);
  const configPath = join(directory, 'configuration.json');
  await writeFile(configPath, JSON.stringify({ ...environment, ...changes }), { mode: 0o600 });
  return {
    configPath,
    outputPath: join(directory, 'snapshot.json'),
    patientId: '19128435',
    expectedEncounterId: '61221038',
    authorizeLiveRead: true,
  };
}

function transport(patientId = '19128435', encounterId = '61221038'): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 }))
    .mockResolvedValueOnce(
      Response.json({ meta: { status: 'S', returnedCount: 1, totalCount: 1 }, data: [{ patientId: 19128435 }] })
    )
    .mockResolvedValueOnce(
      Response.json({ meta: { status: 'S', returnedCount: 1, totalCount: 1 }, data: [{ patientId, encounterId }] })
    );
}

describe('Guarded sandbox read runner', () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('preflights without network access or credential output', async () => {
    const request = await setup();
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      expect(await preflightSandbox(request)).toEqual({ readyForReadAttempt: true, networkCalls: 0 });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it('persists only a validated snapshot and returns a non-clinical report', async () => {
    const request = await setup();
    const fetcher = transport();
    expect(await runSandboxRead(request, fetcher)).toEqual({
      mode: 'read-only',
      patientCount: 1,
      encounterCount: 1,
      expectedEncounterVerified: true,
    });
    const text = await readFile(request.outputPath, 'utf8');
    const artifact = JSON.parse(text);
    expect(artifact.status).toBe('complete');
    expect(artifact.snapshot.patient.patientId).toBe(19128435);
    expect(text).not.toContain('synthetic-secret');
    expect(text).not.toContain('synthetic-token');
    expect((await stat(request.outputPath)).mode & 0o777).toBe(0o600);
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each([
    { RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED: 'false' },
    { RED_ROVER_READ_ACCESS_CONFIRMED: 'false' },
    { RED_ROVER_ENABLE_WRITES: 'true' },
    { RED_ROVER_UAT_ENDPOINTS_CONFIRMED: 'false' },
  ])('blocks unconfirmed gates before network access', async (changes) => {
    const request = await setup(changes);
    const fetcher = transport();
    await expect(runSandboxRead(request, fetcher)).rejects.toThrow('Details withheld');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(stat(request.outputPath)).rejects.toThrow();
  });

  async function overriddenRequest(
    changes: Readonly<Record<string, string | undefined>> = {}
  ): Promise<SandboxReadRequest> {
    return {
      ...(await setup({
        RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED: 'false',
        RED_ROVER_API_BASE_URL: 'https://api-us-uat.redrover.health/uat',
        RED_ROVER_TOKEN_URL: 'https://api-us-uat-auth.redrover.health/oauth2/token',
        ...changes,
      })),
      unrotatedCredentialOverride: {
        acknowledgeExposure: true,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    };
  }

  it('permits an acknowledged, unexpired UAT read without falsely recording rotation', async () => {
    const request = await overriddenRequest();
    await expect(preflightSandbox(request)).resolves.toEqual({ readyForReadAttempt: true, networkCalls: 0 });
    const fetcher = transport();
    await expect(runSandboxRead(request, fetcher)).resolves.toMatchObject({ credentialRiskOverrideUsed: true });
    const artifact = JSON.parse(await readFile(request.outputPath, 'utf8'));
    expect(artifact.credentialRiskOverride).toEqual(request.unrotatedCredentialOverride);
    expect(JSON.parse(await readFile(request.configPath, 'utf8')).RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED).toBe(
      'false'
    );
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it.each([
    { acknowledgeExposure: false, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { acknowledgeExposure: 'true', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { acknowledgeExposure: true, expiresAt: 'invalid' },
    { acknowledgeExposure: true, expiresAt: new Date(Date.now() - 1).toISOString() },
    { acknowledgeExposure: true, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
  ])('rejects invalid or expired credential-risk overrides before any network call', async (override) => {
    const request = await overriddenRequest();
    const fetcher = transport();
    await expect(
      runSandboxRead({ ...request, unrotatedCredentialOverride: override } as unknown as SandboxReadRequest, fetcher)
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { RED_ROVER_ENVIRONMENT: 'production' },
    { RED_ROVER_API_BASE_URL: 'https://api-us-prod.redrover.health/uat' },
    { RED_ROVER_TOKEN_URL: 'https://api-us-prod-auth.redrover.health/oauth2/token' },
    { RED_ROVER_READ_ACCESS_CONFIRMED: 'false' },
    { RED_ROVER_UAT_ENDPOINTS_CONFIRMED: 'false' },
    { RED_ROVER_ENABLE_WRITES: 'true' },
    { RED_ROVER_SCOPE: 'rrh/documents:write' },
    { RED_ROVER_PATIENT_IDS: '19128437' },
  ])('cannot use the override to bypass any other sandbox safeguard', async (changes) => {
    const request = await overriddenRequest(changes);
    const fetcher = transport();
    await expect(runSandboxRead(request, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, 'true', 1, undefined])(
    'refuses runtime calls without explicit boolean read authorization',
    async (authorizeLiveRead) => {
      const request = await setup();
      const fetcher = transport();
      await expect(
        runSandboxRead({ ...request, authorizeLiveRead } as unknown as SandboxReadRequest, fetcher)
      ).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    { patientId: '19128437', encounterId: '61221038' },
    { patientId: '19128435', encounterId: '61221039' },
  ])(
    'rejects wrong patient or expected encounter and leaves an incomplete marker',
    async ({ patientId, encounterId }) => {
      const request = await setup();
      await expect(runSandboxRead(request, transport(patientId, encounterId))).rejects.toThrow('Details withheld');
      expect(JSON.parse(await readFile(request.outputPath, 'utf8'))).toEqual({
        status: 'incomplete',
        mode: 'read-only',
      });
    }
  );

  it('refuses shared-readable configuration and symlink configuration before network access', async () => {
    const request = await setup();
    const fetcher = transport();
    await chmod(request.configPath, 0o644);
    await expect(runSandboxRead(request, fetcher)).rejects.toThrow();
    await chmod(request.configPath, 0o600);
    const linked = `${request.configPath}.link`;
    await symlink(request.configPath, linked);
    await expect(runSandboxRead({ ...request, configPath: linked }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses existing or symlink outputs before network access', async () => {
    const request = await setup();
    const fetcher = transport();
    await writeFile(request.outputPath, 'existing', { mode: 0o600 });
    await expect(runSandboxRead(request, fetcher)).rejects.toThrow();
    expect(await readFile(request.outputPath, 'utf8')).toBe('existing');
    const linked = `${request.outputPath}.link`;
    await symlink(request.outputPath, linked);
    await expect(runSandboxRead({ ...request, outputPath: linked }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
