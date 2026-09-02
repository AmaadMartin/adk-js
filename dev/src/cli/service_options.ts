/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  getArtifactServiceFromUri,
  getMemoryServiceFromUri,
  getSessionServiceFromUri,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
} from '@google/adk';
import {Command, Option} from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

const SESSION_SERVICE_URI_KEY = 'session_service_uri';
const ARTIFACT_SERVICE_URI_KEY = 'artifact_service_uri';
const MEMORY_SERVICE_URI_KEY = 'memory_service_uri';
const USE_LOCAL_STORAGE_KEY = 'use_local_storage';
const NO_USE_LOCAL_STORAGE_KEY = 'no_use_local_storage';

const DISABLE_LOCAL_STORAGE_ENV = 'ADK_DISABLE_LOCAL_STORAGE';
const FORCE_LOCAL_STORAGE_ENV = 'ADK_FORCE_LOCAL_STORAGE';

/** Directory created under the agents directory to hold local storage. */
const LOCAL_STORAGE_DIR = '.adk';
const SESSIONS_DB_FILE = 'sessions.db';
const ARTIFACTS_DIR = 'artifacts';

export const MEMORY_SERVICE_URI_OPTION = new Option(
  `--${MEMORY_SERVICE_URI_KEY} <string>`,
  'Optional. The URI of the memory service. Supported URIs: memory:// for ' +
    'the in-memory memory service, and agentengine://<agent_engine> for the ' +
    'Agent Engine memory bank, where <agent_engine> is either the resource ' +
    'id or the full resource name.',
);

export const USE_LOCAL_STORAGE_OPTION = new Option(
  `--${USE_LOCAL_STORAGE_KEY}`,
  'Optional. Store sessions and artifacts under <agents_dir>/.adk when ' +
    '--session_service_uri and --artifact_service_uri are unset. Cannot be ' +
    'combined with explicit service URIs. When the agents directory is not ' +
    'writable, ADK falls back to in-memory unless overridden by ' +
    `${FORCE_LOCAL_STORAGE_ENV}=1 or ${DISABLE_LOCAL_STORAGE_ENV}=1.`,
);

export const NO_USE_LOCAL_STORAGE_OPTION = new Option(
  `--${NO_USE_LOCAL_STORAGE_KEY}`,
  'Optional. Keep sessions and artifacts in memory instead of ' +
    '<agents_dir>/.adk. Cannot be combined with explicit service URIs.',
);

/**
 * Reconciles the two local-storage flags against the service URIs.
 *
 * commander cannot express click's `--use_local_storage/--no_use_local_storage`
 * pair, because the negated form there spells its name with an underscore, so
 * the two flags are declared separately and reconciled here. Local storage is
 * on unless the user turns it off, which is also what `--use_local_storage`
 * asks for, so the two flags only disagree when both are given.
 *
 * @param command The command whose options were parsed.
 * @returns Whether the caller asked for local storage.
 */
export function resolveUseLocalStorage(command: Command): boolean {
  const options = command.opts();
  const useLocalStorage = options[USE_LOCAL_STORAGE_KEY] === true;
  const noUseLocalStorage = options[NO_USE_LOCAL_STORAGE_KEY] === true;

  if (
    (useLocalStorage || noUseLocalStorage) &&
    (options[SESSION_SERVICE_URI_KEY] || options[ARTIFACT_SERVICE_URI_KEY])
  ) {
    command.error(
      `error: --${USE_LOCAL_STORAGE_KEY}/--${NO_USE_LOCAL_STORAGE_KEY} cannot ` +
        `be used with --${SESSION_SERVICE_URI_KEY} or ` +
        `--${ARTIFACT_SERVICE_URI_KEY}.`,
      {exitCode: 2},
    );
  }

  return !noUseLocalStorage;
}

/** An environment variable counts as on when it reads `true` or `1`. */
function isEnvEnabled(name: string): boolean {
  return ['true', '1'].includes((process.env[name] ?? '').toLowerCase());
}

function isDirWritable(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return false;
    }
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isManagedRuntime(): boolean {
  return Boolean(
    process.env['K_SERVICE'] || process.env['KUBERNETES_SERVICE_HOST'],
  );
}

/** The outcome of the local-storage decision, plus why it was overruled. */
export interface EffectiveLocalStorage {
  enabled: boolean;
  warning?: string;
}

/**
 * Decides whether local storage is actually usable, given the environment.
 *
 * Local storage writes into the agents directory, which is read-only on most
 * container runtimes. Falling back to in-memory keeps the server running
 * there instead of failing at the first write.
 *
 * @param baseDir The directory that would hold the `.adk` folder.
 * @param requested Whether the caller asked for local storage.
 */
