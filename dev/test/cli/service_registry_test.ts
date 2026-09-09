/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python tests/unittests/cli/test_service_registry.py, read at
// commit a3bd1115. Each `it` keeps the reference test's name, so the two suites
// can be compared by name. The reference's other 14 tests assert built-in
// schemes, which @google/adk resolves rather than this registry; see the PR
// description.

import {
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  ServiceFactory,
  ServiceRegistry,
  getServiceRegistry,
} from '../../src/cli/service_registry.js';

/** Returns a factory that records the URI it was handed. */
function recordingFactory<T>(service: T): {
  factory: ServiceFactory<T>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    factory: (uri: string) => {
      calls.push(uri);
      return service;
    },
    calls,
  };
}

describe('ServiceRegistry', () => {
  it('test_unsupported_scheme', async () => {
    const registry = new ServiceRegistry();

    expect(await registry.createSessionService('unsupported://foo')).toBe(
      undefined,
    );
    expect(await registry.createArtifactService('unsupported://foo')).toBe(
      undefined,
    );
    expect(await registry.createMemoryService('unsupported://foo')).toBe(
      undefined,
    );
  });

  it('test_register_service_routes_matching_scheme_with_full_uri', async () => {
    // A built-in factory re-parses the URI itself, so the registry hands over
    // the whole string rather than the scheme-stripped remainder.
    const registry = new ServiceRegistry();
    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const memoryService = new InMemoryMemoryService();
    const session = recordingFactory(sessionService);
    const artifact = recordingFactory(artifactService);
    const memory = recordingFactory(memoryService);
    registry.registerSessionService('custom', session.factory);
    registry.registerArtifactService('custom', artifact.factory);
    registry.registerMemoryService('custom', memory.factory);

    const uri = 'custom://host/path?flag=1';

    expect(await registry.createSessionService(uri)).toBe(sessionService);
    expect(await registry.createArtifactService(uri)).toBe(artifactService);
    expect(await registry.createMemoryService(uri)).toBe(memoryService);
    expect(session.calls).toEqual([uri]);
    expect(artifact.calls).toEqual([uri]);
    expect(memory.calls).toEqual([uri]);

    // A different scheme is not routed to these factories.
    expect(await registry.createSessionService('other://host')).toBe(undefined);
    expect(await registry.createArtifactService('other://host')).toBe(
      undefined,
    );
    expect(await registry.createMemoryService('other://host')).toBe(undefined);
    expect(session.calls).toHaveLength(1);
    expect(artifact.calls).toHaveLength(1);
    expect(memory.calls).toHaveLength(1);
  });

  it('test_register_session_service_last_registration_wins', async () => {
    // Re-registering a scheme replaces it: the services script beats the YAML.
    const registry = new ServiceRegistry();
    const scriptService = new InMemorySessionService();
    const fromYaml = recordingFactory(new InMemorySessionService());
    const fromScript = recordingFactory(scriptService);
    registry.registerSessionService('dup', fromYaml.factory);
    registry.registerSessionService('dup', fromScript.factory);

    expect(await registry.createSessionService('dup://x')).toBe(scriptService);
    expect(fromYaml.calls).toEqual([]);
  });

  it('test_register_service_schemes_are_namespaced_per_service_type', async () => {
    const registry = new ServiceRegistry();
    const sessionService = new InMemorySessionService();
    const session = recordingFactory(sessionService);
    registry.registerSessionService('shared', session.factory);

    expect(await registry.createArtifactService('shared://x')).toBe(undefined);
    expect(await registry.createMemoryService('shared://x')).toBe(undefined);
    expect(session.calls).toEqual([]);
    expect(await registry.createSessionService('shared://x')).toBe(
      sessionService,
    );
  });

  it('awaits a factory that resolves its service', async () => {
    const registry = new ServiceRegistry();
    const service = new InMemorySessionService();
    registry.registerSessionService('slow', async () => service);

    expect(await registry.createSessionService('slow://x')).toBe(service);
  });

  it('claims no scheme for a URI that has none', async () => {
    const registry = new ServiceRegistry();
    registry.registerSessionService(
      'custom',
      () => new InMemorySessionService(),
    );

    expect(await registry.createSessionService('not-a-uri')).toBe(undefined);
  });

  it('propagates the failure of a factory that throws', async () => {
    const registry = new ServiceRegistry();
    registry.registerSessionService('broken', () => {
      throw new Error('cannot reach the backend');
    });

    await expect(registry.createSessionService('broken://x')).rejects.toThrow(
      'cannot reach the backend',
    );
  });
});

describe('getServiceRegistry', () => {
  it('returns the same registry every time', () => {
    expect(getServiceRegistry()).toBe(getServiceRegistry());
  });
});
