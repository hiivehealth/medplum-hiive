import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedRoverClient } from './client';

const environment = {
  RED_ROVER_ENVIRONMENT: 'uat',
  RED_ROVER_UAT_ENDPOINTS_CONFIRMED: 'true',
  RED_ROVER_ENCOUNTER_ID_PAGING_CONFIRMED: 'true',
  RED_ROVER_API_BASE_URL: 'https://api.example.test/uat',
  RED_ROVER_TOKEN_URL: 'https://auth.example.test/oauth2/token',
  RED_ROVER_CLIENT_ID: 'test-client',
  RED_ROVER_CLIENT_SECRET: 'synthetic-secret',
  RED_ROVER_USER_ID: 'test-audit-user',
  RED_ROVER_SCOPE: 'rrh/patientsEncounters:read',
  RED_ROVER_PATIENT_IDS: '19128435',
};

function tokenResponse(): Response {
  return Response.json({ access_token: 'synthetic-token', token_type: 'Bearer', expires_in: 3600 });
}

describe('Red Rover read-only transport', () => {
  afterEach(() => vi.useRealTimers());

  it('retrieves validated patient identity and refuses incomplete patient responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        Response.json({
          meta: { status: 'S', returnedCount: 1, totalCount: 1 },
          data: [{ patientId: 19128435 }],
        })
      );
    await expect(new RedRoverClient(environment, fetcher).getPatientRecord('19128435')).resolves.toEqual({
      patientId: 19128435,
    });
    const incomplete = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        Response.json({
          meta: { status: 'S', returnedCount: 1, totalCount: 2, pagination: { id: 19128435 } },
          data: [{ patientId: 19128435 }],
        })
      );
    await expect(new RedRoverClient(environment, incomplete).getPatientRecord('19128435')).rejects.toThrow(
      'incomplete'
    );
  });

  it('retrieves every ID-paginated encounter and resolves its patient identity', async () => {
    const first = { encounterId: '61221038', patientId: '19128435' };
    const second = { encounterId: '61221039', patientId: '19128435' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        Response.json({
          meta: { status: 'S', returnedCount: 1, totalCount: 2, pagination: { id: 61221038 } },
          data: [first],
        })
      )
      .mockResolvedValueOnce(Response.json({ meta: { status: 'S', returnedCount: 1, totalCount: 1 }, data: [second] }));
    await expect(new RedRoverClient(environment, fetcher).getEncounters('19128435')).resolves.toEqual([first, second]);
    expect(fetcher.mock.calls[2][0]).toBe(
      'https://api.example.test/uat/api/v2/patients/encounters?patientIds=19128435&maxResults=100&paginationId=61221038'
    );
  });

  it('refuses unconfirmed ID ordering instead of returning a truncated chart', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        Response.json({
          meta: { status: 'S', returnedCount: 1, totalCount: 2, pagination: { id: 61221038 } },
          data: [{ encounterId: '61221038', patientId: '19128435' }],
        })
      );
    await expect(
      new RedRoverClient({ ...environment, RED_ROVER_ENCOUNTER_ID_PAGING_CONFIRMED: undefined }, fetcher).getEncounters(
        '19128435'
      )
    ).rejects.toThrow('requires site confirmation');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { data: [{ encounterId: '61221038', patientId: '19128437' }] },
    {
      data: [
        { encounterId: '61221038', patientId: '19128435' },
        { encounterId: '61221038', patientId: '19128435' },
      ],
    },
  ])('rejects wrong-patient or repeated encounters', async ({ data }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        Response.json({
          meta: { status: 'S', returnedCount: data.length, totalCount: data.length },
          data,
        })
      );
    await expect(new RedRoverClient(environment, fetcher).getEncounters('19128435')).rejects.toThrow();
  });

  it('blocks unassigned patients before any OAuth or clinical request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new RedRoverClient(environment, fetcher).getPatient('999999')).rejects.toThrow('allowlist');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('acquires a token, preserves the UAT prefix, and sends only an allowlisted GET', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ unvalidated: true }));
    const client = new RedRoverClient(environment, fetcher);
    await expect(client.getPatient('19128435')).resolves.toEqual({ unvalidated: true });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      environment.RED_ROVER_TOKEN_URL,
      expect.objectContaining({
        method: 'POST',
        body: 'grant_type=client_credentials&scope=rrh%2FpatientsEncounters%3Aread',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/uat/api/v2/patients?patientIds=19128435',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: 'Bearer synthetic-token', userId: 'test-audit-user', Accept: 'application/json' },
      })
    );
  });

  it('caches valid tokens and refreshes before expiry', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({}));
    const client = new RedRoverClient(environment, fetcher);
    await client.getPatient('19128435');
    await client.getPatient('19128435');
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 3600000);
    await client.getPatient('19128435');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('shares token acquisition across concurrent reads', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockImplementation(async () => Response.json({}));
    const client = new RedRoverClient(environment, fetcher);
    await Promise.all([client.getPatient('19128435'), client.getPatient('19128435')]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it.each([
    { access_token: '', token_type: 'Bearer', expires_in: 3600 },
    { access_token: 'token\ninjection', token_type: 'Bearer', expires_in: 3600 },
    { access_token: 'token', token_type: 'Other', expires_in: 3600 },
    { access_token: 'token', token_type: 'Bearer', expires_in: -1 },
    { access_token: 'token', token_type: 'Bearer', expires_in: 3600, scope: 'rrh/documents:write' },
  ])('rejects an invalid token response before reading', async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(response));
    await expect(new RedRoverClient(environment, fetcher).getPatient('19128435')).rejects.toThrow(
      'Invalid OAuth response'
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('sensitive clinical body', { status: 403 }),
    new Response('sensitive clinical body', { headers: { 'Content-Type': 'text/html' } }),
    new Response('invalid json', { headers: { 'Content-Type': 'application/json' } }),
  ])('withholds failed response bodies and never retries', async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(response);
    await expect(new RedRoverClient(environment, fetcher).getPatient('19128435')).rejects.toThrow(
      'Patient read failed; response and credentials withheld'
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('withholds network exception details and permits a later explicit attempt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('synthetic-secret sensitive details'))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({}));
    const client = new RedRoverClient(environment, fetcher);
    await expect(client.getPatient('19128435')).rejects.toThrow('OAuth failed; response and credentials withheld');
    await expect(client.getPatient('19128435')).resolves.toEqual({});
  });

  it('aborts a stalled request using the configured timeout without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
        })
    );
    await expect(
      new RedRoverClient({ ...environment, RED_ROVER_TIMEOUT_MS: '100' }, fetcher).getPatient('19128435')
    ).rejects.toThrow('OAuth failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
