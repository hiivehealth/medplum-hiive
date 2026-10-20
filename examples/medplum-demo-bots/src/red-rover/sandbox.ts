import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RedRoverClient } from './client';
import { loadRedRoverConfig } from './config';
import { object, sourceId } from './response';

export interface SandboxRequest {
  configPath: string;
  patientId: string;
  expectedEncounterId: string;
  unrotatedCredentialOverride?: {
    acknowledgeExposure: true;
    expiresAt: string;
  };
}

export interface SandboxReadRequest extends SandboxRequest {
  outputPath: string;
  authorizeLiveRead: true;
}

export interface SandboxReadReport {
  mode: 'read-only';
  patientCount: 1;
  encounterCount: number;
  expectedEncounterVerified: true;
  credentialRiskOverrideUsed?: true;
}

function acceptsCredentialRisk(request: SandboxRequest, environment: Readonly<Record<string, string>>): boolean {
  const override = request.unrotatedCredentialOverride;
  if (!override || object(override).acknowledgeExposure !== true || typeof override.expiresAt !== 'string') {
    return false;
  }
  const expiresAt = Date.parse(override.expiresAt);
  const remaining = expiresAt - Date.now();
  return (
    environment.RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED === 'false' &&
    environment.RED_ROVER_API_BASE_URL.replace(/\/$/, '') === 'https://api-us-uat.redrover.health/uat' &&
    environment.RED_ROVER_TOKEN_URL.replace(/\/$/, '') === 'https://api-us-uat-auth.redrover.health/oauth2/token' &&
    Number.isFinite(expiresAt) &&
    remaining > 0 &&
    remaining <= 15 * 60 * 1000 &&
    new Date(expiresAt).toISOString() === override.expiresAt
  );
}

function ownerOnly(mode: number, uid: number): void {
  if ((mode & 0o077) !== 0 || uid !== process.getuid?.()) {
    throw new Error('Owner-only filesystem permissions required');
  }
}

async function privateDirectory(path: string): Promise<void> {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Private directory required');
  }
  ownerOnly(directory.mode, directory.uid);
}

async function configuration(request: SandboxRequest): Promise<Record<string, string>> {
  await privateDirectory(request.configPath);
  const input = await open(request.configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await input.stat();
    ownerOnly(metadata.mode, metadata.uid);
    if (!metadata.isFile() || metadata.size > 65_536) {
      throw new Error('Invalid configuration file');
    }
    const parsed = object(JSON.parse(await input.readFile('utf8')));
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith('RED_ROVER_') || typeof value !== 'string') {
        throw new Error('Configuration must contain only Red Rover string values');
      }
      environment[key] = value;
    }
    const config = loadRedRoverConfig(environment);
    if (
      (environment.RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED !== 'true' &&
        !acceptsCredentialRisk(request, environment)) ||
      environment.RED_ROVER_READ_ACCESS_CONFIRMED !== 'true'
    ) {
      throw new Error(
        'Approved read access and either rotation or a temporary UAT credential-risk acknowledgment are required'
      );
    }
    if (
      !config.patientIds.includes(request.patientId) ||
      sourceId(request.expectedEncounterId) !== request.expectedEncounterId
    ) {
      throw new Error('Invalid patient or expected encounter selection');
    }
    return environment;
  } finally {
    await input.close();
  }
}

/**
 * Validates private sandbox configuration without authenticating or calling an API.
 * @param request - Private configuration location and approved patient/encounter selection.
 * @returns A non-sensitive readiness indicator; not proof of vendor access or rotation.
 */
export async function preflightSandbox(
  request: SandboxRequest
): Promise<{ readyForReadAttempt: true; networkCalls: 0 }> {
  try {
    await configuration(request);
    return { readyForReadAttempt: true, networkCalls: 0 };
  } catch {
    throw new Error('Sandbox preflight failed; check private configuration and confirmation gates. Details withheld.');
  }
}

/**
 * Retrieves and privately stores one explicitly authorized UAT patient/encounter snapshot.
 * @param request - Explicit read authorization, private paths and expected clinical identities.
 * @param fetcher - Optional transport for offline testing; defaults to native fetch.
 * @returns Counts and verification status without patient data, IDs or credentials.
 */
export async function runSandboxRead(
  request: SandboxReadRequest,
  fetcher: typeof fetch = fetch
): Promise<SandboxReadReport> {
  try {
    if (object(request).authorizeLiveRead !== true) {
      throw new Error('Explicit live-read authorization required');
    }
    const environment = await configuration(request);
    await privateDirectory(request.outputPath);
    const output = await open(request.outputPath, 'wx', 0o600);
    try {
      await output.writeFile('{"status":"incomplete","mode":"read-only"}\n');
      await output.sync();
      const client = new RedRoverClient(environment, fetcher);
      const patient = await client.getPatientRecord(request.patientId);
      const encounters = await client.getEncounters(request.patientId);
      if (encounters.filter((record) => sourceId(record.encounterId) === request.expectedEncounterId).length !== 1) {
        throw new Error('Expected encounter did not resolve to this patient');
      }
      const report: SandboxReadReport = {
        mode: 'read-only',
        patientCount: 1,
        encounterCount: encounters.length,
        expectedEncounterVerified: true,
        ...(environment.RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED === 'false'
          ? ({ credentialRiskOverrideUsed: true } as const)
          : {}),
      };
      const artifact = JSON.stringify(
        {
          status: 'complete',
          recorded: new Date().toISOString(),
          report,
          ...(report.credentialRiskOverrideUsed ? { credentialRiskOverride: request.unrotatedCredentialOverride } : {}),
          snapshot: { patientId: request.patientId, patient, encounters },
        },
        undefined,
        2
      );
      const content = Buffer.from(`${artifact}\n`);
      await output.truncate(0);
      let offset = 0;
      while (offset < content.byteLength) {
        const { bytesWritten } = await output.write(content, offset, content.byteLength - offset, offset);
        if (bytesWritten === 0) {
          throw new Error('Snapshot write made no progress');
        }
        offset += bytesWritten;
      }
      await output.sync();
      return report;
    } finally {
      await output.close();
    }
  } catch {
    throw new Error(
      'Sandbox read failed; inspect readiness and protected artifacts before retrying. Details withheld.'
    );
  }
}
