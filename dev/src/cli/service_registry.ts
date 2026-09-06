/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A registry of custom session, artifact and memory backends, keyed by URI
 * scheme.
 *
 * `@google/adk` resolves the built-in schemes itself (`memory://`, a database
 * URL, `gs://`, `file://`). This registry holds the schemes a user adds, and
 * the CLI consults it first, so a registration overrides a built-in.
 *
 * There are two ways to register a backend, both read from the agent's own
 * directory.
 *
 * 1. `services.yaml` (or `services.yml`), when the class can be built from the
 *    URI alone:
 *
 * ```yaml
 * services:
 *   - scheme: redis
 *     type: session
 *     class: '@acme/adk-redis#RedisSessionService'
 * ```
 *
 * 2. `services.ts` (or `.js`, `.mjs`, `.cjs`), for anything the constructor
 *    needs beyond the URI:
 *
 * ```ts
 * import {getServiceRegistry} from '@google/adk-devtools';
 * import {RedisSessionService} from './redis_session_service.js';
 *
 * getServiceRegistry().registerSessionService(
 *   'redis',
 *   (uri) => new RedisSessionService({url: uri, poolSize: 8}),
 * );
 * ```
 *
 * Both files may be present. The YAML is read first, so the script wins for a
 * scheme that appears in both.
 */

import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';

