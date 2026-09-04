/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADK service registry: URI scheme -> the service that serves it.
 *
 * A scheme is added from the agent directory, either declaratively in
 * `services.yaml` or imperatively in `services.js`. Both files may be present:
 * the YAML file is processed first, so a scheme declared in both ends up bound
 * to the factory `services.js` registers.
 *
 * See `docs/guides/apps/service_registry/index.md`.
 *
 * Ported from adk-python `src/google/adk/cli/service_registry.py`.
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
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import {readFile} from 'node:fs/promises';
import {isBuiltin} from 'node:module';
import * as path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isFileExists, isFolderExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'ADK Service Registry'});

/** The YAML files a services declaration may live in, in load order. */
const SERVICE_YAML_FILES = ['services.yaml', 'services.yml'] as const;

/** The JavaScript module that registers services imperatively. */
const SERVICE_SCRIPT_FILE = 'services.js';

/** Matches the scheme of a URI, e.g. `postgresql+asyncpg` in `...://host`. */
const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;

const URI_AUTHORITY_PREFIX = '//';

/** Everything a factory receives besides the URI. */
export interface ServiceFactoryOptions {
  /**
   * The agent directory. Factories that need a Google Cloud project and
   * location read `<agentsDir>/.env` before the ambient environment.
   */
  agentsDir?: string;
}

/** Builds one service from the URI that named it. */
export type ServiceFactory<T> = (
  uri: string,
  options?: ServiceFactoryOptions,
) => T;

/** The service kinds a `services.yaml` entry can declare. */
export type ServiceType = 'session' | 'artifact' | 'memory';

/** The single argument a class declared in `services.yaml` is constructed with. */
export interface DeclaredServiceOptions extends ServiceFactoryOptions {
  /** The URI that selected this service, unmodified. */
  uri: string;
}

/** A class a `services.yaml` entry may name. */
type DeclaredServiceConstructor = new (
  options: DeclaredServiceOptions,
) => unknown;

/** Registry of URI schemes and the services they build. */
export class ServiceRegistry {
  private readonly sessionFactories = new Map<
    string,
    ServiceFactory<BaseSessionService>
  >();
  private readonly artifactFactories = new Map<
    string,
    ServiceFactory<BaseArtifactService>
  >();
  private readonly memoryFactories = new Map<
    string,
    ServiceFactory<BaseMemoryService>
  >();
  /**
   * Binds a session service URI scheme to a factory, replacing any factory
   * already bound to that scheme.
   */
  registerSessionService(
    scheme: string,
    factory: ServiceFactory<BaseSessionService>,
  ): void {
    this.sessionFactories.set(scheme, factory);
  }

  /** Binds an artifact service URI scheme to a factory. */
  registerArtifactService(
    scheme: string,
    factory: ServiceFactory<BaseArtifactService>,
  ): void {
    this.artifactFactories.set(scheme, factory);
  }

  /** Binds a memory service URI scheme to a factory. */
  registerMemoryService(
    scheme: string,
    factory: ServiceFactory<BaseMemoryService>,
  ): void {
    this.memoryFactories.set(scheme, factory);
  }

  /**
   * Builds the session service for `uri`, or returns `undefined` when no
   * factory claims its scheme so the caller can fall back.
   */
  createSessionService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseSessionService | undefined {
    return createFromFactories(this.sessionFactories, uri, options);
  }

  /** Builds the artifact service for `uri`, or `undefined`. */
  createArtifactService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseArtifactService | undefined {
    return createFromFactories(this.artifactFactories, uri, options);
  }

  /** Builds the memory service for `uri`, or `undefined`. */
  createMemoryService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): BaseMemoryService | undefined {
    return createFromFactories(this.memoryFactories, uri, options);
  }
}

let serviceRegistryInstance: ServiceRegistry | undefined;

/** Returns the process-wide registry, seeded with the built-in schemes. */
export function getServiceRegistry(): ServiceRegistry {
  if (!serviceRegistryInstance) {
    serviceRegistryInstance = new ServiceRegistry();
    registerBuiltinServices(serviceRegistryInstance);
  }
  return serviceRegistryInstance;
}

/**
 * Registers the services ADK ships with on `registry`.
 *
 * `getServiceRegistry` calls this once. Call it yourself to seed a private
 * registry that custom registrations cannot leak out of.
 */
