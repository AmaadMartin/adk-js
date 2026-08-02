/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  CLOUD_PLATFORM_SCOPE,
  GoogleApiJsonClient,
  resolveBaseUrl,
} from '../../../src/integrations/agent_identity/credentials_transport.js';

const {googleAuthConstructor} = vi.hoisted(() => ({
  googleAuthConstructor: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation((options: unknown) => {
    googleAuthConstructor(options);
    return {
      getClient: vi.fn().mockResolvedValue({
        getRequestHeaders: vi
          .fn()
          .mockResolvedValue({'Authorization': 'Bearer fake-token'}),
        credentials: {},
      }),
    };
  }),
}));

const ENV_VAR = 'TEST_CREDENTIALS_TARGET_HOST';

describe('resolveBaseUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the default host when the override is unset', () => {
    expect(resolveBaseUrl(ENV_VAR, 'example.googleapis.com')).toBe(
      'https://example.googleapis.com',
    );
  });

  it('adds a scheme to a bare override host', () => {
    vi.stubEnv(ENV_VAR, 'some-host');

    expect(resolveBaseUrl(ENV_VAR, 'example.googleapis.com')).toBe(
      'https://some-host',
    );
  });

  it('keeps the scheme of an override that carries one', () => {
    vi.stubEnv(ENV_VAR, 'http://localhost:8080');

    expect(resolveBaseUrl(ENV_VAR, 'example.googleapis.com')).toBe(
      'http://localhost:8080',
    );
  });

  it('ignores an empty override', () => {
    vi.stubEnv(ENV_VAR, '');

    expect(resolveBaseUrl(ENV_VAR, 'example.googleapis.com')).toBe(
      'https://example.googleapis.com',
    );
  });
});

describe('GoogleApiJsonClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('requests cloud-platform scoped credentials', () => {
    new GoogleApiJsonClient('https://example.googleapis.com');

    expect(googleAuthConstructor).toHaveBeenCalledWith({
      scopes: [CLOUD_PLATFORM_SCOPE],
    });
  });

  it('posts JSON with auth headers and parses the response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({token: 'test-token'}),
    });
    const client = new GoogleApiJsonClient('https://example.googleapis.com');

    const response = await client.post('/v1/resource:retrieve', {userId: 'u'});

    expect(response).toEqual({token: 'test-token'});
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.googleapis.com/v1/resource:retrieve',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer fake-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({userId: 'u'}),
      },
    );
  });

  it('throws on a non-2xx response without echoing the body', async () => {
    const body = 'token=super-secret';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue(body),
    });
    const client = new GoogleApiJsonClient('https://example.googleapis.com');

    const error = await client
      .post('/v1/resource:retrieve', {})
      .catch((e: unknown) => e);

    if (!(error instanceof Error)) {
      expect.fail('expected post to reject with an Error');
    }
    expect(error.message).toBe('Credentials request failed with status 503.');
    expect(error.message).not.toContain(body);
  });
});
