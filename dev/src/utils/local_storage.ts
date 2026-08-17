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

import {dotAdkDir, resolveAgentDir} from './dot_adk_folder.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'LocalStorage', colorize: {all: true}});

/** Creates a SQLite-backed session service at `<baseDir>/.adk/session.db`. */
export async function createLocalDatabaseSessionService(
  baseDir: string,
): Promise<BaseSessionService> {
  const folder = dotAdkDir(baseDir);
  // MikroORM creates the database file but not the directory that holds it.
  await fs.mkdir(folder, {recursive: true});

  const sessionDbPath = path.join(folder, 'session.db');
  logger.debug(`Using local session storage at ${sessionDbPath}`);

  const service = new DatabaseSessionService(`sqlite://${sessionDbPath}`);
  // `init()` marks itself done only after it has created the schema, so two
  // concurrent first requests would each try to create the tables. Run it here,
  // where the caller caches this one promise for the whole app.
  await service.init();

  return service;
}

/** Creates a file-backed artifact service at `<baseDir>/.adk/artifacts`. */
export async function createLocalArtifactService(
  baseDir: string,
): Promise<BaseArtifactService> {
  const artifactsDir = path.join(dotAdkDir(baseDir), 'artifacts');
  await fs.mkdir(artifactsDir, {recursive: true});
  logger.debug(`Using local artifact storage at ${artifactsDir}`);

  return new FileArtifactService(artifactsDir);
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
    this.agentsRoot = options.agentsRoot;
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
      createLocalDatabaseSessionService,
    );
  }
}

/** Routes artifact storage to per-agent `<agentsRoot>/<app>/.adk/artifacts`. */
export class PerAgentFileArtifactService implements BaseArtifactService {
  private readonly agentsRoot: string;
  private readonly services = new Map<string, Promise<BaseArtifactService>>();

  constructor(options: {agentsRoot: string}) {
    this.agentsRoot = options.agentsRoot;
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
      createLocalArtifactService,
    );
  }
}