export function registerBuiltinServices(registry: ServiceRegistry): void {
  registry.registerSessionService('memory', createInMemorySessionService);
  registry.registerSessionService('sqlite', createSqliteSessionService);
  registry.registerSessionService('postgresql', createDatabaseSessionService);
  registry.registerSessionService('mysql', createDatabaseSessionService);
  registry.registerSessionService(
    'agentengine',
    createAgentEngineSessionService,
  );

  registry.registerArtifactService('memory', createInMemoryArtifactService);
  registry.registerArtifactService('gs', createGcsArtifactService);
  registry.registerArtifactService('file', createFileArtifactService);

  registry.registerMemoryService('memory', createInMemoryMemoryService);
  registry.registerMemoryService('agentengine', createAgentEngineMemoryService);
}

/**
 * Registers the services declared beside the agent in `agentsDir`.
 *
 * Reads `services.yaml`/`services.yml` first, then executes
 * `services.js`. A YAML file that fails to load stops the whole load, so a
 * half-registered directory is never silently completed by the script.
 */
export async function loadServicesModule(
  agentsDir: string,
  registry: ServiceRegistry = getServiceRegistry(),
): Promise<void> {
  if (!(await isFolderExists(agentsDir))) {
    logger.debug(
      `agentsDir ${agentsDir} is not a valid directory, skipping service loading.`,
    );
    return;
  }

  for (const yamlFile of SERVICE_YAML_FILES) {
    const yamlPath = path.join(agentsDir, yamlFile);
    if (!(await isFileExists(yamlPath))) {
      continue;
    }
    try {
      const config: unknown = yaml.load(await readFile(yamlPath, 'utf-8'));
      await registerServicesFromYamlConfig(config, registry, agentsDir);
      logger.debug(`Loaded custom services from ${yamlFile} in ${agentsDir}.`);
    } catch (e: unknown) {
      logger.warn(
        `Failed to load ${yamlFile} from ${agentsDir}: ${toError(e).message}`,
      );
      return;
    }
  }

  const scriptPath = path.join(agentsDir, SERVICE_SCRIPT_FILE);
  if (!(await isFileExists(scriptPath))) {
    logger.debug(`${SERVICE_SCRIPT_FILE} not found in ${agentsDir}, skipping.`);
    return;
  }
  try {
    await import(pathToFileURL(scriptPath).href);
    logger.debug(
      `Loaded ${SERVICE_SCRIPT_FILE} from ${agentsDir} for custom service registration.`,
    );
  } catch (e: unknown) {
    logger.warn(
      `Failed to load ${SERVICE_SCRIPT_FILE} from ${agentsDir}: ${toError(e).message}`,
    );
  }
}

function createFromFactories<T>(
  factories: ReadonlyMap<string, ServiceFactory<T>>,
  uri: string,
  options?: ServiceFactoryOptions,
): T | undefined {
  const scheme = parseUriScheme(uri);
  const factory = scheme === undefined ? undefined : factories.get(scheme);
  return factory?.(uri, options);
}

/** Returns the lower-cased scheme of `uri`, or `undefined` if it has none. */
export function parseUriScheme(uri: string): string | undefined {
  return URI_SCHEME_PATTERN.exec(uri)?.[1].toLowerCase();
}

/**
 * Splits `uri` the way Python's `urlparse` does, into the authority (`netloc`)
 * and the path that follows it. Unlike `new URL`, this never throws and never
 * invents a `/` path for an authority-only URI.
 */
