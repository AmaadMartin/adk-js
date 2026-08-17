/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppendEventRequest,
  ArtifactVersion,
  BaseArtifactService,
  BaseSessionService,
  CreateSessionRequest,
  DatabaseSessionService,
  DeleteArtifactRequest,
  DeleteSessionRequest,
  Event,
  FileArtifactService,
  GetSessionRequest,
  InMemoryArtifactService,
  InMemorySessionService,
  ListArtifactKeysRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  ListVersionsRequest,
  LoadArtifactRequest,
  SaveArtifactRequest,
  Session,
} from '@google/adk';
import {Part} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {DotAdkFolder, resolveAgentDir} from './dot_adk_folder.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'LocalStorage', colorize: {all: true}});

/** Filesystem error codes that mean the disk refuses local storage. */
const STORAGE_DENIED_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);

/** Returns true when `e` is a filesystem error that denies local storage. */
function isStorageDenied(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    typeof e.code === 'string' &&
    STORAGE_DENIED_ERROR_CODES.has(e.code)
  );
}

/** Creates a SQLite-backed session service at `<baseDir>/.adk/session.db`. */
export async function createLocalDatabaseSessionService(options: {
  baseDir: string;
}): Promise<BaseSessionService> {
  const folder = new DotAdkFolder(options.baseDir);
  // MikroORM creates the database file but not the directory that holds it.
  await fs.mkdir(folder.dotAdkDir, {recursive: true});
  logger.debug(`Using local session storage at ${folder.sessionDbPath}`);

  const service = new DatabaseSessionService(
    `sqlite://${folder.sessionDbPath}`,
  );
  // `init()` marks itself done only after it has created the schema, so two
  // concurrent first requests would each try to create the tables. Run it here,
  // where the caller caches this one promise for the whole app.
  await service.init();

  return service;
}

/** Creates a file-backed artifact service at `<baseDir>/.adk/artifacts`. */
export async function createLocalArtifactService(options: {
  baseDir: string;
}): Promise<BaseArtifactService> {
  const folder = new DotAdkFolder(options.baseDir);
  await fs.mkdir(folder.artifactsDir, {recursive: true});
  logger.debug(`Using local artifact storage at ${folder.artifactsDir}`);

  return new FileArtifactService(folder.artifactsDir);
}

/**
 * Falls back to `inMemory()` when the disk refuses the agent's `.adk` folder.
 *
 * Any other failure is rethrown: a full or corrupt disk must not be downgraded
 * to a store that silently loses the data written to it.
 */
async function withInMemoryFallback<T>(
  baseDir: string,
  create: () => Promise<T>,
  inMemory: () => T,
): Promise<T> {
  try {
    return await create();
  } catch (e: unknown) {
    if (!isStorageDenied(e)) {
      throw e;
    }
    logger.warn(
      `Cannot write local storage under ${baseDir}; using an in-memory ` +
        `service for this agent. Its data is lost when the process exits.`,
    );

    return inMemory();
  }
}

function createAgentSessionService(
  baseDir: string,
): Promise<BaseSessionService> {
  return withInMemoryFallback(
    baseDir,
    () => createLocalDatabaseSessionService({baseDir}),
    () => new InMemorySessionService(),
  );
}

function createAgentArtifactService(
  baseDir: string,
): Promise<BaseArtifactService> {
  return withInMemoryFallback(
    baseDir,
    () => createLocalArtifactService({baseDir}),
    () => new InMemoryArtifactService(),
  );
}

/**
 * Returns the service that stores `appName`'s data, creating it on first use.
 *
 * The pending promise is cached before the first `await`, so two concurrent
 * requests for one app share a single service over its single storage folder.
 */
function serviceForApp<T>(
  services: Map<string, Promise<T>>,
  agentsRoot: string,
  appName: string,
  create: (baseDir: string) => Promise<T>,
): Promise<T> {
  const cached = services.get(appName);
  if (cached) {
    return cached;
  }

  const created = create(resolveAgentDir({agentsRoot, appName}));
  services.set(appName, created);

  return created;
}

/** Routes session storage to per-agent `<agentsRoot>/<app>/.adk/session.db`. */
export class PerAgentDatabaseSessionService extends BaseSessionService {
  private readonly agentsRoot: string;
  private readonly services = new Map<string, Promise<BaseSessionService>>();

  constructor(options: {agentsRoot: string}) {
    super();
    this.agentsRoot = path.resolve(options.agentsRoot);
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    const service = await this.serviceFor(request.appName);

    return service.createSession(request);
  }

  async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const service = await this.serviceFor(request.appName);

    return service.getSession(request);
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const service = await this.serviceFor(request.appName);

    return service.listSessions(request);
  }

  async deleteSession(request: DeleteSessionRequest): Promise<void> {
    const service = await this.serviceFor(request.appName);

    return service.deleteSession(request);
  }

  /**
   * The inherited implementation only mutates the in-memory session object, so
   * without this override no event ever reaches the database.
   */
  override async appendEvent(request: AppendEventRequest): Promise<Event> {
    const service = await this.serviceFor(request.session.appName);

    return service.appendEvent(request);
  }

  private serviceFor(appName: string): Promise<BaseSessionService> {
    return serviceForApp(
      this.services,
      this.agentsRoot,
      appName,
      createAgentSessionService,
    );
  }
}

/** Routes artifact storage to per-agent `<agentsRoot>/<app>/.adk/artifacts`. */
export class PerAgentFileArtifactService implements BaseArtifactService {
  private readonly agentsRoot: string;
  private readonly services = new Map<string, Promise<BaseArtifactService>>();

  constructor(options: {agentsRoot: string}) {
    this.agentsRoot = path.resolve(options.agentsRoot);
  }

  async saveArtifact(request: SaveArtifactRequest): Promise<number> {
    const service = await this.serviceFor(request.appName);

    return service.saveArtifact(request);
  }

  async loadArtifact(request: LoadArtifactRequest): Promise<Part | undefined> {
    const service = await this.serviceFor(request.appName);

    return service.loadArtifact(request);
  }

  async listArtifactKeys(request: ListArtifactKeysRequest): Promise<string[]> {
    const service = await this.serviceFor(request.appName);

    return service.listArtifactKeys(request);
  }

  async deleteArtifact(request: DeleteArtifactRequest): Promise<void> {
    const service = await this.serviceFor(request.appName);

    return service.deleteArtifact(request);
  }

  async listVersions(request: ListVersionsRequest): Promise<number[]> {
    const service = await this.serviceFor(request.appName);

    return service.listVersions(request);
  }

  async listArtifactVersions(
    request: ListVersionsRequest,
  ): Promise<ArtifactVersion[]> {
    const service = await this.serviceFor(request.appName);

    return service.listArtifactVersions(request);
  }

  async getArtifactVersion(
    request: LoadArtifactRequest,
  ): Promise<ArtifactVersion | undefined> {
    const service = await this.serviceFor(request.appName);

    return service.getArtifactVersion(request);
  }

  private serviceFor(appName: string): Promise<BaseArtifactService> {
    return serviceForApp(
      this.services,
      this.agentsRoot,
      appName,
      createAgentArtifactService,
    );
  }
}
