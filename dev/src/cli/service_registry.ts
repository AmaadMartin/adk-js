/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADK service registry.
 *
 * The registry maps a URI scheme to a factory that builds a session, artifact
 * or memory service. ADK seeds it with the backends it ships with. You can
 * add a scheme of your own in two ways.
 *
 * 1. Declare it in `services.yaml` (or `services.yml`) next to your agent:
 *
 * ```yaml
 * services:
 *   - scheme: mysession
 *     type: session
 *     class: '@acme/adk-redis#RedisSessionService'
 * ```
 *
 * 2. Register it in `services.ts` (or `.js`, `.mjs`, `.cjs`) next to your
 *    agent, when the backend needs more than `new MyService({uri})`:
 *
 * ```ts
 * import {getServiceRegistry} from '@google/adk-devtools';
 * import {MySessionService} from './my_session_service.js';
 *
 * getServiceRegistry().registerSessionService(
 *   'mysession',
 *   (uri) => new MySessionService(new URL(uri).host),
 * );
 * ```
 *
 * Both files may be present. The YAML file is processed first, then the
 * script, so a scheme declared in both ends up bound to the factory the script
 * registers.
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
import {importModuleFile} from '../utils/module_utils.js';

const logger = new AdkLogger({label: 'ADK Service Registry'});

/** The YAML files a services declaration may live in, in load order. */
const SERVICE_YAML_FILES = ['services.yaml', 'services.yml'] as const;

/**
 * The script that registers services imperatively, in the order ADK looks for
 * it. The first one present is loaded and the rest are ignored.
 */
const SERVICE_SCRIPT_FILES = [
  'services.ts',
  'services.js',
  'services.mjs',
  'services.cjs',
] as const;

/** Matches the scheme of a URI, e.g. `postgresql+asyncpg` in `...://host`. */
const URI_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):/;

const URI_AUTHORITY_PREFIX = '//';

/**
 * The schemes `DatabaseSessionService` accepts, minus `sqlite` which has its
 * own factory.
 *
 * adk-python registers `postgresql` and `mysql` only. adk-js keeps the list
 * aligned with `isDatabaseConnectionString` in `@google/adk`, so the registry
 * never turns down a connection string the session service can open.
 */
const DATABASE_SESSION_SCHEMES = [
  'postgresql',
  'postgres',
  'mysql',
  'mariadb',
  'mssql',
] as const;

/**
 * Everything a factory receives besides the URI.
 *
 * adk-python passes these as `**kwargs`. adk-js constructors take typed option
 * objects, so this carries the one option a factory can act on.
 */
export interface ServiceFactoryOptions {
  /**
   * The agent directory. Factories that need a Google Cloud project and
   * location read `<agentsDir>/.env` before the ambient environment.
   */
  agentsDir?: string;
}

/**
 * Builds one service from the URI that named it.
 *
 * A factory may be asynchronous. Opening a connection or resolving a driver
 * needs an `await`, so every `create*` on the registry returns a promise.
 * adk-python builds its services synchronously.
 */
export type ServiceFactory<T> = (
  uri: string,
  options?: ServiceFactoryOptions,
) => T | Promise<T>;

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
   * Builds the session service for `uri`, or resolves `undefined` when no
   * factory claims its scheme so the caller can fall back.
   */
  createSessionService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): Promise<BaseSessionService | undefined> {
    return createFromFactories(this.sessionFactories, uri, options);
  }

  /** Builds the artifact service for `uri`, or resolves `undefined`. */
  createArtifactService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): Promise<BaseArtifactService | undefined> {
    return createFromFactories(this.artifactFactories, uri, options);
  }

  /** Builds the memory service for `uri`, or resolves `undefined`. */
  createMemoryService(
    uri: string,
    options?: ServiceFactoryOptions,
  ): Promise<BaseMemoryService | undefined> {
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
  registry.registerSessionService('memory', () => new InMemorySessionService());
  registry.registerSessionService('sqlite', createSqliteSessionService);
  for (const scheme of DATABASE_SESSION_SCHEMES) {
    registry.registerSessionService(scheme, createDatabaseSessionService);
  }
  registry.registerSessionService(
    'agentengine',
    createAgentEngineSessionService,
  );

  registry.registerArtifactService(
    'memory',
    () => new InMemoryArtifactService(),
  );
  registry.registerArtifactService('gs', createGcsArtifactService);
  registry.registerArtifactService('file', createFileArtifactService);

  registry.registerMemoryService('memory', () => new InMemoryMemoryService());
  registry.registerMemoryService('rag', createRagMemoryService);
  registry.registerMemoryService('agentengine', createAgentEngineMemoryService);
}

