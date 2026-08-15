/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseMemoryService,
  getLogger,
  getMemoryServiceFromUri,
  getServiceRegistry,
  InMemoryMemoryService,
  VertexAiMemoryBankService,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const clientConstructor = vi.hoisted(() => vi.fn());
const retrieveInternal = vi.hoisted(() =>
  vi.fn().mockResolvedValue({retrievedMemories: []}),
);

// The service imports Client from the package root, so the mock must target it.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {retrieveInternal}};

    constructor(options: {project?: string; location?: string}) {
      clientConstructor(options);
    }
  },
}));

const FULL_RESOURCE_NAME_URI =
  'agentengine://projects/p/locations/us-central1/reasoningEngines/1234567890';

const FULL_RESOURCE_PATH_WARNING =
  'agentEngineId appears to be a full resource path';

afterEach(() => {
  vi.unstubAllEnvs();
  clientConstructor.mockClear();
  retrieveInternal.mockClear();
});

describe('getMemoryServiceFromUri', () => {
  it('returns an InMemoryMemoryService for "memory://"', () => {
    expect(getMemoryServiceFromUri('memory://')).toBeInstanceOf(
      InMemoryMemoryService,
    );
  });

  it('reads project and location from the environment for a resource id', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    const service = getMemoryServiceFromUri('agentengine://1234567890');

    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
    expect(clientConstructor).toHaveBeenCalledWith({
      project: 'env-project',
      location: 'europe-west4',
    });
  });

  it('reads project and location from a full resource name', () => {
    const service = getMemoryServiceFromUri(FULL_RESOURCE_NAME_URI);

    expect(service).toBeInstanceOf(VertexAiMemoryBankService);
    expect(clientConstructor).toHaveBeenCalledWith({
      project: 'p',
      location: 'us-central1',
    });
  });

  it('addresses the bare agent engine id for both URI forms', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    for (const uri of ['agentengine://1234567890', FULL_RESOURCE_NAME_URI]) {
      await getMemoryServiceFromUri(uri).searchMemory({
        appName: 'app',
        userId: 'user',
        query: 'what do you remember',
      });

      expect(retrieveInternal).toHaveBeenCalledWith(
        expect.objectContaining({name: 'reasoningEngines/1234567890'}),
      );
      retrieveInternal.mockClear();
    }
  });

  it('does not warn about a full resource path for either URI form', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    getMemoryServiceFromUri('agentengine://1234567890');
    getMemoryServiceFromUri(FULL_RESOURCE_NAME_URI);

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining(FULL_RESOURCE_PATH_WARNING),
    );
    warn.mockRestore();
  });

  it('rejects an empty agent engine resource', () => {
    expect(() => getMemoryServiceFromUri('agentengine://')).toThrow(
      'Agent engine resource name or resource id cannot be empty.',
    );
  });

  it('rejects a resource name that is missing the locations segment', () => {
    expect(() =>
      getMemoryServiceFromUri(
        'agentengine://projects/p/reasoningEngines/1234567890',
      ),
    ).toThrow('Agent engine resource name is mal-formatted.');
  });

  it('rejects a resource name with a trailing slash', () => {
    expect(() =>
      getMemoryServiceFromUri(
        'agentengine://projects/p/locations/l/reasoningEngines/123/',
      ),
    ).toThrow('Agent engine resource name is mal-formatted.');
  });

  it('rejects a resource id when GOOGLE_CLOUD_PROJECT is unset', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

    expect(() => getMemoryServiceFromUri('agentengine://1234567890')).toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must both be set',
    );
  });

  it('rejects a resource id when GOOGLE_CLOUD_LOCATION is unset', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

    expect(() => getMemoryServiceFromUri('agentengine://1234567890')).toThrow(
      'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must both be set',
    );
  });

  it('rejects "rag://" because adk-js has no RAG memory service', () => {
    expect(() => getMemoryServiceFromUri('rag://my-corpus')).toThrow(
      'Unsupported memory service URI: rag://my-corpus',
    );
  });

  it('rejects an unsupported scheme', () => {
    expect(() =>
      getMemoryServiceFromUri('unsupported://localhost:5432/mydb'),
    ).toThrow(
      'Unsupported memory service URI: unsupported://localhost:5432/mydb',
    );
  });
});

describe('getMemoryServiceFromUri with a registered scheme', () => {
  // The process-wide registry has no unregister API, so this scheme is unique
  // to this file.
  const CUSTOM_SCHEME = 'custommemorytest';

  it('serves the scheme and hands the factory the uri and options', () => {
    const service = {} as BaseMemoryService;
    const factory = vi.fn().mockReturnValue(service);
    getServiceRegistry().registerMemoryService(CUSTOM_SCHEME, factory);

    const resolved = getMemoryServiceFromUri(`${CUSTOM_SCHEME}://bank/x`, {
      agentsDir: '/agents',
    });

    expect(resolved).toBe(service);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      `${CUSTOM_SCHEME}://bank/x`,
      {agentsDir: '/agents'},
    );
  });

  it('redacts a password in the unsupported uri message', () => {
    expect(() =>
      getMemoryServiceFromUri('unsupported://user:hunter2@host/bank'),
    ).toThrow(
      'Unsupported memory service URI: unsupported://user:***@host/bank',
    );
  });
});