import {isFileExists, isFolderExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {importModuleFile} from '../utils/module_utils.js';

const logger = new AdkLogger({label: 'ServiceRegistry', colorize: {all: true}});

/** Builds one service from the URI that named it. */
export type ServiceFactory<T> = (uri: string) => T | Promise<T>;

/** The service kinds a `services.yaml` entry can declare. */
export type ServiceKind = 'session' | 'artifact' | 'memory';

/** The file names read from the agent directory, in the order they apply. */
const YAML_FILE_NAMES = ['services.yaml', 'services.yml'];
const SCRIPT_FILE_NAMES = [
  'services.ts',
  'services.mts',
  'services.cts',
  'services.js',
  'services.mjs',
  'services.cjs',
];

/** Separates the module specifier from the export name in a `class` field. */
const EXPORT_NAME_SEPARATOR = '#';

/** RFC 3986 scheme: a letter, then letters, digits, `+`, `-` or `.`. */
const URI_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** The kinds a `type` field may name. A2A task stores are not among them. */
const SERVICE_KINDS = new Set<string>(['session', 'artifact', 'memory']);

const SERVICE_ENTRY_SCHEMA = z.object({
  scheme: z.string().min(1),
  type: z.string().min(1),
  class: z.string().min(1),
});

const SERVICES_DOCUMENT_SCHEMA = z.object({services: z.array(z.unknown())});

function isServiceKind(value: string): value is ServiceKind {
  return SERVICE_KINDS.has(value);
}

function parseUriScheme(uri: string): string | undefined {
  return URI_SCHEME_PATTERN.exec(uri)?.[1];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFromUri<T>(
  factories: Map<string, ServiceFactory<T>>,
  uri: string,
): Promise<T> | undefined {
  const scheme = parseUriScheme(uri);
  const factory = scheme ? factories.get(scheme) : undefined;
  return factory ? Promise.resolve(factory(uri)) : undefined;
}

/** Maps a URI scheme to the backend that serves it, per service kind. */
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

  /** Registering a scheme a second time replaces the first factory. */
  registerSessionService(
    scheme: string,
    factory: ServiceFactory<BaseSessionService>,
  ): void {
    this.sessionFactories.set(scheme, factory);
  }

  registerArtifactService(
    scheme: string,
    factory: ServiceFactory<BaseArtifactService>,
  ): void {
    this.artifactFactories.set(scheme, factory);
  }

  registerMemoryService(
    scheme: string,
    factory: ServiceFactory<BaseMemoryService>,
  ): void {
    this.memoryFactories.set(scheme, factory);
  }

  /** Resolves undefined when no factory claims the scheme of the URI. */
  async createSessionService(
    uri: string,
  ): Promise<BaseSessionService | undefined> {
    return createFromUri(this.sessionFactories, uri);
  }

  async createArtifactService(
    uri: string,
  ): Promise<BaseArtifactService | undefined> {
    return createFromUri(this.artifactFactories, uri);
  }

  async createMemoryService(
    uri: string,
  ): Promise<BaseMemoryService | undefined> {
    return createFromUri(this.memoryFactories, uri);
  }
}

let registry: ServiceRegistry | undefined;

/** Returns the one registry of the process. */
export function getServiceRegistry(): ServiceRegistry {
  registry ??= new ServiceRegistry();
  return registry;
}

/** Resolves a relative specifier against the directory that declared it. */
function toModuleSpecifier(declared: string, dir: string): string {
  return declared.startsWith('.')
    ? pathToFileURL(path.resolve(dir, declared)).href
    : declared;
}

/**
 * Imports the class a `class` field names and returns a factory for it.
 *
 * The import happens now rather than on first use, so a specifier that cannot
 * be resolved is reported while the YAML is read.
 */
async function createFactoryFromClassPath<T>(
  declared: string,
  dir: string,
): Promise<ServiceFactory<T>> {
  const [specifier, exportName] = declared.split(EXPORT_NAME_SEPARATOR);
  const module: Record<string, unknown> = await import(
    toModuleSpecifier(specifier, dir)
  );
  const exported = module[exportName ?? 'default'];
  if (typeof exported !== 'function') {
    throw new Error(
      `${declared} does not name a constructor exported by ${specifier}`,
    );
  }
  const constructor = exported as new (options: {uri: string}) => T;
  return (uri: string) => new constructor({uri});
}

async function registerEntry(
  entry: unknown,
  dir: string,
  target: ServiceRegistry,
): Promise<void> {
  const parsed = SERVICE_ENTRY_SCHEMA.safeParse(entry);
  if (!parsed.success) {
    logger.warn(`Invalid service config in YAML: ${JSON.stringify(entry)}`);
    return;
  }

  const {scheme, type, class: classPath} = parsed.data;
  if (!isServiceKind(type)) {
    logger.warn(`Unknown service type in YAML: ${type}`);
    return;
  }

  switch (type) {
    case 'session':
      target.registerSessionService(
        scheme,
        await createFactoryFromClassPath(classPath, dir),
      );
      return;
    case 'artifact':
      target.registerArtifactService(
        scheme,
        await createFactoryFromClassPath(classPath, dir),
      );
      return;
    case 'memory':
      target.registerMemoryService(
        scheme,
        await createFactoryFromClassPath(classPath, dir),
      );
      return;
  }
}

/**
 * Applies one `services.yaml` document.
 *
 * An entry that does not declare all three fields, or declares a kind this
 * registry does not serve, is reported and skipped. Everything else - an
 * unreadable document, a class that cannot be imported - throws, because the
 * caller must then leave the script alone.
 */
async function registerServicesFromYaml(
  document: unknown,
  dir: string,
  target: ServiceRegistry,
): Promise<void> {
  const parsed = SERVICES_DOCUMENT_SCHEMA.safeParse(document);
  if (!parsed.success) {
    logger.debug(`No services list declared in ${dir}.`);
    return;
  }

  for (const entry of parsed.data.services) {
    await registerEntry(entry, dir, target);
  }
}

/** Returns false when a YAML file was found but could not be applied. */
async function loadServicesYaml(dir: string): Promise<boolean> {
  for (const fileName of YAML_FILE_NAMES) {
    const filePath = path.join(dir, fileName);
    if (!(await isFileExists(filePath))) {
      continue;
    }
    try {
      const document = yaml.load(await fs.readFile(filePath, 'utf-8'));
      await registerServicesFromYaml(document, dir, getServiceRegistry());
      logger.debug(`Loaded custom services from ${filePath}.`);
    } catch (error: unknown) {
      logger.warn(`Failed to load ${filePath}: ${describeError(error)}`);
      return false;
    }
  }
  return true;
}

async function loadServicesScript(dir: string): Promise<void> {
  for (const fileName of SCRIPT_FILE_NAMES) {
    const filePath = path.join(dir, fileName);
    if (!(await isFileExists(filePath))) {
      continue;
    }
    try {
      await importModuleFile(filePath);
      logger.debug(`Loaded custom services from ${filePath}.`);
    } catch (error: unknown) {
      logger.warn(`Failed to load ${filePath}: ${describeError(error)}`);
    }
    return;
  }
  logger.debug(`No services script in ${dir}, skipping.`);
}

/**
 * Registers the backends declared in a directory, if it declares any.
 *
 * The script is imported for its side effects, so it runs whatever code the
 * user put in it. That is the point of the extension, and the file comes from
 * the user's own agent directory.
 *
 * @param dir The directory holding the agent, searched for `services.yaml`,
 *     `services.yml` and a `services` script.
 */
export async function loadServicesModule(dir: string): Promise<void> {
  if (!(await isFolderExists(dir))) {
    logger.debug(`No services loaded: ${dir} is not a directory.`);
    return;
  }
  // A YAML file that fails leaves the registry half-built, so the script does
  // not run on top of it.
  if (await loadServicesYaml(dir)) {
    await loadServicesScript(dir);
  }
}