/**
 * Registers the services declared beside the agent in `agentsDir`.
 *
 * Reads `services.yaml`/`services.yml` first, then executes the first of
 * `services.ts`, `services.js`, `services.mjs` and `services.cjs` that is
 * present. A YAML file that fails to load stops the whole load, so a
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

  const scriptFile = await findServiceScript(agentsDir);
  if (!scriptFile) {
    logger.debug(
      `None of ${SERVICE_SCRIPT_FILES.join(', ')} found in ${agentsDir}, skipping.`,
    );
    return;
  }
  try {
    await importModuleFile(path.join(agentsDir, scriptFile));
    logger.debug(
      `Loaded ${scriptFile} from ${agentsDir} for custom service registration.`,
    );
  } catch (e: unknown) {
    logger.warn(
      `Failed to load ${scriptFile} from ${agentsDir}: ${toError(e).message}`,
    );
  }
}

/** Returns the first services script present in `agentsDir`. */
async function findServiceScript(
  agentsDir: string,
): Promise<string | undefined> {
  for (const scriptFile of SERVICE_SCRIPT_FILES) {
    if (await isFileExists(path.join(agentsDir, scriptFile))) {
      return scriptFile;
    }
  }
  return undefined;
}

async function createFromFactories<T>(
  factories: ReadonlyMap<string, ServiceFactory<T>>,
  uri: string,
  options?: ServiceFactoryOptions,
): Promise<T | undefined> {
  const scheme = parseUriScheme(uri);
  const factory = scheme === undefined ? undefined : factories.get(scheme);
  return factory?.(uri, options);
}

/** Returns the lower-cased scheme of `uri`, or `undefined` if it has none. */
function parseUriScheme(uri: string): string | undefined {
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

function createDatabaseSessionService(uri: string): BaseSessionService {
  return new DatabaseSessionService(uri);
}

function createSqliteSessionService(uri: string): BaseSessionService {
  const {authority, path: dbPath} = splitUriAuthority(uri);
  if (!authority && !dbPath) {
    return new InMemorySessionService();
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

function createAgentEngineMemoryService(
  uri: string,
  options?: ServiceFactoryOptions,
): BaseMemoryService {
  return new VertexAiMemoryBankService(
    parseAgentEngineUri(uri, options?.agentsDir),
  );
}

/** The options the Vertex AI RAG memory service is constructed with. */
interface RagMemoryServiceOptions {
  /** `projects/{project}/locations/{location}/ragCorpora/{corpus}`. */
  ragCorpus: string;
}

async function createRagMemoryService(
  uri: string,
  options?: ServiceFactoryOptions,
): Promise<BaseMemoryService> {
  const corpus = splitUriAuthority(uri).authority;
  if (!corpus) {
    throw new Error('Rag corpus can not be empty.');
  }
  const {projectId, location} = loadGcpConfig(
    options?.agentsDir,
    'RAG memory service',
  );
  const constructor = await resolveRagMemoryService();
  const service = new constructor({
    ragCorpus: `projects/${projectId}/locations/${location}/ragCorpora/${corpus}`,
  });
  if (!isMemoryService(service)) {
    throw new Error(
      'VertexAiRagMemoryService exported by @google/adk is not a memory service.',
    );
  }
  return service;
}

/**
 * Reads `VertexAiRagMemoryService` out of `@google/adk` at call time.
 *
 * The class is not in `@google/adk` 2.0.0, so a static import does not compile
 * against the version `dev` depends on, and `rag://` has to look it up by name
 * on the call that needs it. An installation without it gets an error naming
 * the scheme to use instead.
 */
async function resolveRagMemoryService(): Promise<
  new (options: RagMemoryServiceOptions) => unknown
> {
  const adk: unknown = await import('@google/adk');
  const exported = readProperty(adk, 'VertexAiRagMemoryService');
  if (!isConstructorOf<RagMemoryServiceOptions>(exported)) {
    throw new Error(
      'rag:// needs VertexAiRagMemoryService, which the installed @google/adk' +
        ' does not export. Use agentengine:// for Agent Engine memory instead.',
    );
  }
  return exported;
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
    if (!isConstructorOf<DeclaredServiceOptions>(exported)) {
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

function isConstructorOf<T>(
  value: unknown,
): value is new (options: T) => unknown {
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
