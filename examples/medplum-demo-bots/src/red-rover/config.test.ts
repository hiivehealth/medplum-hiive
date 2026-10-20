import { describe, expect, it } from 'vitest';
import { loadRedRoverConfig } from './config';

export function testEnvironment(): Record<string, string> {
  return {
    RED_ROVER_ENVIRONMENT: 'uat',
    RED_ROVER_UAT_ENDPOINTS_CONFIRMED: 'true',
    RED_ROVER_API_BASE_URL: 'https://api.example.test/uat',
    RED_ROVER_TOKEN_URL: 'https://auth.example.test/oauth2/token',
    RED_ROVER_CLIENT_ID: 'test-client',
    RED_ROVER_CLIENT_SECRET: 'synthetic-test-secret',
    RED_ROVER_USER_ID: 'test-audit-user',
    RED_ROVER_SCOPE: 'rrh/patientsEncounters:read',
    RED_ROVER_PATIENT_IDS: '19128435',
  };
}

describe('Red Rover configuration', () => {
  it('loads immutable, read-only UAT configuration', () => {
    const config = loadRedRoverConfig(testEnvironment());
    expect(config.patientIds).toEqual(['19128435']);
    expect(config.timeoutMs).toBe(15000);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.patientIds)).toBe(true);
  });

  it.each([
    ['RED_ROVER_ENVIRONMENT', 'production'],
    ['RED_ROVER_UAT_ENDPOINTS_CONFIRMED', 'false'],
    ['RED_ROVER_ENABLE_WRITES', 'true'],
    ['RED_ROVER_SCOPE', 'rrh/documents:write'],
    ['RED_ROVER_PATIENT_IDS', '19128435,999999'],
    ['RED_ROVER_PATIENT_IDS', ''],
    ['RED_ROVER_CLIENT_SECRET', ''],
    ['RED_ROVER_USER_ID', 'user\r\ninjected-header: value'],
    ['RED_ROVER_API_BASE_URL', 'http://api.example.test'],
    ['RED_ROVER_API_BASE_URL', 'https://user:secret@api.example.test'],
    ['RED_ROVER_TOKEN_URL', 'https://auth.example.test/token?secret=value'],
    ['RED_ROVER_TOKEN_URL', 'not-a-url'],
    ['RED_ROVER_TIMEOUT_MS', 'NaN'],
    ['RED_ROVER_TIMEOUT_MS', '60001'],
  ])('rejects unsafe %s configuration', (key, value) => {
    expect(() => loadRedRoverConfig({ ...testEnvironment(), [key]: value })).toThrow();
  });

  it('deduplicates explicitly selected assigned patients', () => {
    expect(
      loadRedRoverConfig({ ...testEnvironment(), RED_ROVER_PATIENT_IDS: '19128435, 19128435' }).patientIds
    ).toEqual(['19128435']);
  });

  it('does not include credential values in configuration errors', () => {
    expect(() => loadRedRoverConfig({ ...testEnvironment(), RED_ROVER_TOKEN_URL: 'synthetic-test-secret' })).toThrow(
      'Invalid RED_ROVER_TOKEN_URL'
    );
  });
});
