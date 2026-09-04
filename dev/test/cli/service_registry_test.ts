/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `tests/unittests/cli/test_service_registry.py` at
 * `main`. Each ported `it(...)` keeps the reference test name so the two
 * suites can be compared by grep. The cases adk-js cannot express are listed
 * in the pull request body.
 */

import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  DatabaseSessionService,
  FileArtifactService,
  GcsArtifactService,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  VertexAiMemoryBankService,
  VertexAiSessionService,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  registerBuiltinServices,
  ServiceFactory,
  ServiceFactoryOptions,
  ServiceRegistry,
} from '../../src/cli/service_registry.js';

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    DatabaseSessionService: vi.fn(),
    FileArtifactService: vi.fn(),
    GcsArtifactService: vi.fn(),
    VertexAiMemoryBankService: vi.fn(),
    VertexAiSessionService: vi.fn(),
  };
});

const AGENTS_DIR = '/path/to/agents';

const mockedDatabaseSession = vi.mocked(DatabaseSessionService);
const mockedFileArtifact = vi.mocked(FileArtifactService);
const mockedGcsArtifact = vi.mocked(GcsArtifactService);
const mockedMemoryBank = vi.mocked(VertexAiMemoryBankService);
const mockedVertexSession = vi.mocked(VertexAiSessionService);

function builtinRegistry(): ServiceRegistry {
  const registry = new ServiceRegistry();
  registerBuiltinServices(registry);
  return registry;
}

/** Returns a factory that records how it was called. */
function recordingFactory<T>(service: T) {
  const calls: Array<[string, ServiceFactoryOptions | undefined]> = [];
  const factory: ServiceFactory<T> = (uri, options) => {
    calls.push([uri, options]);
    return service;
  };
  return {factory, calls};
}

/**
 * A registered factory owns its scheme and receives the URI unmodified.
 *
 * Built-in factories re-parse the URI themselves (bucket name, database path,
 * agent engine id), so the registry must hand over the whole string rather
 * than the scheme-stripped remainder.
 */
function assertRoutesFullUri<T>(
  service: T,
  register: (registry: ServiceRegistry, factory: ServiceFactory<T>) => void,
  create: (
    registry: ServiceRegistry,
    uri: string,
    options?: ServiceFactoryOptions,
  ) => T | undefined,
): void {
  const registry = new ServiceRegistry();
  const {factory, calls} = recordingFactory(service);
  register(registry, factory);

  const created = create(registry, 'custom://host/path?flag=1', {
    agentsDir: '/agents',
  });

  expect(created).toBe(service);
  expect(calls).toEqual([
    ['custom://host/path?flag=1', {agentsDir: '/agents'}],
  ]);
  expect(create(registry, 'other://host')).toBeUndefined();
  expect(calls).toHaveLength(1);
}

