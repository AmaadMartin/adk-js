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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {
  registerBuiltinServices,
  ServiceFactory,
  ServiceFactoryOptions,
  ServiceRegistry,
} from '../../src/cli/service_registry.js';
import {AdkLogger} from '../../src/utils/logger.js';

/**
 * Stands in for the RAG memory service `@google/adk` exports.
 *
 * `rag://` looks the class up by name at call time, so the test package does
 * not have to export it. The stub records the corpus resource name it is
 * built with and implements the memory service methods the factory checks for.
 */
const ragStub = vi.hoisted(() => {
  const corpora: string[] = [];
  class StubRagMemoryService {
    constructor(options: {ragCorpus: string}) {
      corpora.push(options.ragCorpus);
    }
    async addSessionToMemory(): Promise<void> {}
    async searchMemory(): Promise<{memories: []}> {
      return {memories: []};
    }
  }
  return {corpora, StubRagMemoryService};
});

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    DatabaseSessionService: vi.fn(),
    FileArtifactService: vi.fn(),
    GcsArtifactService: vi.fn(),
    VertexAiMemoryBankService: vi.fn(),
    VertexAiSessionService: vi.fn(),
    VertexAiRagMemoryService: ragStub.StubRagMemoryService,
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
async function assertRoutesFullUri<T>(
  service: T,
  register: (registry: ServiceRegistry, factory: ServiceFactory<T>) => void,
  create: (
    registry: ServiceRegistry,
    uri: string,
    options?: ServiceFactoryOptions,
  ) => Promise<T | undefined>,
): Promise<void> {
  const registry = new ServiceRegistry();
  const {factory, calls} = recordingFactory(service);
  register(registry, factory);

  const created = await create(registry, 'custom://host/path?flag=1', {
    agentsDir: '/agents',
  });

  expect(created).toBe(service);
  expect(calls).toEqual([
    ['custom://host/path?flag=1', {agentsDir: '/agents'}],
  ]);
  expect(await create(registry, 'other://host')).toBeUndefined();
  expect(calls).toHaveLength(1);
}

