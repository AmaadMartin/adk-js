/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {FileArtifactService} from '../artifacts/file_artifact_service.js';
import {GcsArtifactService} from '../artifacts/gcs_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {VertexAiMemoryBankService} from '../memory/vertex_ai_memory_bank_service.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {
  DATABASE_URI_SCHEMES,
  DatabaseSessionService,
} from '../sessions/database_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {VertexAiSessionService} from '../sessions/vertex_ai_session_service.js';
import {resolveAgentEngineResource} from '../utils/vertex_ai_utils.js';

/** Extra context handed to a service factory by the caller that builds it. */
export interface ServiceFactoryOptions {
  /** Absolute path of the agent directory the CLI is serving, when known. */
  agentsDir?: string;
}

/** Builds a session service from a service URI. */
export type SessionServiceFactory = (
  uri: string,
  options?: ServiceFactoryOptions,
) => BaseSessionService;

/** Builds an artifact service from a service URI. */
export type ArtifactServiceFactory = (
  uri: string,
  options?: ServiceFactoryOptions,
) => BaseArtifactService;

/** Builds a memory service from a service URI. */
export type MemoryServiceFactory = (
  uri: string,
  options?: ServiceFactoryOptions,
) => BaseMemoryService;

/**
 * The service factories a `services.{ts,js}` module in an agent directory
 * exports, keyed by the URI scheme each one serves.
 *
 * The contract is a declarative exported object rather than a module that calls
 * `getServiceRegistry().register…()` itself. The dev CLI bundles the user
 * module separately, so that module can carry its own copy of `@google/adk`;
 * registering from inside it would mutate a second, unrelated singleton and the
 * registration would silently vanish. Keeping the host process the only writer
 * avoids that.
 */
export interface ServiceRegistrations {
  session?: Record<string, SessionServiceFactory>;
  artifact?: Record<string, ArtifactServiceFactory>;
  memory?: Record<string, MemoryServiceFactory>;
}

/** A URI scheme, per RFC 3986 section 3.1. */
const URI_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/**
 * Reads the scheme from a URI, lowercased because schemes are
 * case-insensitive.
 *
 * This deliberately does not use `URL`, which rejects authorities that these
 * service URIs use legitimately, such as `sqlite://:memory:`.
 *
 * @param uri The URI to read.
 * @returns The scheme, or undefined when the URI does not start with one.
 */
function getUriScheme(uri: string): string | undefined {
  return URI_SCHEME.exec(uri)?.[1].toLowerCase();
}

function createFromScheme<T>(
  factories: Map<string, (uri: string, options?: ServiceFactoryOptions) => T>,
  uri: string,
  options?: ServiceFactoryOptions,
): T | undefined {
  const scheme = getUriScheme(uri);

  return scheme === undefined
    ? undefined
    : factories.get(scheme)?.(uri, options);
}

/**
 * Dispatches a service URI to the factory registered for its scheme.
 *
 * The built-in schemes are registered by the constructor, so a fresh instance
 * is fully loaded. Registering a scheme that is already registered replaces it,
 * which is how a user factory overrides a built-in.
 *
 * Each service kind keeps its own scheme namespace: a session factory
 * registered for `mysession` is invisible to artifact and memory lookups.
 */
export class ServiceRegistry {
  private readonly sessionFactories = new Map<string, SessionServiceFactory>();
  private readonly artifactFactories = new Map<
    string,
    ArtifactServiceFactory
  >();
  private readonly memoryFactories = new Map<string, MemoryServiceFactory>();

  constructor() {
    this.registerSessionService('memory', () => new InMemorySessionService());
    for (const scheme of DATABASE_URI_SCHEMES) {
      this.registerSessionService(
        scheme,
        (uri) => new DatabaseSessionService(uri),
      );
    }
    // uri is something like vertexai://projects/abc/locations/us-central1
    this.registerSessionService(
      'vertexai',
      () => new VertexAiSessionService({}),
    );

    this.registerArtifactService('memory', () => new InMemoryArtifactService());
    this.registerArtifactService(
      'gs',
      (uri) => new GcsArtifactService(uri.split('://')[1]),
    );
    this.registerArtifactService(
      'file',
      (uri) => new FileArtifactService(uri.split('://')[1]),
    );

    this.registerMemoryService('memory', () => new InMemoryMemoryService());
    this.registerMemoryService(
      'agentengine',
      (uri) =>
        new VertexAiMemoryBankService(
          resolveAgentEngineResource(uri.slice('agentengine://'.length)),
        ),
    );
  }

  registerSessionService(scheme: string, factory: SessionServiceFactory): void {
    this.sessionFactories.set(scheme.toLowerCase(), factory);
  }

  registerArtifactService(
    scheme: string,
    factory: ArtifactServiceFactory,
  ): void {
    this.artifactFactories.set(scheme.toLowerCase(), factory);
  }

  registerMemoryService(scheme: string, factory: MemoryServiceFactory): void {
    this.memoryFactories.set(scheme.toLowerCase(), factory);
  }

  /** Returns undefined when no factory owns the URI's scheme. */
  createSessionService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseSessionService | undefined {
    return createFromScheme(this.sessionFactories, uri, options);
  }

  /** Returns undefined when no factory owns the URI's scheme. */
  createArtifactService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseArtifactService | undefined {
    return createFromScheme(this.artifactFactories, uri, options);
  }

  /** Returns undefined when no factory owns the URI's scheme. */
  createMemoryService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseMemoryService | undefined {
    return createFromScheme(this.memoryFactories, uri, options);
  }
}

let serviceRegistry: ServiceRegistry | undefined;

/** The process-wide registry the `get*ServiceFromUri` helpers consult. */
export function getServiceRegistry(): ServiceRegistry {
  serviceRegistry ??= new ServiceRegistry();

  return serviceRegistry;
}
