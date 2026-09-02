/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom session and artifact backends declared in an agent directory.
 *
 * `adk run` resolves `--session_service_uri` and `--artifact_service_uri`
 * against a fixed set of built-in schemes. To serve another scheme, put one of
 * two files beside the agent.
 *
 * `services.yaml` (or `services.yml`) names a module and the export to
 * construct with the URI:
 *
 * ```yaml
 * services:
 *   - scheme: mysession
 *     type: session
 *     module: ./my_session_service.js
 *     export: MyCustomSessionService
 * ```
 *
 * `services.ts` (or `.js`, `.mjs`, `.cjs`) exports the registrations, for a
 * backend that needs more than a constructor call:
 *
 * ```ts
 * export const services = [
 *   {scheme: 'mysession', type: 'session', create: (uri) => new MyService(uri)},
 * ];
 * ```
 *
 * adk-python's `services.py` mutates a registry singleton instead. A compiled
 * or bundled module can hold a second copy of this package, whose singleton
 * nothing reads, so the JS spelling exports a list.
 */

import {BaseArtifactService, BaseSessionService} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {isFileExists, isFolderExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {importUserModule} from '../utils/module_loader.js';
import {asNonEmptyString, isRecord} from '../utils/value_utils.js';

const logger = new AdkLogger({
  label: 'ServiceRegistry',
  colorize: {all: true},
});

const YAML_FILE_NAMES = ['services.yaml', 'services.yml'];
const MODULE_FILE_NAMES = [
  'services.ts',
  'services.js',
  'services.mjs',
  'services.cjs',
];

const SERVICE_KINDS = ['session', 'artifact'] as const;

const URI_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

const SESSION_SERVICE_METHODS = [
  'createSession',
  'getSession',
  'listSessions',
  'deleteSession',
];
const ARTIFACT_SERVICE_METHODS = [
  'saveArtifact',
  'loadArtifact',
  'listArtifactKeys',
  'deleteArtifact',
];

/** The kinds of service `adk run` builds from a URI. */
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** A custom session backend, serving one URI scheme. */
export interface SessionServiceRegistration {
  scheme: string;
  type: 'session';
  create: (uri: string) => BaseSessionService;
}

/** A custom artifact backend, serving one URI scheme. */
export interface ArtifactServiceRegistration {
  scheme: string;
  type: 'artifact';
  create: (uri: string) => BaseArtifactService;
}

/** One custom backend, keyed by URI scheme. */
export type ServiceRegistration =
  | SessionServiceRegistration
  | ArtifactServiceRegistration;

/** The custom backends a run can resolve a service URI against. */
export class ServiceRegistry {
  private readonly sessionFactories = new Map<
    string,
    SessionServiceRegistration['create']
  >();
  private readonly artifactFactories = new Map<
    string,
    ArtifactServiceRegistration['create']
  >();

  /** Adds a backend, replacing any backend already serving its scheme. */
  register(registration: ServiceRegistration): void {
    if (registration.type === 'session') {
      this.sessionFactories.set(registration.scheme, registration.create);
    } else {
      this.artifactFactories.set(registration.scheme, registration.create);
    }
  }

  /** The custom session service for `uri`, or undefined for a scheme nobody registered. */
  createSessionService(uri: string): BaseSessionService | undefined {
    return this.sessionFactories.get(schemeOf(uri))?.(uri);
  }

  /** The custom artifact service for `uri`, or undefined for a scheme nobody registered. */
  createArtifactService(uri: string): BaseArtifactService | undefined {
    return this.artifactFactories.get(schemeOf(uri))?.(uri);
  }
}

let sharedRegistry: ServiceRegistry | undefined;

/** The registry the CLI resolves its service URIs against. */
export function getServiceRegistry(): ServiceRegistry {
  return (sharedRegistry ??= new ServiceRegistry());
}

/**
 * Registers the custom services an agent directory declares.
 *
 * This never throws. A declaration the CLI cannot use is logged and skipped, so
 * a broken services file cannot stop an agent that does not depend on it.
 *
 * @param agentRoot Directory holding the agent.
 * @param registry Registry to add to. Defaults to the process-wide one.
 */
export async function loadServicesModule(
  agentRoot: string,
  registry: ServiceRegistry = getServiceRegistry(),
): Promise<void> {
  if (!(await isFolderExists(agentRoot))) {
    logger.debug(`${agentRoot} is not a directory, skipping service loading.`);
    return;
  }

  const yamlPath = await findFirstFile(agentRoot, YAML_FILE_NAMES);
  // A YAML file the CLI cannot read stops the load, as adk-python does: the
  // module may expect the schemes the YAML file was meant to register.
  if (yamlPath && !(await registerFromYaml(yamlPath, registry))) {
    return;
  }

  const modulePath = await findFirstFile(agentRoot, MODULE_FILE_NAMES);
  if (modulePath) {
    await registerFromModule(modulePath, registry);
  }
}

/** The scheme of a URI, or the empty string when it has none. */
function schemeOf(uri: string): string {
  return URI_SCHEME_PATTERN.exec(uri)?.[1] ?? '';
}

async function findFirstFile(
  dir: string,
  names: string[],
): Promise<string | undefined> {
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (await isFileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** @return Whether the file was read. */
async function registerFromYaml(
  filePath: string,
  registry: ServiceRegistry,
): Promise<boolean> {
  let config: unknown;
  try {
    config = yaml.load(await fs.readFile(filePath, 'utf-8'));
  } catch (error: unknown) {
    logger.warn(`Failed to load ${filePath}: ${describeError(error)}`);
    return false;
  }

  for (const entry of readYamlEntries(config)) {
    await registerYamlEntry(entry, path.dirname(filePath), registry);
  }
  return true;
}

function readYamlEntries(config: unknown): unknown[] {
  if (!isRecord(config) || !Array.isArray(config['services'])) {
    return [];
  }
  return config['services'];
}

async function registerYamlEntry(
  entry: unknown,
  agentRoot: string,
  registry: ServiceRegistry,
): Promise<void> {
  const description = JSON.stringify(entry);
  if (!isRecord(entry)) {
    logger.warn(`Invalid service entry: ${description}`);
    return;
  }

  const scheme = asNonEmptyString(entry['scheme']);
  const modulePath = asNonEmptyString(entry['module']);
  if (!scheme || !modulePath) {
    logger.warn(`Invalid service entry: ${description}`);
    return;
  }

  const kind = entry['type'];
  if (!isServiceKind(kind)) {
    logger.warn(`Unknown service type in ${description}`);
    return;
  }

  const exportName = asNonEmptyString(entry['export']) ?? 'default';
  const source = path.resolve(agentRoot, modulePath);

  let exported: unknown;
  try {
    exported = (await importUserModule(source))[exportName];
  } catch (error: unknown) {
    logger.warn(`Failed to load ${source}: ${describeError(error)}`);
    return;
  }

  if (!isServiceConstructor(exported)) {
    logger.warn(`${source} exports no constructor named "${exportName}".`);
    return;
  }

  registry.register(buildRegistration(scheme, kind, exported, source));
}

async function registerFromModule(
  filePath: string,
  registry: ServiceRegistry,
): Promise<void> {
  let exported: unknown;
  try {
    const exports = await importUserModule(filePath);
    exported = exports['services'] ?? exports['default'];
  } catch (error: unknown) {
    logger.warn(`Failed to load ${filePath}: ${describeError(error)}`);
    return;
  }

  if (!Array.isArray(exported)) {
    logger.warn(`${filePath} exports no "services" array.`);
    return;
  }

  for (const entry of exported) {
    if (isServiceRegistration(entry)) {
      registry.register(entry);
    } else {
      logger.warn(
        `Invalid service registration in ${filePath}: ${JSON.stringify(entry)}`,
      );
    }
  }
}

/** A class named by a YAML entry, constructed with the URI it serves. */
type ServiceConstructor = new (uri: string) => unknown;

function buildRegistration(
  scheme: string,
  kind: ServiceKind,
  constructor: ServiceConstructor,
  source: string,
): ServiceRegistration {
  if (kind === 'session') {
    return {
      scheme,
      type: kind,
      create: (uri) => requireSessionService(new constructor(uri), source),
    };
  }
  return {
    scheme,
    type: kind,
    create: (uri) => requireArtifactService(new constructor(uri), source),
  };
}

function requireSessionService(
  value: unknown,
  source: string,
): BaseSessionService {
  if (!isSessionService(value)) {
    throw new Error(`${source} did not produce a session service.`);
  }
  return value;
}

function requireArtifactService(
  value: unknown,
  source: string,
): BaseArtifactService {
  if (!isArtifactService(value)) {
    throw new Error(`${source} did not produce an artifact service.`);
  }
  return value;
}

/**
 * Whether `value` implements the named methods.
 *
 * A structural check, not `instanceof`: a user who has a second copy of
 * `@google/adk` in their project still gets a service the CLI accepts.
 */
function hasMethods(value: unknown, methods: string[]): boolean {
  return (
    isRecord(value) &&
    methods.every((method) => typeof value[method] === 'function')
  );
}

function isSessionService(value: unknown): value is BaseSessionService {
  return hasMethods(value, SESSION_SERVICE_METHODS);
}

function isArtifactService(value: unknown): value is BaseArtifactService {
  return hasMethods(value, ARTIFACT_SERVICE_METHODS);
}

function isServiceConstructor(value: unknown): value is ServiceConstructor {
  return typeof value === 'function';
}

function isServiceKind(value: unknown): value is ServiceKind {
  return SERVICE_KINDS.some((kind) => kind === value);
}

function isServiceRegistration(value: unknown): value is ServiceRegistration {
  return (
    isRecord(value) &&
    !!asNonEmptyString(value['scheme']) &&
    isServiceKind(value['type']) &&
    typeof value['create'] === 'function'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
