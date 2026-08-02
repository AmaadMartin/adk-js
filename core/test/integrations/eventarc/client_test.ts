/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ExternalAccountClient,
  Impersonated,
  JWT,
  OAuth2Client,
} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  CACHE_MAX_SIZE,
  CACHE_TTL_MS,
  cleanupPublisherClients,
  getPublisherClient,
  loadPublisherClientCtor,
  removePublisherClient,
} from '../../../src/integrations/eventarc/client.js';
import {CLOUD_PLATFORM_SCOPE} from '../../../src/integrations/eventarc/config.js';
import {logger} from '../../../src/utils/logger.js';

interface FakePublisherClientOptions {
  authClient?: unknown;
  scopes?: string[];
  projectId?: string;
  libName?: string;
  libVersion?: string;
}

const mocks = vi.hoisted(() => ({
  constructed: [] as FakePublisherClientOptions[],
  closed: [] as FakePublisherClientOptions[],
  closeError: {value: undefined as Error | undefined},
}));

vi.mock('@google-cloud/eventarc-publishing', () => {
  class FakePublisherClient {
    constructor(readonly options: FakePublisherClientOptions) {
      mocks.constructed.push(options);
    }
    async close(): Promise<void> {
      mocks.closed.push(this.options);
      if (mocks.closeError.value) {
        throw mocks.closeError.value;
      }
    }
  }
  return {PublisherClient: FakePublisherClient};
});

function externalAccountClient() {
  const client = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: '//iam.googleapis.com/projects/1/locations/global/pool/provider',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    credential_source: {file: '/dev/null'},
  });
  if (!client) {
    expect.fail('failed to build an external account client');
  }
  return client;
}

function userRefreshClient(refreshToken: string) {
  const client = new OAuth2Client();
  client.setCredentials({refresh_token: refreshToken});
  return client;
}

beforeEach(() => {
  mocks.constructed.length = 0;
  mocks.closed.length = 0;
  mocks.closeError.value = undefined;
});

afterEach(async () => {
  await cleanupPublisherClients();
  vi.useRealTimers();
});

describe('loadPublisherClientCtor', () => {
  it('resolves the publisher client constructor', async () => {
    await expect(loadPublisherClientCtor()).resolves.toBeTypeOf('function');
  });
});