function splitUriAuthority(uri: string): {authority: string; path: string} {
  const afterScheme = uri.slice(uri.indexOf(':') + 1).split(/[?#]/)[0];
  if (!afterScheme.startsWith(URI_AUTHORITY_PREFIX)) {
    return {authority: '', path: afterScheme};
  }
  const remainder = afterScheme.slice(URI_AUTHORITY_PREFIX.length);
  const slash = remainder.indexOf('/');
  return slash === -1
    ? {authority: remainder, path: ''}
    : {authority: remainder.slice(0, slash), path: remainder.slice(slash)};
}

function createInMemorySessionService(): BaseSessionService {
  return new InMemorySessionService();
}

function createDatabaseSessionService(uri: string): BaseSessionService {
  return new DatabaseSessionService(uri);
}

function createSqliteSessionService(uri: string): BaseSessionService {
  const {authority, path: dbPath} = splitUriAuthority(uri);
  if (!authority && !dbPath) {
    return createInMemorySessionService();
  }
  return new DatabaseSessionService(uri);
}

function createAgentEngineSessionService(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseSessionService {
  return new VertexAiSessionService(
    parseAgentEngineUri(uri, options?.agentsDir),
  );
}

function createInMemoryArtifactService(): BaseArtifactService {
  return new InMemoryArtifactService();
}

function createGcsArtifactService(uri: string): BaseArtifactService {
  return new GcsArtifactService(splitUriAuthority(uri).authority);
}

function createFileArtifactService(uri: string): BaseArtifactService {
  const {authority, path: filePath} = splitUriAuthority(uri);
  if (authority !== '' && authority !== 'localhost') {
    throw new Error(
      'file:// artifact URIs must reference the local filesystem.',
    );
  }
  if (!filePath) {
    throw new Error('file:// artifact URIs must include a path component.');
  }
  return new FileArtifactService(fileURLToPath(new URL(uri)));
}

function createInMemoryMemoryService(): BaseMemoryService {
  return new InMemoryMemoryService();
}

function createAgentEngineMemoryService(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseMemoryService {
  return new VertexAiMemoryBankService(
    parseAgentEngineUri(uri, options?.agentsDir),
  );
}

/** The Agent Engine coordinates a `agentengine://` URI names. */
interface AgentEngineTarget {
  projectId: string;
  location: string;
  agentEngineId: string;
}

const AGENT_ENGINE_RESOURCE_SEGMENTS = 6;

function parseAgentEngineUri(
  uri: string,
  agentsDir?: string,
): AgentEngineTarget {
  const {authority, path: resourcePath} = splitUriAuthority(uri);
  const resource = authority + resourcePath;
  if (!resource) {
    throw new Error(
      'Agent engine resource name or resource id cannot be empty.',
    );
  }

  if (!resource.includes('/')) {
    const {projectId, location} = loadGcpConfig(
      agentsDir,
      'short-form agent engine IDs',
    );
    return {projectId, location, agentEngineId: resource};
  }

  const parts = resource.split('/');
  if (
    parts.length !== AGENT_ENGINE_RESOURCE_SEGMENTS ||
    parts[0] !== 'projects' ||
    parts[2] !== 'locations' ||
    parts[4] !== 'reasoningEngines'
  ) {
    throw new Error(
      'Agent engine resource name is mal-formatted. It should be of format :' +
        ' projects/{project_id}/locations/{location}/reasoningEngines/{resource_id}',
    );
  }
  return {projectId: parts[1], location: parts[3], agentEngineId: parts[5]};
}

/** Reads the Google Cloud project and location for `serviceName`. */
function loadGcpConfig(
  agentsDir: string | undefined,
  serviceName: string,
): {projectId: string; location: string} {
  if (!agentsDir) {
    throw new Error(`agentsDir must be provided for ${serviceName}`);
  }
  dotenv.config({path: path.join(agentsDir, '.env'), quiet: true});

  const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
  const location = process.env['GOOGLE_CLOUD_LOCATION'];
  if (!projectId || !location) {
    throw new Error('GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_LOCATION not set.');
  }
  return {projectId, location};
}

async function registerServicesFromYamlConfig(
  config: unknown,
  registry: ServiceRegistry,
  agentsDir: string,
): Promise<void> {
  if (!isRecord(config) || !Array.isArray(config['services'])) {
    return;
  }

  for (const entry of config['services']) {
    const scheme = readStringField(entry, 'scheme');
    const serviceType = readStringField(entry, 'type');
    const classPath = readStringField(entry, 'class');
    if (!scheme || !serviceType || !classPath) {
      logger.warn(`Invalid service config in YAML: ${JSON.stringify(entry)}`);
      continue;
    }

    const constructor = await importServiceClass(classPath, agentsDir);
    registerDeclaredService(
      registry,
      serviceType,
      scheme,
      constructor,
      classPath,
    );
  }
}

function registerDeclaredService(
  registry: ServiceRegistry,
  serviceType: string,
  scheme: string,
  constructor: DeclaredServiceConstructor,
  classPath: string,
): void {
  switch (serviceType) {
    case 'session':
      registry.registerSessionService(
        scheme,
        declaredFactory(constructor, classPath, 'session', isSessionService),
      );
      break;
    case 'artifact':
      registry.registerArtifactService(
        scheme,
        declaredFactory(constructor, classPath, 'artifact', isArtifactService),
      );
      break;
    case 'memory':
      registry.registerMemoryService(
        scheme,
        declaredFactory(constructor, classPath, 'memory', isMemoryService),
      );
      break;
    default:
      logger.warn(`Unknown service type in YAML: ${serviceType}`);
  }
}

/**
 * Wraps a YAML-declared class in a factory that checks what it built.
 *
 * The class comes from a configuration file, so its shape is unverified until
 * it is constructed. Checking here turns a mis-declared `type` into an error
 * naming the class instead of a missing-method failure much later.
 */
function declaredFactory<T>(
  constructor: DeclaredServiceConstructor,
  classPath: string,
  serviceType: ServiceType,
  isService: (value: unknown) => value is T,
): ServiceFactory<T> {
  return (uri, options) => {
    const service = new constructor({uri, agentsDir: options?.agentsDir});
    if (!isService(service)) {
      throw new Error(
        `Class ${classPath} declared for service type '${serviceType}' does not implement it.`,
      );
    }
    return service;
  };
}

/**
 * Imports the class a `services.yaml` entry names.
 *
 * `classPath` is `<module specifier>#<export name>`; the export name defaults
 * to `default`. A relative specifier resolves against the agent directory, so
 * a Windows drive letter is never mistaken for a URL scheme.
 */
async function importServiceClass(
  classPath: string,
  agentsDir: string,
): Promise<DeclaredServiceConstructor> {
  const separator = classPath.indexOf('#');
  const specifier =
    separator === -1 ? classPath : classPath.slice(0, separator);
  const exportName =
    separator === -1 ? 'default' : classPath.slice(separator + 1);

  try {
    const imported: unknown = await import(
      resolveModuleSpecifier(specifier, agentsDir)
    );
    const exported = readProperty(imported, exportName);
    if (!isDeclaredServiceConstructor(exported)) {
      throw new Error(`export '${exportName}' is not a class`);
    }
    return exported;
  } catch (e: unknown) {
    throw new Error(
      `Could not import class ${classPath}: ${toError(e).message}`,
      {cause: e},
    );
  }
}

/**
 * Resolves the module specifier of a declared class.
 *
 * A configuration file may name code; it may not carry code. A built-in module
 * or a specifier with its own URL scheme (`data:`, `http:`) is therefore
 * refused rather than imported.
 */
function resolveModuleSpecifier(specifier: string, agentsDir: string): string {
  if (isRelativeOrAbsolutePath(specifier)) {
    return pathToFileURL(path.resolve(agentsDir, specifier)).href;
  }
  if (isBuiltin(specifier)) {
    throw new Error(`'${specifier}' is a Node built-in module`);
  }
  const scheme = parseUriScheme(specifier);
  if (scheme !== undefined) {
    throw new Error(`'${scheme}:' module specifiers are not allowed`);
  }
  return specifier;
}

function isRelativeOrAbsolutePath(specifier: string): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    path.isAbsolute(specifier)
  );
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readStringField(entry: unknown, field: string): string | undefined {
  const value = readProperty(entry, field);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeclaredServiceConstructor(
  value: unknown,
): value is DeclaredServiceConstructor {
  return typeof value === 'function' && 'prototype' in value;
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  return methods.every(
    (method) => typeof readProperty(value, method) === 'function',
  );
}

function isSessionService(value: unknown): value is BaseSessionService {
  return hasMethods(value, [
    'createSession',
    'getSession',
    'listSessions',
    'deleteSession',
    'appendEvent',
  ]);
}

function isArtifactService(value: unknown): value is BaseArtifactService {
  return hasMethods(value, [
    'saveArtifact',
    'loadArtifact',
    'listArtifactKeys',
    'deleteArtifact',
    'listVersions',
  ]);
}

function isMemoryService(value: unknown): value is BaseMemoryService {
  return hasMethods(value, ['addSessionToMemory', 'searchMemory']);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