export function resolveEffectiveLocalStorage(
  baseDir: string,
  requested: boolean,
): EffectiveLocalStorage {
  if (isEnvEnabled(DISABLE_LOCAL_STORAGE_ENV)) {
    return {
      enabled: false,
      warning:
        `Local storage is disabled by ${DISABLE_LOCAL_STORAGE_ENV}; using ` +
        'in-memory services. Set --session_service_uri/--artifact_service_uri ' +
        'for production deployments.',
    };
  }

  if (isEnvEnabled(FORCE_LOCAL_STORAGE_ENV)) {
    if (!isDirWritable(baseDir)) {
      return {
        enabled: false,
        warning:
          `Local storage is forced by ${FORCE_LOCAL_STORAGE_ENV}, but ` +
          `${baseDir} is not writable; using in-memory services.`,
      };
    }
    return {enabled: true};
  }

  if (!requested) {
    return {enabled: false};
  }

  if (isManagedRuntime()) {
    return {
      enabled: false,
      warning:
        'Detected Cloud Run/Kubernetes runtime; using in-memory services ' +
        `instead of local ${LOCAL_STORAGE_DIR} storage. Set ` +
        `${FORCE_LOCAL_STORAGE_ENV}=1 to force local storage.`,
    };
  }

  if (!isDirWritable(baseDir)) {
    return {
      enabled: false,
      warning:
        `Agents directory ${baseDir} is not writable; using in-memory ` +
        `services instead of local ${LOCAL_STORAGE_DIR} storage. Set ` +
        `${FORCE_LOCAL_STORAGE_ENV}=1 to force local storage.`,
    };
  }

  return {enabled: true};
}

/** Options that decide which session, artifact and memory services to build. */
export interface ResolveServicesOptions {
  /** Directory that holds the `.adk` folder when local storage is used. */
  baseDir: string;
  sessionServiceUri?: string;
  artifactServiceUri?: string;
  memoryServiceUri?: string;
  useLocalStorage: boolean;
  /** Forces every service in memory, overriding every other option. */
  inMemory?: boolean;
}

/** The three services a runner or a server needs. */
export interface ResolvedServices {
  sessionService: BaseSessionService;
  artifactService: BaseArtifactService;
  memoryService: BaseMemoryService;
}

/** A service that holds something open until it is told to let go. */
interface Closable {
  close(): Promise<void> | void;
}

function isClosable(value: object): value is Closable {
  return 'close' in value && typeof value.close === 'function';
}

/**
 * Releases whatever the resolved services hold open.
 *
 * The database session service keeps a sqlite connection on the event loop, so
 * a command that builds one and does not close it never exits. Every caller of
 * {@link resolveServices} that outlives its own run must call this.
 */
export async function closeServices(services: ResolvedServices): Promise<void> {
  await Promise.all(
    Object.values(services)
      .filter(isClosable)
      .map((service) => service.close()),
  );
}

/**
 * Builds the session, artifact and memory services for a command.
 *
 * An explicit URI always wins for its own service. Otherwise local storage
 * decides between `<baseDir>/.adk` and in-memory. The memory service never
 * uses local storage, because there is no local memory implementation.
 */
export function resolveServices(
  options: ResolveServicesOptions,
): ResolvedServices {
  const inMemory = options.inMemory === true;
  const sessionServiceUri = inMemory
    ? 'memory://'
    : (options.sessionServiceUri ?? process.env['DATABASE_URL']);
  const artifactServiceUri = inMemory
    ? 'memory://'
    : options.artifactServiceUri;
  const memoryServiceUri = inMemory ? 'memory://' : options.memoryServiceUri;

  const localStorage = inMemory
    ? {enabled: false}
    : resolveEffectiveLocalStorage(options.baseDir, options.useLocalStorage);
  if (localStorage.warning) {
    logger.warn(localStorage.warning);
  }

  const storageDir = path.join(options.baseDir, LOCAL_STORAGE_DIR);
  if (localStorage.enabled) {
    fs.mkdirSync(storageDir, {recursive: true});
  }

  return {
    sessionService: buildSessionService(
      sessionServiceUri,
      localStorage.enabled,
      storageDir,
    ),
    artifactService: buildArtifactService(
      artifactServiceUri,
      localStorage.enabled,
      storageDir,
    ),
    memoryService: memoryServiceUri
      ? getMemoryServiceFromUri(memoryServiceUri)
      : new InMemoryMemoryService(),
  };
}

function buildSessionService(
  uri: string | undefined,
  localStorageEnabled: boolean,
  storageDir: string,
): BaseSessionService {
  if (uri) {
    return getSessionServiceFromUri(uri);
  }
  if (localStorageEnabled) {
    return getSessionServiceFromUri(
      `sqlite://${path.join(storageDir, SESSIONS_DB_FILE)}`,
    );
  }
  return new InMemorySessionService();
}

function buildArtifactService(
  uri: string | undefined,
  localStorageEnabled: boolean,
  storageDir: string,
): BaseArtifactService {
  if (uri) {
    return getArtifactServiceFromUri(uri);
  }
  if (localStorageEnabled) {
    return getArtifactServiceFromUri(
      `file://${path.join(storageDir, ARTIFACTS_DIR)}`,
    );
  }
  return new InMemoryArtifactService();
}
