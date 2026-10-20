import { loadRedRoverConfig } from './config';
import type { RedRoverConfig } from './config';
import { readPage, readPatient, sourceId } from './response';
import type { JsonObject } from './response';

/** Read-only UAT transport. Returned JSON is untrusted, not validated clinical data. */
export class RedRoverClient {
  private readonly config: RedRoverConfig;
  private readonly fetcher: typeof fetch;
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;

  constructor(environment: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch = fetch) {
    this.config = loadRedRoverConfig(environment);
    this.fetcher = fetcher;
  }

  /**
   * Retrieves raw JSON for exactly one explicitly allowlisted patient without retries.
   * @param patientId - External identifier of an explicitly allowlisted UAT patient.
   * @returns Untrusted JSON requiring domain-schema and clinical identity validation.
   */
  async getPatient(patientId: string): Promise<unknown> {
    if (!this.config.patientIds.includes(patientId)) {
      throw new Error('Patient is outside the configured UAT allowlist');
    }
    const token = await this.getToken();
    const url = new URL(`${this.config.apiBaseUrl}/api/v2/patients`);
    url.searchParams.set('patientIds', patientId);
    return this.requestJson(
      url.href,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, userId: this.config.userId, Accept: 'application/json' },
      },
      'Patient read'
    );
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return this.token.value;
    }
    if (this.pendingToken) {
      return this.pendingToken;
    }
    this.pendingToken = this.acquireToken();
    try {
      return await this.pendingToken;
    } finally {
      this.pendingToken = undefined;
    }
  }

  async getPatientRecord(patientId: string): Promise<JsonObject> {
    const response = await this.getPatient(patientId);
    if (readPage(response).nextId) {
      throw new Error('Patient response is incomplete');
    }
    return readPatient(response, patientId);
  }

  async getEncounters(patientId: string): Promise<JsonObject[]> {
    if (!this.config.patientIds.includes(patientId)) {
      throw new Error('Patient is outside the configured UAT allowlist');
    }
    const records: JsonObject[] = [];
    const seenIds = new Set<string>();
    let nextId: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const url = new URL(`${this.config.apiBaseUrl}/api/v2/patients/encounters`);
      url.searchParams.set('patientIds', patientId);
      url.searchParams.set('maxResults', '100');
      if (nextId) {
        url.searchParams.set('paginationId', nextId);
      }
      const page = readPage(
        await this.requestJson(
          url.href,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${await this.getToken()}`,
              userId: this.config.userId,
              Accept: 'application/json',
            },
          },
          'Encounter read'
        )
      );
      for (const record of page.records) {
        const encounterId = sourceId(record.encounterId);
        if (sourceId(record.patientId) !== patientId || seenIds.has(encounterId)) {
          throw new Error('Unexpected patient or repeated encounter in response');
        }
        seenIds.add(encounterId);
        records.push(record);
      }
      if (!page.nextId) {
        return records;
      }
      if (!this.config.encounterIdPagingConfirmed) {
        throw new Error('Encounter ID paging order requires site confirmation');
      }
      if (
        page.nextId !== sourceId(page.records[page.records.length - 1].encounterId) ||
        (nextId && BigInt(page.nextId) <= BigInt(nextId))
      ) {
        throw new Error('Encounter pagination did not advance by ID');
      }
      nextId = page.nextId;
    }
    throw new Error('Encounter page limit exceeded');
  }

  private async acquireToken(): Promise<string> {
    const formEncode = (value: string): string => new URLSearchParams({ value }).toString().slice('value='.length);
    const credentials = Buffer.from(
      `${formEncode(this.config.clientId)}:${formEncode(this.config.clientSecret)}`
    ).toString('base64');
    const result = await this.requestJson(
      this.config.tokenUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.config.scope }).toString(),
      },
      'OAuth'
    );
    if (
      !result ||
      typeof result !== 'object' ||
      !('access_token' in result) ||
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      /\s/.test(result.access_token) ||
      !('token_type' in result) ||
      typeof result.token_type !== 'string' ||
      result.token_type.toLowerCase() !== 'bearer' ||
      !('expires_in' in result) ||
      typeof result.expires_in !== 'number' ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0 ||
      ('scope' in result && result.scope !== this.config.scope)
    ) {
      throw new Error('Invalid OAuth response');
    }
    this.token = {
      value: result.access_token,
      expiresAt: Date.now() + Math.max(0, result.expires_in - 30) * 1000,
    };
    return result.access_token;
  }

  private async requestJson(url: string, init: RequestInit, operation: string): Promise<unknown> {
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (!response.ok) {
        throw new Error('HTTP failure');
      }
      const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
        throw new Error('Unexpected response content type');
      }
      return await response.json();
    } catch {
      this.token = undefined;
      throw new Error(`${operation} failed; response and credentials withheld`);
    }
  }
}