describe('getPublisherClient caching', () => {
  it('builds the client with the default scope and the ADK user agent', async () => {
    await getPublisherClient({projectId: 'my-project'});

    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0]).toMatchObject({
      projectId: 'my-project',
      scopes: [CLOUD_PLATFORM_SCOPE],
      libName: 'adk-eventarc-tool google-adk',
    });
  });

  it('reuses the cached client for the same key', async () => {
    const first = await getPublisherClient({projectId: 'my-project'});
    const second = await getPublisherClient({projectId: 'my-project'});

    expect(second).toBe(first);
    expect(mocks.constructed).toHaveLength(1);
  });

  it('builds a separate client per project', async () => {
    const first = await getPublisherClient({projectId: 'project-a'});
    const second = await getPublisherClient({projectId: 'project-b'});

    expect(second).not.toBe(first);
    expect(mocks.constructed).toHaveLength(2);
  });

  it('builds a separate client per scope set', async () => {
    const first = await getPublisherClient({
      credentialsConfig: {scopes: ['https://example.test/a']},
    });
    const second = await getPublisherClient({
      credentialsConfig: {scopes: ['https://example.test/b']},
    });

    expect(second).not.toBe(first);
    expect(mocks.constructed).toHaveLength(2);
  });

  it('shares a client between auth clients with the same identity', async () => {
    const first = await getPublisherClient({
      credentialsConfig: {authClient: new JWT({email: 'sa@example.test'})},
    });
    const second = await getPublisherClient({
      credentialsConfig: {authClient: new JWT({email: 'sa@example.test'})},
    });

    expect(second).toBe(first);
    expect(mocks.constructed).toHaveLength(1);
  });

  it('separates clients for different service accounts', async () => {
    await getPublisherClient({
      credentialsConfig: {authClient: new JWT({email: 'a@example.test'})},
    });
    await getPublisherClient({
      credentialsConfig: {authClient: new JWT({email: 'b@example.test'})},
    });

    expect(mocks.constructed).toHaveLength(2);
  });

  it('separates clients for impersonated, external and user credentials', async () => {
    const impersonated = new Impersonated({
      sourceClient: new OAuth2Client(),
      targetPrincipal: 'target@example.test',
      targetScopes: [CLOUD_PLATFORM_SCOPE],
    });

    await getPublisherClient({credentialsConfig: {authClient: impersonated}});
    await getPublisherClient({
      credentialsConfig: {authClient: externalAccountClient()},
    });
    await getPublisherClient({
      credentialsConfig: {authClient: userRefreshClient('refresh-1')},
    });
    await getPublisherClient({
      credentialsConfig: {authClient: userRefreshClient('refresh-1')},
    });
    await getPublisherClient({
      credentialsConfig: {authClient: userRefreshClient('refresh-2')},
    });

    expect(mocks.constructed).toHaveLength(4);
  });

  it('keeps unidentifiable auth clients apart by object identity', async () => {
    const anonymous = new OAuth2Client();

    const first = await getPublisherClient({
      credentialsConfig: {authClient: anonymous},
    });
    const second = await getPublisherClient({
      credentialsConfig: {authClient: anonymous},
    });
    const third = await getPublisherClient({
      credentialsConfig: {authClient: new OAuth2Client()},
    });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(mocks.constructed).toHaveLength(2);
  });

  it('rebuilds the client once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T12:00:00Z'));

    const first = await getPublisherClient({projectId: 'my-project'});
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    const second = await getPublisherClient({projectId: 'my-project'});

    expect(second).not.toBe(first);
    expect(mocks.constructed).toHaveLength(2);
    expect(mocks.closed).toHaveLength(1);
  });

  it('evicts and closes the least recently used client when full', async () => {
    for (let index = 0; index < CACHE_MAX_SIZE; index++) {
      await getPublisherClient({projectId: `project-${index}`});
    }
    // Touch the oldest entry so that project-1 becomes the eviction target.
    const touched = await getPublisherClient({projectId: 'project-0'});

    await getPublisherClient({projectId: 'overflow'});

    expect(mocks.closed).toHaveLength(1);
    expect(mocks.closed[0]).toMatchObject({projectId: 'project-1'});
    expect(await getPublisherClient({projectId: 'project-0'})).toBe(touched);
    expect(mocks.constructed).toHaveLength(CACHE_MAX_SIZE + 1);
  });
});

describe('removePublisherClient', () => {
  it('closes and drops the cached client', async () => {
    const first = await getPublisherClient({projectId: 'my-project'});

    await removePublisherClient({projectId: 'my-project'});

    expect(mocks.closed).toHaveLength(1);
    expect(mocks.closed[0]).toMatchObject({projectId: 'my-project'});
    expect(await getPublisherClient({projectId: 'my-project'})).not.toBe(first);
  });

  it('is a no-op for an unknown key', async () => {
    await removePublisherClient({projectId: 'never-cached'});

    expect(mocks.closed).toHaveLength(0);
  });

  it('logs and continues when closing fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await getPublisherClient({projectId: 'my-project'});
    mocks.closeError.value = new Error('close failed');

    await expect(
      removePublisherClient({projectId: 'my-project'}),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to close the Eventarc publisher client',
      expect.objectContaining({message: 'close failed'}),
    );
    warnSpy.mockRestore();
  });
});

describe('cleanupPublisherClients', () => {
  it('closes every cached client', async () => {
    await getPublisherClient({projectId: 'project-a'});
    await getPublisherClient({projectId: 'project-b'});

    await cleanupPublisherClients();

    expect(mocks.closed).toHaveLength(2);
    await getPublisherClient({projectId: 'project-a'});
    expect(mocks.constructed).toHaveLength(3);
  });
});
