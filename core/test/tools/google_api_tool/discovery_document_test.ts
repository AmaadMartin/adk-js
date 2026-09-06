/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  DEFAULT_DISCOVERY_URL,
  MTLS_DISCOVERY_URL,
  fetchDiscoveryDocument,
  resolveDiscoveryUrl,
} from '../../../src/tools/google_api_tool/discovery_document.js';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {
  capturedRequest,
  failRequestWith,
  respondWith,
  timeoutRequest,
} from './https_transport_fake.js';

const {requestMock, agentMock, plainRequestMock} = vi.hoisted(() => ({
  requestMock: vi.fn(),
  agentMock: vi.fn(),
  plainRequestMock: vi.fn(),
}));

vi.mock('node:https', () => ({
  request: requestMock,
  Agent: agentMock,
}));

vi.mock('node:http', () => ({request: plainRequestMock}));

const CALENDAR_BODY = JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT);

const CLIENT_CERTS = {
  cert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  passphrase: 'secret',
};

describe('resolveDiscoveryUrl', () => {
  it('exposes the default discovery URL template', () => {
    expect(DEFAULT_DISCOVERY_URL).toBe(
      'https://www.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest',
    );
  });

  it('substitutes the placeholders of the default template', () => {
    expect(resolveDiscoveryUrl('calendar', 'v3')).toBe(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('defaults to the mTLS host once a client certificate is in play', () => {
    expect(MTLS_DISCOVERY_URL).toBe(
      'https://www.mtls.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest',
    );
    expect(resolveDiscoveryUrl('calendar', 'v3', undefined, true)).toBe(
      'https://www.mtls.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('prefers an explicit template over the mTLS default', () => {
    expect(
      resolveDiscoveryUrl(
        'calendar',
        'v3',
        'https://private.example.com/{api}/{apiVersion}',
        true,
      ),
    ).toBe('https://private.example.com/calendar/v3');
  });

  it('substitutes every occurrence of a placeholder', () => {
    expect(
      resolveDiscoveryUrl(
        'docs',
        'v1',
        'https://private.example.com/{api}/{apiVersion}/discovery/{api}',
      ),
    ).toBe('https://private.example.com/docs/v1/discovery/docs');
  });

  it('passes a template with no placeholders through unchanged', () => {
    expect(
      resolveDiscoveryUrl(
        'calendar',
        'v3',
        'https://private.example.com/discovery.json',
      ),
    ).toBe('https://private.example.com/discovery.json');
  });
});

describe('fetchDiscoveryDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith(requestMock, {statusCode: 200, body: CALENDAR_BODY});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from the public discovery service by default', async () => {
    const doc = await fetchDiscoveryDocument('calendar', 'v3');

    expect(doc).toEqual(CALENDAR_DISCOVERY_DOCUMENT);
    expect(capturedRequest(requestMock).url).toBe(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('asks for JSON and presents no certificate by default', async () => {
    await fetchDiscoveryDocument('calendar', 'v3');

    const {options} = capturedRequest(requestMock);
    expect(options.headers).toEqual({'Accept': 'application/json'});
    expect(options.agent).toBeUndefined();
    expect(agentMock).not.toHaveBeenCalled();
  });

  it('bounds the request with a timeout', async () => {
    await fetchDiscoveryDocument('calendar', 'v3');

    expect(capturedRequest(requestMock).options.timeout).toBe(60_000);
  });

  it('rejects when the discovery service does not answer in time', async () => {
    timeoutRequest(requestMock);

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'Discovery request timed out after 60000 ms: ' +
        'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('substitutes the placeholders of a custom URL template', async () => {
    await fetchDiscoveryDocument('docs', 'v1', {
      discoveryUrl: 'https://private.example.com/{api}/{apiVersion}/discovery',
    });

    expect(capturedRequest(requestMock).url).toBe(
      'https://private.example.com/docs/v1/discovery',
    );
  });

  it('presents the client certificate and uses the mTLS host', async () => {
    await fetchDiscoveryDocument('calendar', 'v3', {certs: CLIENT_CERTS});

    expect(capturedRequest(requestMock).url).toBe(
      'https://www.mtls.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
    expect(agentMock).toHaveBeenCalledWith({
      cert: CLIENT_CERTS.cert,
      key: CLIENT_CERTS.key,
      passphrase: CLIENT_CERTS.passphrase,
    });
    expect(capturedRequest(requestMock).options.agent).toBeDefined();
  });

  it('presents a client certificate that has no passphrase', async () => {
    const {cert, key} = CLIENT_CERTS;
    await fetchDiscoveryDocument('calendar', 'v3', {certs: {cert, key}});

    expect(agentMock).toHaveBeenCalledWith({
      cert,
      key,
      passphrase: undefined,
    });
  });

  it('throws naming the api, version, URL and status on a failure', async () => {
    respondWith(requestMock, {statusCode: 404, body: '{}'});

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'Failed to fetch the discovery document for calendar v3 from ' +
        'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest: ' +
        'HTTP 404',
    );
  });

  it('treats a response with no status as a failure', async () => {
    respondWith(requestMock, {body: CALENDAR_BODY});

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'HTTP 0',
    );
  });

  it('rejects when the response body is not JSON', async () => {
    respondWith(requestMock, {statusCode: 200, body: '<html>nope</html>'});

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'Failed to retrieve the API specification for calendar v3',
    );
  });

  it.each([
    {name: 'an empty object', body: '{}'},
    {name: 'a JSON array', body: '[]'},
    {name: 'a JSON null', body: 'null'},
    {name: 'a JSON string', body: '"nope"'},
  ])('rejects a 200 body that is $name', async ({body}) => {
    respondWith(requestMock, {statusCode: 200, body});

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'the response is not a discovery document',
    );
  });

  it('uses plain HTTP for a http discovery URL', async () => {
    respondWith(plainRequestMock, {statusCode: 200, body: CALENDAR_BODY});

    const doc = await fetchDiscoveryDocument('calendar', 'v3', {
      discoveryUrl: 'http://localhost:1234/discovery.json',
      certs: CLIENT_CERTS,
    });

    expect(doc).toEqual(CALENDAR_DISCOVERY_DOCUMENT);
    expect(capturedRequest(plainRequestMock).url).toBe(
      'http://localhost:1234/discovery.json',
    );
    expect(requestMock).not.toHaveBeenCalled();
    expect(agentMock).not.toHaveBeenCalled();
  });

  it('rejects when the connection fails', async () => {
    failRequestWith(requestMock, new Error('ECONNREFUSED'));

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('rejects when the response stream fails mid-body', async () => {
    respondWith(requestMock, {
      statusCode: 200,
      streamError: new Error('socket hang up'),
    });

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'socket hang up',
    );
  });
});
