export interface RedRoverConfig {
  readonly apiBaseUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userId: string;
  readonly scope: 'rrh/patientsEncounters:read';
  readonly patientIds: readonly string[];
  readonly timeoutMs: number;
  readonly encounterIdPagingConfirmed: boolean;
}

const ASSIGNED_PATIENTS = new Set(['19128435', '19128437', '19128439', '19128441', '19128443']);

function required(environment: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = environment[key];
  if (!value?.trim() || /[\r\n]/.test(value)) {
    throw new Error(`Missing or invalid ${key}`);
  }
  return value;
}

function endpoint(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${key}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid ${key}: expected HTTPS without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, '');
}

/**
 * Loads the explicitly confirmed UAT configuration for patient reads only.
 * @param environment - Server-side environment values.
 * @returns Immutable, validated read-only configuration.
 */
export function loadRedRoverConfig(environment: Readonly<Record<string, string | undefined>>): RedRoverConfig {
  if (environment.RED_ROVER_ENVIRONMENT !== 'uat' || environment.RED_ROVER_UAT_ENDPOINTS_CONFIRMED !== 'true') {
    throw new Error('Explicitly confirmed UAT endpoints are required');
  }
  if (environment.RED_ROVER_ENABLE_WRITES !== undefined && environment.RED_ROVER_ENABLE_WRITES !== 'false') {
    throw new Error('Clinical writes are not supported by this client');
  }
  const scope = required(environment, 'RED_ROVER_SCOPE');
  if (scope !== 'rrh/patientsEncounters:read') {
    throw new Error('Only rrh/patientsEncounters:read is supported');
  }
  const patientIds = required(environment, 'RED_ROVER_PATIENT_IDS')
    .split(',')
    .map((value) => value.trim());
  if (patientIds.some((patientId) => !ASSIGNED_PATIENTS.has(patientId))) {
    throw new Error('Patient allowlist must contain only assigned UAT patients');
  }
  const timeoutMs = Number(environment.RED_ROVER_TIMEOUT_MS ?? '15000');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
    throw new Error('RED_ROVER_TIMEOUT_MS must be an integer between 100 and 60000');
  }
  return Object.freeze({
    apiBaseUrl: endpoint(required(environment, 'RED_ROVER_API_BASE_URL'), 'RED_ROVER_API_BASE_URL'),
    tokenUrl: endpoint(required(environment, 'RED_ROVER_TOKEN_URL'), 'RED_ROVER_TOKEN_URL'),
    clientId: required(environment, 'RED_ROVER_CLIENT_ID'),
    clientSecret: required(environment, 'RED_ROVER_CLIENT_SECRET'),
    userId: required(environment, 'RED_ROVER_USER_ID'),
    scope,
    patientIds: Object.freeze([...new Set(patientIds)]),
    timeoutMs,
    encounterIdPagingConfirmed: environment.RED_ROVER_ENCOUNTER_ID_PAGING_CONFIRMED === 'true',
  });
}
