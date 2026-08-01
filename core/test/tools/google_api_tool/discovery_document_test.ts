/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  DEFAULT_DISCOVERY_URL,
  fetchDiscoveryDocument,
} from '../../../src/tools/google_api_tool/discovery_document.js';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';

describe('fetchDiscoveryDocument', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => CALENDAR_DISCOVERY_DOCUMENT,
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches from the public discovery service by default', async () => {
    const doc = await fetchDiscoveryDocument('calendar', 'v3');

    expect(doc).toEqual(CALENDAR_DISCOVERY_DOCUMENT);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
      {headers: {'Accept': 'application/json'}},
    );
  });

  it('exposes the default discovery URL template', () => {
    expect(DEFAULT_DISCOVERY_URL).toBe(
      'https://www.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest',
    );
  });

  it('substitutes the placeholders of a custom URL template', async () => {
    await fetchDiscoveryDocument(
      'docs',
      'v1',
      'https://private.example.com/{api}/{apiVersion}/discovery/{api}',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://private.example.com/docs/v1/discovery/docs',
      expect.anything(),
    );
  });

  it('passes a custom URL without placeholders through unchanged', async () => {
    await fetchDiscoveryDocument(
      'calendar',
      'v3',
      'https://private.example.com/discovery.json',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://private.example.com/discovery.json',
      expect.anything(),
    );
  });

  it('throws naming the api, version, URL and status on a failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'Failed to fetch the discovery document for calendar v3 from ' +
        'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest: ' +
        'HTTP 404',
    );
  });

  it('rejects when the response body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    await expect(fetchDiscoveryDocument('calendar', 'v3')).rejects.toThrow(
      'Unexpected token < in JSON',
    );
  });
});
