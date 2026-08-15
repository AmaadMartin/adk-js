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

/** Reads the registrations a `services` module exports, compiling it first. */
async function readRegistrations(
  filePath: string,
  fileOptions: AgentFileOptions,
): Promise<ServiceRegistrations | undefined> {
  const compiled =
    fileOptions.compile || fileOptions.bundle
      ? await compileFile(filePath, fileOptions)
      : undefined;

  try {
    const jsModule = await importFile(compiled?.compiledFilePath ?? filePath);

    return registrationCandidates(jsModule).find(isRegistrations);
  } finally {
    if (compiled) {
      await removeFolder(compiled.tempDirPath);
    }
  }
}

/**
 * Registers the service factories a `services.{ts,js,…}` module in an agent
 * directory exports, so `adk web`, `adk api_server` and `adk run` accept the
 * URI schemes those factories serve.
 *
 * A directory with no such module, or a module that fails to load, produces a
 * log line and no registration: starting the server with only the built-in
 * schemes is more useful than refusing to start.
 *
 * @param agentsPath The CLI's agents argument, a file or a directory.
 * @param fileOptions How to compile the module, matching the agent files.
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
      registry.registerArtifactService(
        scheme,
        factory as ArtifactServiceFactory,
      );
    }

    for (const [scheme, factory] of serviceFactories(
      'memory',
      registrations.memory,
    )) {
      registry.registerMemoryService(scheme, factory as MemoryServiceFactory);
    }
  } catch (e) {
    logger.warn(
      `Failed to load service registrations from ${agentsPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