describe('ServiceRegistry', () => {
  let warn: MockInstance<AdkLogger['warn']>;

  beforeEach(() => {
    vi.clearAllMocks();
    ragStub.corpora.length = 0;
    warn = vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {});
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  describe('session services', () => {
    it('test_create_session_service_sqlite', async () => {
      const service =
        await builtinRegistry().createSessionService('sqlite:///test.db');

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(mockedDatabaseSession).toHaveBeenCalledWith('sqlite:///test.db');
    });

    it('test_create_session_service_sqlite_ignores_unsupported_kwargs', async () => {
      // Not portable: adk-js constructors take typed option objects, so there
      // are no kwargs to drop. `agentsDir` still must not reach the URI.
      await builtinRegistry().createSessionService('sqlite:///test.db', {
        agentsDir: 'foo',
      });

      expect(mockedDatabaseSession).toHaveBeenCalledWith('sqlite:///test.db');
      expect(warn).not.toHaveBeenCalled();
    });

    it('builds an in-memory session service for sqlite:// with no path', async () => {
      expect(
        await builtinRegistry().createSessionService('sqlite://'),
      ).toBeInstanceOf(InMemorySessionService);
      expect(warn).not.toHaveBeenCalled();
    });

    it('test_create_session_service_postgresql', async () => {
      const service = await builtinRegistry().createSessionService(
        'postgresql://user:pass@host/db',
      );

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(mockedDatabaseSession).toHaveBeenCalledWith(
        'postgresql://user:pass@host/db',
      );
    });

    it('builds a database session service for mysql://', async () => {
      await builtinRegistry().createSessionService('mysql://u:p@h/d');

      expect(mockedDatabaseSession).toHaveBeenCalledWith('mysql://u:p@h/d');
    });

    it.each(['postgres', 'mariadb', 'mssql'])(
      'claims the %s scheme that isDatabaseConnectionString accepts',
      async (scheme) => {
        const uri = `${scheme}://u:p@h/d`;

        const service = await builtinRegistry().createSessionService(uri);

        expect(service).toBeInstanceOf(DatabaseSessionService);
        expect(mockedDatabaseSession).toHaveBeenCalledWith(uri);
      },
    );

    it('test_create_session_service_agentengine_short', async () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      await builtinRegistry().createSessionService('agentengine://123', {
        agentsDir: AGENTS_DIR,
      });

      expect(mockedVertexSession).toHaveBeenCalledWith({
        projectId: 'test-project',
        location: 'us-central1',
        agentEngineId: '123',
      });
    });

    it('test_create_session_service_agentengine_full', async () => {
      await builtinRegistry().createSessionService(
        'agentengine://projects/p/locations/l/reasoningEngines/123',
        {agentsDir: AGENTS_DIR},
      );

      expect(mockedVertexSession).toHaveBeenCalledWith({
        projectId: 'p',
        location: 'l',
        agentEngineId: '123',
      });
    });

    it('rejects an empty agent engine resource', async () => {
      await expect(
        builtinRegistry().createSessionService('agentengine://'),
      ).rejects.toThrowError(
        'Agent engine resource name or resource id cannot be empty.',
      );
    });

    it('rejects a mal-formatted agent engine resource name', async () => {
      await expect(
        builtinRegistry().createSessionService(
          'agentengine://projects/p/foo/l',
        ),
      ).rejects.toThrowError('Agent engine resource name is mal-formatted.');
    });

    it('requires agentsDir for a short-form agent engine id', async () => {
      await expect(
        builtinRegistry().createSessionService('agentengine://123'),
      ).rejects.toThrowError(
        'agentsDir must be provided for short-form agent engine IDs',
      );
    });

    it('requires the Google Cloud project and location to be set', async () => {
      await expect(
        builtinRegistry().createSessionService('agentengine://123', {
          agentsDir: AGENTS_DIR,
        }),
      ).rejects.toThrowError(
        'GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.',
      );
    });

    it('builds an in-memory session service for an authority-less sqlite URI', async () => {
      expect(
        await builtinRegistry().createSessionService('sqlite:'),
      ).toBeInstanceOf(InMemorySessionService);
    });

    it('builds an in-memory session service for memory://', async () => {
      expect(
        await builtinRegistry().createSessionService('memory://'),
      ).toBeInstanceOf(InMemorySessionService);
    });
  });

  describe('artifact services', () => {
    it('test_create_artifact_service_gcs', async () => {
      await builtinRegistry().createArtifactService(
        'gs://my-bucket/path/prefix',
        {agentsDir: 'foo'},
      );

      expect(mockedGcsArtifact).toHaveBeenCalledWith('my-bucket');
      expect(warn).not.toHaveBeenCalled();
    });

    it('builds an in-memory artifact service for memory://', async () => {
      expect(
        await builtinRegistry().createArtifactService('memory://'),
      ).toBeInstanceOf(InMemoryArtifactService);
    });

    it('test_file_artifact_factory_normalizes_windows_file_uri', async () => {
      // Only the percent-decoding half of the reference test ports. Node's
      // `fileURLToPath` is platform-bound, and CI also runs Linux, so there is
      // no equivalent of monkeypatching `os.name` for the drive-letter half.
      await builtinRegistry().createArtifactService(
        'file:///tmp/adk%20artifacts',
      );

      expect(mockedFileArtifact).toHaveBeenCalledWith(
        expect.stringContaining('adk artifacts'),
      );
      expect(mockedFileArtifact).not.toHaveBeenCalledWith(
        expect.stringContaining('%20'),
      );
    });

    it('test_file_artifact_factory_rejects_non_local_authority', async () => {
      await expect(
        builtinRegistry().createArtifactService(
          'file://example.com/tmp/adk_artifacts',
        ),
      ).rejects.toThrowError('local filesystem');
      expect(mockedFileArtifact).not.toHaveBeenCalled();
    });

    it('accepts a localhost file URI', async () => {
      await builtinRegistry().createArtifactService(
        'file://localhost/tmp/artifacts',
      );

      expect(mockedFileArtifact).toHaveBeenCalledWith(
        expect.stringContaining('artifacts'),
      );
    });

    it('rejects a file URI with no path component', async () => {
      await expect(
        builtinRegistry().createArtifactService('file://'),
      ).rejects.toThrowError(
        'file:// artifact URIs must include a path component.',
      );
    });
  });

  describe('memory services', () => {
    it('test_create_memory_service_rag', async () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      const service = await builtinRegistry().createMemoryService(
        'rag://corpus-123',
        {agentsDir: AGENTS_DIR},
      );

      expect(service).toBeInstanceOf(ragStub.StubRagMemoryService);
      expect(ragStub.corpora).toEqual([
        'projects/test-project/locations/us-central1/ragCorpora/corpus-123',
      ]);
    });

    it('rejects a rag URI with no corpus', async () => {
      await expect(
        builtinRegistry().createMemoryService('rag://', {
          agentsDir: AGENTS_DIR,
        }),
      ).rejects.toThrowError('Rag corpus can not be empty.');
    });

    it('requires the Google Cloud project and location for a rag corpus', async () => {
      await expect(
        builtinRegistry().createMemoryService('rag://corpus-123', {
          agentsDir: AGENTS_DIR,
        }),
      ).rejects.toThrowError(
        'GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.',
      );
    });

    it('requires agentsDir for a rag corpus', async () => {
      await expect(
        builtinRegistry().createMemoryService('rag://corpus-123'),
      ).rejects.toThrowError(
        'agentsDir must be provided for RAG memory service',
      );
    });

    it('test_create_memory_service_agentengine_short', async () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';

      await builtinRegistry().createMemoryService('agentengine://456', {
        agentsDir: AGENTS_DIR,
      });

      expect(mockedMemoryBank).toHaveBeenCalledWith({
        projectId: 'test-project',
        location: 'us-central1',
        agentEngineId: '456',
      });
    });

    it('test_create_memory_service_agentengine_full', async () => {
      await builtinRegistry().createMemoryService(
        'agentengine://projects/p/locations/l/reasoningEngines/456',
        {agentsDir: AGENTS_DIR},
      );

      expect(mockedMemoryBank).toHaveBeenCalledWith({
        projectId: 'p',
        location: 'l',
        agentEngineId: '456',
      });
    });

    it('test_create_memory_service_memory', async () => {
      expect(
        await builtinRegistry().createMemoryService('memory://'),
      ).toBeInstanceOf(InMemoryMemoryService);
    });
  });

  describe('scheme routing', () => {
    it('test_unsupported_scheme', async () => {
      const registry = builtinRegistry();

      expect(
        await registry.createSessionService('unsupported://foo'),
      ).toBeUndefined();
      expect(
        await registry.createArtifactService('unsupported://foo'),
      ).toBeUndefined();
      expect(
        await registry.createMemoryService('unsupported://foo'),
      ).toBeUndefined();
      expect(mockedDatabaseSession).not.toHaveBeenCalled();
      expect(mockedVertexSession).not.toHaveBeenCalled();
      expect(mockedGcsArtifact).not.toHaveBeenCalled();
      expect(mockedMemoryBank).not.toHaveBeenCalled();
    });

    it('returns undefined for a string that carries no scheme', async () => {
      expect(
        await builtinRegistry().createSessionService('not-a-uri'),
      ).toBeUndefined();
    });

    it('matches a scheme case-insensitively', async () => {
      expect(
        await builtinRegistry().createSessionService('MEMORY://'),
      ).toBeInstanceOf(InMemorySessionService);
    });

    it('awaits a factory that initializes the service asynchronously', async () => {
      const registry = new ServiceRegistry();
      const service = new InMemorySessionService();
      registry.registerSessionService('async', async () => {
        await Promise.resolve();
        return service;
      });

      expect(await registry.createSessionService('async://x')).toBe(service);
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (session)', async () => {
      await assertRoutesFullUri<BaseSessionService>(
        new InMemorySessionService(),
        (registry, factory) =>
          registry.registerSessionService('custom', factory),
        (registry, uri, options) => registry.createSessionService(uri, options),
      );
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (artifact)', async () => {
      await assertRoutesFullUri<BaseArtifactService>(
        new InMemoryArtifactService(),
        (registry, factory) =>
          registry.registerArtifactService('custom', factory),
        (registry, uri, options) =>
          registry.createArtifactService(uri, options),
      );
    });

    it('test_register_service_routes_matching_scheme_with_full_uri (memory)', async () => {
      await assertRoutesFullUri<BaseMemoryService>(
        new InMemoryMemoryService(),
        (registry, factory) =>
          registry.registerMemoryService('custom', factory),
        (registry, uri, options) => registry.createMemoryService(uri, options),
      );
    });

    it('test_register_session_service_last_registration_wins', async () => {
      const registry = new ServiceRegistry();
      const scriptService = new InMemorySessionService();
      const fromYaml = recordingFactory(new InMemorySessionService());
      const fromScript = recordingFactory(scriptService);

      registry.registerSessionService('dup', fromYaml.factory);
      registry.registerSessionService('dup', fromScript.factory);

      expect(await registry.createSessionService('dup://x')).toBe(
        scriptService,
      );
      expect(fromYaml.calls).toEqual([]);
    });

    it('test_register_service_schemes_are_namespaced_per_service_type', async () => {
      const registry = new ServiceRegistry();
      const sessionService = new InMemorySessionService();
      const {factory, calls} = recordingFactory(sessionService);

      registry.registerSessionService('shared', factory);

      expect(
        await registry.createArtifactService('shared://x'),
      ).toBeUndefined();
      expect(await registry.createMemoryService('shared://x')).toBeUndefined();
      expect(calls).toEqual([]);
      expect(await registry.createSessionService('shared://x')).toBe(
        sessionService,
      );
    });
  });
});