describe('ServiceRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  describe('session services', () => {
    it('test_create_session_service_sqlite', () => {
      const service =
        builtinRegistry().createSessionService('sqlite:///test.db');

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(mockedDatabaseSession).toHaveBeenCalledWith('sqlite:///test.db');
    });

    it('builds an in-memory session service for sqlite:// with no path', () => {
      expect(
        builtinRegistry().createSessionService('sqlite://'),
      ).toBeInstanceOf(InMemorySessionService);
    });

    it('test_create_session_service_postgresql', () => {
      const service = builtinRegistry().createSessionService(
        'postgresql://user:pass@host/db',
      );

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(mockedDatabaseSession).toHaveBeenCalledWith(
        'postgresql://user:pass@host/db',
      );
    });

    it('builds a database session service for mysql://', () => {
      builtinRegistry().createSessionService('mysql://u:p@h/d');

      expect(mockedDatabaseSession).toHaveBeenCalledWith('mysql://u:p@h/d');
    });

    it('test_create_session_service_agentengine_short', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      builtinRegistry().createSessionService('agentengine://123', {
        agentsDir: AGENTS_DIR,
      });

      expect(mockedVertexSession).toHaveBeenCalledWith({
        projectId: 'test-project',
        location: 'us-central1',
        agentEngineId: '123',
      });
    });

    it('test_create_session_service_agentengine_full', () => {
      builtinRegistry().createSessionService(
        'agentengine://projects/p/locations/l/reasoningEngines/123',
        {agentsDir: AGENTS_DIR},
      );

      expect(mockedVertexSession).toHaveBeenCalledWith({
        projectId: 'p',
        location: 'l',
        agentEngineId: '123',
      });
    });

    it('rejects an empty agent engine resource', () => {
      expect(() =>
        builtinRegistry().createSessionService('agentengine://'),
      ).toThrowError(
        'Agent engine resource name or resource id cannot be empty.',
      );
    });

    it('rejects a mal-formatted agent engine resource name', () => {
      expect(() =>
        builtinRegistry().createSessionService(
          'agentengine://projects/p/foo/l',
        ),
      ).toThrowError('Agent engine resource name is mal-formatted.');
    });

    it('requires agentsDir for a short-form agent engine id', () => {
      expect(() =>
        builtinRegistry().createSessionService('agentengine://123'),
      ).toThrowError(
        'agentsDir must be provided for short-form agent engine IDs',
      );
    });

    it('requires the Google Cloud project and location to be set', () => {
      expect(() =>
        builtinRegistry().createSessionService('agentengine://123', {
          agentsDir: AGENTS_DIR,
        }),
      ).toThrowError('GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.');
    });

    it('builds an in-memory session service for an authority-less sqlite URI', () => {
      expect(builtinRegistry().createSessionService('sqlite:')).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it('builds an in-memory session service for memory://', () => {
      expect(
        builtinRegistry().createSessionService('memory://'),
      ).toBeInstanceOf(InMemorySessionService);
    });
  });

  describe('artifact services', () => {
    it('test_create_artifact_service_gcs', () => {
      builtinRegistry().createArtifactService('gs://my-bucket/path/prefix', {
        agentsDir: 'foo',
      });

      expect(mockedGcsArtifact).toHaveBeenCalledWith('my-bucket');
    });

    it('builds an in-memory artifact service for memory://', () => {
      expect(
        builtinRegistry().createArtifactService('memory://'),
      ).toBeInstanceOf(InMemoryArtifactService);
    });

    it('test_file_artifact_factory_normalizes_windows_file_uri', () => {
      // Only the percent-decoding half of the reference test ports. Node's
      // `fileURLToPath` is platform-bound, and CI also runs Linux, so there is
      // no equivalent of monkeypatching `os.name` for the drive-letter half.
      builtinRegistry().createArtifactService('file:///tmp/adk%20artifacts');

      expect(mockedFileArtifact).toHaveBeenCalledWith(
        expect.stringContaining('adk artifacts'),
      );
      expect(mockedFileArtifact).not.toHaveBeenCalledWith(
        expect.stringContaining('%20'),
      );
    });

    it('test_file_artifact_factory_rejects_non_local_authority', () => {
      expect(() =>
        builtinRegistry().createArtifactService(
          'file://example.com/tmp/adk_artifacts',
        ),
      ).toThrowError('local filesystem');
      expect(mockedFileArtifact).not.toHaveBeenCalled();
    });

    it('accepts a localhost file URI', () => {
      builtinRegistry().createArtifactService('file://localhost/tmp/artifacts');

      expect(mockedFileArtifact).toHaveBeenCalledWith(
        expect.stringContaining('artifacts'),
      );
    });

    it('rejects a file URI with no path component', () => {
      expect(() =>
        builtinRegistry().createArtifactService('file://'),
      ).toThrowError('file:// artifact URIs must include a path component.');
    });
  });

  describe('memory services', () => {
    it('test_create_memory_service_rag', () => {
      // Not portable: adk-js has no `VertexAiRagMemoryService`, so `rag://`
      // stays unregistered. This assertion pins the gap.
      expect(
        builtinRegistry().createMemoryService('rag://corpus-123', {
          agentsDir: AGENTS_DIR,
        }),
      ).toBeUndefined();
    });

    it('test_create_memory_service_agentengine_short', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      builtinRegistry().createMemoryService('agentengine://456', {
        agentsDir: AGENTS_DIR,
      });

      expect(mockedMemoryBank).toHaveBeenCalledWith({
        projectId: 'test-project',
        location: 'us-central1',
        agentEngineId: '456',
      });
    });

    it('test_create_memory_service_agentengine_full', () => {
      builtinRegistry().createMemoryService(
        'agentengine://projects/p/locations/l/reasoningEngines/456',
        {agentsDir: AGENTS_DIR},
      );

      expect(mockedMemoryBank).toHaveBeenCalledWith({
        projectId: 'p',
        location: 'l',
        agentEngineId: '456',
      });
    });

    it('test_create_memory_service_memory', () => {
      expect(builtinRegistry().createMemoryService('memory://')).toBeInstanceOf(
        InMemoryMemoryService,
      );
    });
  });

  describe('scheme routing', () => {
    it('test_unsupported_scheme', () => {
      const registry = builtinRegistry();

      expect(
        registry.createSessionService('unsupported://foo'),
      ).toBeUndefined();
      expect(
        registry.createArtifactService('unsupported://foo'),
      ).toBeUndefined();
      expect(registry.createMemoryService('unsupported://foo')).toBeUndefined();
      expect(mockedDatabaseSession).not.toHaveBeenCalled();
      expect(mockedVertexSession).not.toHaveBeenCalled();
      expect(mockedGcsArtifact).not.toHaveBeenCalled();
      expect(mockedMemoryBank).not.toHaveBeenCalled();
    });

    it('returns undefined for a string that carries no scheme', () => {
      expect(
        builtinRegistry().createSessionService('not-a-uri'),
      ).toBeUndefined();
    });

    it('matches a scheme case-insensitively', () => {
      expect(
        builtinRegistry().createSessionService('MEMORY://'),
      ).toBeInstanceOf(InMemorySessionService);
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (session)', () => {
      assertRoutesFullUri<BaseSessionService>(
        new InMemorySessionService(),
        (registry, factory) =>
          registry.registerSessionService('custom', factory),
        (registry, uri, options) => registry.createSessionService(uri, options),
      );
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (artifact)', () => {
      assertRoutesFullUri<BaseArtifactService>(
        new InMemoryArtifactService(),
        (registry, factory) =>
          registry.registerArtifactService('custom', factory),
        (registry, uri, options) =>
          registry.createArtifactService(uri, options),
      );
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (memory)', () => {
      assertRoutesFullUri<BaseMemoryService>(
        new InMemoryMemoryService(),
        (registry, factory) =>
          registry.registerMemoryService('custom', factory),
        (registry, uri, options) => registry.createMemoryService(uri, options),
      );
    });

    it('test_register_session_service_last_registration_wins', () => {
      const registry = new ServiceRegistry();
      const scriptService = new InMemorySessionService();
      const fromYaml = recordingFactory(new InMemorySessionService());
      const fromScript = recordingFactory(scriptService);

      registry.registerSessionService('dup', fromYaml.factory);
      registry.registerSessionService('dup', fromScript.factory);

      expect(registry.createSessionService('dup://x')).toBe(scriptService);
      expect(fromYaml.calls).toEqual([]);
    });

    it('test_register_service_schemes_are_namespaced_per_service_type', () => {
      const registry = new ServiceRegistry();
      const sessionService = new InMemorySessionService();
      const {factory, calls} = recordingFactory(sessionService);

      registry.registerSessionService('shared', factory);

      expect(registry.createArtifactService('shared://x')).toBeUndefined();
      expect(registry.createMemoryService('shared://x')).toBeUndefined();
      expect(calls).toEqual([]);
      expect(registry.createSessionService('shared://x')).toBe(sessionService);
    });
  });
});
