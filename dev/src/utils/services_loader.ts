/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ArtifactServiceFactory,
  getServiceRegistry,
  MemoryServiceFactory,
  ServiceRegistrations,
  SessionServiceFactory,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import * as path from 'node:path';

import {
  AgentFileOptions,
  compileFile,
  DEFAULT_AGENT_FILE_OPTIONS,
  importFile,
  JS_FILES_EXTENSIONS,
} from './agent_loader.js';
import {
  isFile,
  isFileExists,
  isFolderExists,
  removeFolder,
} from './file_utils.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({
  label: 'ServicesLoader',
  colorize: {all: true},
});

/** The module basename that declares a directory's service factories. */
const SERVICES_MODULE_NAME = 'services';

type UnknownFunction = (...args: unknown[]) => unknown;

/**
 * Only callability is checked. The user module is bundled separately and can
 * carry its own copy of `@google/adk`, so an `instanceof` check against the
 * service a factory returns would reject a legitimate backend.
 */
function isServiceFactory(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

const SERVICE_KINDS = ['session', 'artifact', 'memory'] as const;

type ServiceKind = (typeof SERVICE_KINDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A registrations object declares at least one of the three service kinds. */
function isRegistrations(value: unknown): value is ServiceRegistrations {
  return isRecord(value) && SERVICE_KINDS.some((kind) => isRecord(value[kind]));
}

/**
 * The export candidates, in precedence order. A CommonJS bundle nests the
 * module's exports under `default`, so each candidate is looked up there too.
 */
function registrationCandidates(jsModule: Record<string, unknown>): unknown[] {
  const asDefault = jsModule['default'];
  const nested = isRecord(asDefault) ? asDefault : {};

  return [
    jsModule[SERVICES_MODULE_NAME],
    nested[SERVICES_MODULE_NAME],
    asDefault,
    nested['default'],
  ];
}

/**
 * Yields the callable entries of one service kind and reports the rest, so one
 * malformed entry does not discard its valid siblings.
 */
function* serviceFactories(
  kind: string,
  entries: Record<string, unknown> | undefined,
): Generator<[string, UnknownFunction]> {
  for (const [scheme, value] of Object.entries(entries ?? {})) {
    if (isServiceFactory(value)) {
      yield [scheme, value];
    } else {
      logger.warn(
        `Invalid ${kind} service registration for '${scheme}': expected a function.`,
      );
    }
  }
}

/** Finds the `services` module in a directory, in extension precedence order. */
async function findServicesModule(dir: string): Promise<string | undefined> {
  for (const extension of JS_FILES_EXTENSIONS) {
    const candidate = path.join(dir, `${SERVICES_MODULE_NAME}${extension}`);

    if (await isFileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** Imports a JS/TS file, compiling it into a temporary directory first. */
async function importModuleFile(
  filePath: string,
  fileOptions: AgentFileOptions,
): Promise<Record<string, unknown>> {
  const compiled =
    fileOptions.compile || fileOptions.bundle
      ? await compileFile(filePath, fileOptions)
      : undefined;

  try {
    return await importFile(compiled?.compiledFilePath ?? filePath);
  } finally {
    if (compiled) {
      await removeFolder(compiled.tempDirPath);
    }
  }
}

/** Reads the registrations a `services` module exports, compiling it first. */
async function readRegistrations(
  filePath: string,
  fileOptions: AgentFileOptions,
): Promise<ServiceRegistrations | undefined> {
  const jsModule = await importModuleFile(filePath, fileOptions);

  return registrationCandidates(jsModule).find(isRegistrations);
}

/** The config files that declare service backends, in load order. */
const SERVICES_CONFIG_FILES = ['services.yaml', 'services.yml'];

/** TypeScript sources need compiling before Node can import them. */
const TS_FILES_EXTENSIONS = ['.ts', '.mts', '.cts'];

/** One `services:` entry of a `services.yaml` file. */
interface ServiceEntry {
  scheme: string;
  type: ServiceKind;
  module: string;
  class?: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isServiceKind(value: unknown): value is ServiceKind {
  return SERVICE_KINDS.some((kind) => kind === value);
}

function readString(
  entry: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = entry[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads one `services:` entry, reporting and dropping a malformed one. */
function readServiceEntry(
  value: unknown,
  source: string,
): ServiceEntry | undefined {
  const entry = isRecord(value) ? value : {};
  const scheme = readString(entry, 'scheme');
  const moduleSpecifier = readString(entry, 'module');
  const type = entry['type'];

  if (!scheme || !moduleSpecifier || !isServiceKind(type)) {
    logger.warn(
      `Skipping a service entry in ${source}: it needs a scheme, a module, ` +
        `and a type of ${SERVICE_KINDS.join(', ')}.`,
    );

    return undefined;
  }

  return {
    scheme,
    type,
    module: moduleSpecifier,
    class: readString(entry, 'class'),
  };
}

/**
 * Resolves a `module` key from the agent directory, so a relative path points
 * inside it and a package name comes from its own `node_modules`.
 */
function resolveServiceModule(specifier: string, dir: string): string {
  return createRequire(path.join(dir, 'package.json')).resolve(specifier);
}

/**
 * Reads one export of an imported module.
 *
 * A CommonJS module that builds its exports at run time defeats Node's static
 * export detection, so the class arrives only under `default`.
 *
 * Exported so a test can drive that shape directly. The test runner has its
 * own CommonJS interop, which copies the names back out and hides the case.
 */
export function readExport(
  jsModule: Record<string, unknown>,
  name: string,
): unknown {
  const asDefault = jsModule['default'];
  const nested = isRecord(asDefault) ? asDefault : {};

  return jsModule[name] ?? nested[name];
}

type ServiceConstructor<T> = new (uri: string) => T;

/**
 * Only constructability is checked, for the reason {@link isServiceFactory}
 * gives: the module can carry its own copy of `@google/adk`, so an
 * `instanceof` check would reject a legitimate backend.
 */
function isServiceConstructor<T>(
  value: unknown,
): value is ServiceConstructor<T> {
  return typeof value === 'function';
}

/** Registers `new Class(uri)` as the factory for one scheme. */
function registerConstructor<T>(
  register: (scheme: string, factory: (uri: string) => T) => void,
  entry: ServiceEntry,
  exported: unknown,
  source: string,
): void {
  if (!isServiceConstructor<T>(exported)) {
    logger.warn(
      `Skipping '${entry.scheme}' in ${source}: ${entry.module} exports no ` +
        `'${entry.class ?? 'default'}' class.`,
    );

    return;
  }

  register(entry.scheme, (uri) => new exported(uri));
}

/** Imports the module one entry names and registers its class. */
async function registerServiceEntry(
  entry: ServiceEntry,
  dir: string,
  source: string,
  fileOptions: AgentFileOptions,
): Promise<void> {
  const filePath = resolveServiceModule(entry.module, dir);
  const jsModule = TS_FILES_EXTENSIONS.includes(path.extname(filePath))
    ? await importModuleFile(filePath, fileOptions)
    : await importFile(filePath);
  const exported = readExport(jsModule, entry.class ?? 'default');
  const registry = getServiceRegistry();

  switch (entry.type) {
    case 'session':
      registerConstructor(
        registry.registerSessionService.bind(registry),
        entry,
        exported,
        source,
      );
      break;
    case 'artifact':
      registerConstructor(
        registry.registerArtifactService.bind(registry),
        entry,
        exported,
        source,
      );
      break;
    case 'memory':
      registerConstructor(
        registry.registerMemoryService.bind(registry),
        entry,
        exported,
        source,
      );
      break;
  }
}

/** Registers every entry of one config file, keeping the valid siblings. */
async function loadServicesConfig(
  filePath: string,
  dir: string,
  fileOptions: AgentFileOptions,
): Promise<void> {
  const document = yaml.load(await fs.readFile(filePath, 'utf8'));
  const services = isRecord(document) ? document['services'] : undefined;

  if (!Array.isArray(services)) {
    logger.warn(`${filePath} declares no 'services' list.`);
    return;
  }

  for (const value of services) {
    const entry = readServiceEntry(value, filePath);

    if (!entry) {
      continue;
    }

    try {
      await registerServiceEntry(entry, dir, filePath, fileOptions);
    } catch (e) {
      logger.warn(
        `Skipping '${entry.scheme}' in ${filePath}: ${errorMessage(e)}`,
      );
    }
  }
}

/**
 * Loads every config file the directory has.
 *
 * @returns False when a file could not be read or parsed, which stops the
 *     programmatic module from loading over a half-applied configuration.
 */
async function loadServicesConfigs(
  dir: string,
  fileOptions: AgentFileOptions,
): Promise<boolean> {
  for (const name of SERVICES_CONFIG_FILES) {
    const filePath = path.join(dir, name);

    if (!(await isFileExists(filePath))) {
      continue;
    }

    try {
      await loadServicesConfig(filePath, dir, fileOptions);
    } catch (e) {
      logger.warn(`Failed to read ${filePath}: ${errorMessage(e)}`);

      return false;
    }
  }

  return true;
}

/** Registers the factories a `services` module exports, when it has one. */
async function loadProgrammaticModule(
  dir: string,
  fileOptions: AgentFileOptions,
): Promise<void> {
  const filePath = await findServicesModule(dir);

  if (!filePath) {
    logger.debug(`No ${SERVICES_MODULE_NAME} module in ${dir}.`);
    return;
  }

  const registrations = await readRegistrations(filePath, fileOptions);

  if (!registrations) {
    logger.warn(
      `${filePath} exports no '${SERVICES_MODULE_NAME}' or default registrations object.`,
    );
    return;
  }

  const registry = getServiceRegistry();

  for (const [scheme, factory] of serviceFactories(
    'session',
    registrations.session,
  )) {
    registry.registerSessionService(scheme, factory as SessionServiceFactory);
  }

  for (const [scheme, factory] of serviceFactories(
    'artifact',
    registrations.artifact,
  )) {
    registry.registerArtifactService(scheme, factory as ArtifactServiceFactory);
  }

  for (const [scheme, factory] of serviceFactories(
    'memory',
    registrations.memory,
  )) {
    registry.registerMemoryService(scheme, factory as MemoryServiceFactory);
  }
}

/**
 * Registers the service backends an agent directory declares, so `adk web`,
 * `adk api_server` and `adk run` accept the URI schemes those backends serve.
 *
 * Two forms are read, in this order, and a later registration replaces an
 * earlier one for the same scheme and kind:
 *
 * 1. `services.yaml` and then `services.yml`, each a `services:` list of
 *    `{scheme, type, module, class}` entries. `type` is `session`, `artifact`
 *    or `memory`. `module` is a path relative to the directory, or a package
 *    name resolved from the directory's `node_modules`. `class` names the
 *    export to construct and defaults to the default export. ADK constructs it
 *    as `new Class(uri)`.
 * 2. A `services.{ts,js,mjs,cjs}` module exporting a {@link ServiceRegistrations}
 *    object.
 *
 * This is where adk-js and adk-python differ. Python writes one dotted `class`
 * key, `my_pkg.my_module.MyService`, which has no JavaScript meaning, so the
 * module specifier and the export name are two keys here.
 *
 * Both forms run code from the agent directory at start-up, which is the trust
 * level the CLI already grants the agent file itself. Neither is sandboxed.
 *
 * A directory with no such file, or a file that fails to load, produces a log
 * line and no registration: starting the server with only the built-in schemes
 * is more useful than refusing to start.
 *
 * @param agentsPath The CLI's agents argument, a file or a directory.
 * @param fileOptions How to compile a module, matching the agent files.
 */
export async function loadServicesModule(
  agentsPath: string,
  fileOptions: AgentFileOptions = DEFAULT_AGENT_FILE_OPTIONS,
): Promise<void> {
  try {
    const dir = (await isFile(agentsPath))
      ? path.dirname(agentsPath)
      : agentsPath;

    if (!(await isFolderExists(dir))) {
      logger.debug(`No agent directory at ${dir}, skipping service discovery.`);
      return;
    }

    if (await loadServicesConfigs(dir, fileOptions)) {
      await loadProgrammaticModule(dir, fileOptions);
    }
  } catch (e) {
    logger.warn(
      `Failed to load service registrations from ${agentsPath}: ${errorMessage(
        e,
      )}`,
    );
  }
}
