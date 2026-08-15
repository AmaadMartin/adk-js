/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
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
  ServiceRegistry,
  VertexAiSessionService,
  getServiceRegistry,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const vertexAiConstructor = vi.hoisted(() => vi.fn());

// The real constructor opens a Vertex AI client, so only this class is faked.
// importOriginal keeps every other export of the module real.
vi.mock(
  '../../src/sessions/vertex_ai_session_service.js',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('../../src/sessions/vertex_ai_session_service.js')
      >();

    return {
      ...original,
      VertexAiSessionService: class {
        constructor(options: object) {
          vertexAiConstructor(options);
        }
      },
    };
  },
);

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = new ServiceRegistry();
    vertexAiConstructor.mockClear();
  });

  describe('built-in session schemes', () => {
    it('serves "memory://" with an InMemorySessionService', () => {
      expect(registry.createSessionService('memory://')).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it.each([
      'postgres://user:pass@localhost:5432/db',
      'postgresql://user:pass@localhost:5432/db',
      'mysql://user:pass@localhost:3306/db',
      'mariadb://user:pass@localhost:3306/db',
      'mssql://user:pass@localhost:1433/db',
      'sqlite:///tmp/sessions.db',
    ])('serves %s with a DatabaseSessionService for the whole URI', (uri) => {
      const service = registry.createSessionService(uri);

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(
        (service as unknown as {connectionString: string}).connectionString,
      ).toBe(uri);
    });

    it('serves "sqlite://:memory:", which is not a parseable URL', () => {
      const service = registry.createSessionService('sqlite://:memory:');

      expect(service).toBeInstanceOf(DatabaseSessionService);
      expect(
        (service as unknown as {connectionString: string}).connectionString,
      ).toBe('sqlite://:memory:');
    });

    it('serves "vertexai://" with a VertexAiSessionService built from {}', () => {
      const service = registry.createSessionService(
        'vertexai://projects/p/locations/l',
      );

      expect(service).toBeInstanceOf(VertexAiSessionService);
      expect(vertexAiConstructor).toHaveBeenCalledWith({});
    });
  });

  describe('built-in artifact schemes', () => {
    it('serves "memory://" with an InMemoryArtifactService', () => {
      expect(registry.createArtifactService('memory://')).toBeInstanceOf(
        InMemoryArtifactService,
      );
    });

    it('serves "gs://" with a GcsArtifactService for the bucket', () => {
      const service = registry.createArtifactService('gs://my-bucket');

      expect(service).toBeInstanceOf(GcsArtifactService);
      expect((service as unknown as {bucket: {name: string}}).bucket.name).toBe(
        'my-bucket',
      );
    });

    it('serves "file://" with a FileArtifactService', () => {
      expect(
        registry.createArtifactService('file:///tmp/artifacts'),
      ).toBeInstanceOf(FileArtifactService);
    });
  });

  describe('built-in memory schemes', () => {
    it('serves "memory://" with an InMemoryMemoryService', () => {
      expect(registry.createMemoryService('memory://')).toBeInstanceOf(
        InMemoryMemoryService,
      );
    });
  });

  describe('custom registrations', () => {
    it('hands a session factory the whole URI and the options', () => {
      const service = {} as BaseSessionService;
      const factory = vi.fn().mockReturnValue(service);
      registry.registerSessionService('custom', factory);

      const created = registry.createSessionService(
        'custom://host/path?flag=1',
        {agentsDir: '/agents'},
      );

      expect(created).toBe(service);
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        'custom://host/path?flag=1',
        {agentsDir: '/agents'},
      );
    });

    it('hands an artifact factory the whole URI and the options', () => {
      const service = {} as BaseArtifactService;
      const factory = vi.fn().mockReturnValue(service);
      registry.registerArtifactService('custom', factory);

      const created = registry.createArtifactService(
        'custom://host/path?flag=1',
        {agentsDir: '/agents'},
      );

      expect(created).toBe(service);
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        'custom://host/path?flag=1',
        {agentsDir: '/agents'},
      );
    });

    it('hands a memory factory the whole URI and the options', () => {
      const service = {} as BaseMemoryService;
      const factory = vi.fn().mockReturnValue(service);
      registry.registerMemoryService('custom', factory);

      const created = registry.createMemoryService(
        'custom://host/path?flag=1',
        {
          agentsDir: '/agents',
        },
      );

      expect(created).toBe(service);
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        'custom://host/path?flag=1',
        {agentsDir: '/agents'},
      );
    });

    it('does not route another scheme to a registered factory', () => {
      const factory = vi.fn();
      registry.registerSessionService('custom', factory);

      expect(registry.createSessionService('other://host')).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
    });

    it('lets the last registration for a scheme win', () => {
      const first = vi.fn();
      const service = {} as BaseSessionService;
      const second = vi.fn().mockReturnValue(service);
      registry.registerSessionService('dup', first);
      registry.registerSessionService('dup', second);

      expect(registry.createSessionService('dup://x')).toBe(service);
      expect(first).not.toHaveBeenCalled();
    });

    it('lets a custom registration override a built-in', () => {
      const service = {} as BaseArtifactService;
      registry.registerArtifactService('gs', () => service);

      expect(registry.createArtifactService('gs://my-bucket')).toBe(service);
    });

    it('keeps each service kind in its own scheme namespace', () => {
      registry.registerSessionService(
        'shared',
        () => ({}) as BaseSessionService,
      );

      expect(registry.createArtifactService('shared://x')).toBeUndefined();
      expect(registry.createMemoryService('shared://x')).toBeUndefined();
    });

    it('matches a scheme case-insensitively', () => {
      const service = {} as BaseSessionService;
      registry.registerSessionService('MyScheme', () => service);

      expect(registry.createSessionService('myscheme://x')).toBe(service);
      expect(registry.createSessionService('MYSCHEME://x')).toBe(service);
    });
  });

  describe('unresolvable URIs', () => {
    it('returns undefined for an unsupported scheme', () => {
      expect(registry.createSessionService('unsupported://x')).toBeUndefined();
      expect(registry.createArtifactService('unsupported://x')).toBeUndefined();
      expect(registry.createMemoryService('unsupported://x')).toBeUndefined();
    });

    it('returns undefined for a string with no scheme', () => {
      expect(registry.createSessionService('not a uri')).toBeUndefined();
      expect(registry.createArtifactService('not a uri')).toBeUndefined();
      expect(registry.createMemoryService('not a uri')).toBeUndefined();
    });
  });

  describe('getServiceRegistry', () => {
    it('returns the same process-wide instance every time', () => {
      expect(getServiceRegistry()).toBe(getServiceRegistry());
    });

    it('returns an instance that already knows the built-ins', () => {
      expect(
        getServiceRegistry().createSessionService('memory://'),
      ).toBeInstanceOf(InMemorySessionService);
    });
  });
});
