/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  getMemoryServiceFromUri,
  InMemoryMemoryService,
  VertexAiMemoryBankService,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseAgentEngineMemoryUri} from '../../src/memory/registry.js';

const clientConstructor = vi.hoisted(() => vi.fn());

// The service imports Client from the package root, so the mock must target it.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {}};

    constructor(options: {project?: string; location?: string}) {
      clientConstructor(options);
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clientConstructor.mockClear();
});

describe('getMemoryServiceFromUri', () => {
  it('returns an InMemoryMemoryService for "memory://"', () => {
    expect(getMemoryServiceFromUri('memory://')).to.be.instanceOf(
      InMemoryMemoryService,
    );
  });

  it('reads the project and location from the environment for a short id', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    const service = getMemoryServiceFromUri('agentengine://1234567890');

    expect(service).to.be.instanceOf(VertexAiMemoryBankService);
    expect(clientConstructor).toHaveBeenCalledWith({
      project: 'env-project',
      location: 'us-central1',
    });
  });

  it('rejects a short id when GOOGLE_CLOUD_PROJECT is not set', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    expect(() => getMemoryServiceFromUri('agentengine://1234567890')).to.throw(
      'GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.',
    );
    expect(clientConstructor).not.toHaveBeenCalled();
  });

  it('rejects a short id when GOOGLE_CLOUD_LOCATION is not set', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

    expect(() => getMemoryServiceFromUri('agentengine://1234567890')).to.throw(
      'GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.',
    );
    expect(clientConstructor).not.toHaveBeenCalled();
  });

  it('accepts a full resource name with no project or location in the environment', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

    const service = getMemoryServiceFromUri(
      'agentengine://projects/p1/locations/us-central1/reasoningEngines/999',
    );

    expect(service).to.be.instanceOf(VertexAiMemoryBankService);
    expect(clientConstructor).toHaveBeenCalledWith({
      project: 'p1',
      location: 'us-central1',
    });
  });

  it('reads the project and location from a full resource name', () => {
    const warn = vi
      .spyOn(getLogger(), 'warn')
      .mockImplementation(() => undefined);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');

    const service = getMemoryServiceFromUri(
      'agentengine://projects/p1/locations/us-central1/reasoningEngines/999',
    );

    expect(service).to.be.instanceOf(VertexAiMemoryBankService);
    expect(clientConstructor).toHaveBeenCalledWith({
      project: 'p1',
      location: 'us-central1',
    });
    // The id handed to the service is '999', not the whole path, so the
    // service's "full resource path" warning must not fire.
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects an empty agent engine resource', () => {
    expect(() => getMemoryServiceFromUri('agentengine://')).to.throw(
      /Agent engine resource name or resource id cannot be empty\./,
    );
  });

  it('rejects a mal-formatted agent engine resource name', () => {
    expect(() =>
      getMemoryServiceFromUri('agentengine://projects/p1/reasoningEngines/999'),
    ).to.throw(/Agent engine resource name is mal-formatted\./);
  });

  it('rejects a resource name whose project and location are empty', () => {
    expect(() =>
      getMemoryServiceFromUri(
        'agentengine://projects//locations//reasoningEngines/999',
      ),
    ).to.throw(/Agent engine resource name is mal-formatted\./);
    expect(clientConstructor).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric agent engine id in a resource name', () => {
    expect(() =>
      getMemoryServiceFromUri(
        'agentengine://projects/p1/locations/us-central1/reasoningEngines/abc',
      ),
    ).to.throw(/Agent engine resource name is mal-formatted\./);
  });

  it('rejects "rag://", which adk-js has no memory service for', () => {
    expect(() => getMemoryServiceFromUri('rag://my-corpus')).to.throw(
      'Unsupported memory service URI: rag://my-corpus',
    );
  });

  it('rejects an unsupported scheme', () => {
    expect(() => getMemoryServiceFromUri('redis://cache')).to.throw(
      'Unsupported memory service URI: redis://cache',
    );
  });
});

describe('parseAgentEngineMemoryUri', () => {
  it('parses a short id, taking the project and location from the environment', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');

    expect(parseAgentEngineMemoryUri('agentengine://456')).toEqual({
      projectId: 'test-project',
      location: 'us-central1',
      agentEngineId: '456',
    });
  });

  it('parses a full resource name in preference to the environment', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');

    expect(
      parseAgentEngineMemoryUri(
        'agentengine://projects/p/locations/l/reasoningEngines/456',
      ),
    ).toEqual({projectId: 'p', location: 'l', agentEngineId: '456'});
  });
});
