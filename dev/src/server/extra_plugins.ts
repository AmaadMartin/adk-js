/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, Logger} from '@google/adk';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';

/**
 * Callbacks every plugin carries. They stand in for an `instanceof
 * BasePlugin` check, which an operator's plugin module can fail when it
 * resolves its own copy of `@google/adk`.
 */
const PLUGIN_CALLBACKS = [
  'beforeRunCallback',
  'afterRunCallback',
  'onEventCallback',
] as const;

/** A plugin class, constructed with the qualified name it was named by. */
type PluginConstructor = new (name: string) => BasePlugin;

/**
 * Imports the plugins an operator named on the command line and returns the
 * ones that loaded.
 *
 * Each name is `<module>.<export>`, split on the last `.` — `./plugins/audit`
 * plus `AuditPlugin` for `./plugins/audit.AuditPlugin`. A relative or absolute
 * module is resolved against the working directory; anything else is passed to
 * `import()` as a package specifier. An export that is a plugin class is
 * constructed with its qualified name, and one that is already a plugin
 * instance is used as it is.
 *
 * A name that fails to load is logged and skipped, so one bad plugin stops
 * neither the others nor the server.
 *
 * This runs code the operator named. The names must come from server
 * configuration only, never from a request.
 *
 * @param qualifiedNames The `<module>.<export>` names to load.
 * @param logger The server logger.
 */
export async function loadExtraPlugins(
  qualifiedNames: string[],
  logger: Logger,
): Promise<BasePlugin[]> {
  const plugins: BasePlugin[] = [];
  for (const qualifiedName of qualifiedNames) {
    try {
      plugins.push(await loadPlugin(qualifiedName));
    } catch (e: unknown) {
      logger.error(`Failed to load plugin ${qualifiedName}: ${e}`);
    }
  }
  return plugins;
}

async function loadPlugin(qualifiedName: string): Promise<BasePlugin> {
  const separator = qualifiedName.lastIndexOf('.');
  if (separator <= 0) {
    throw new Error(
      'expected a "<module>.<export>" name, e.g. "./plugins/audit.AuditPlugin"',
    );
  }

  const exportName = qualifiedName.slice(separator + 1);
  const module: unknown = await import(
    toModuleSpecifier(qualifiedName.slice(0, separator))
  );
  const exported = readExport(module, exportName);

  if (isPlugin(exported)) {
    return exported;
  }
  if (isPluginConstructor(exported)) {
    return new exported(qualifiedName);
  }
  throw new Error(`${exportName} is not a plugin`);
}

/**
 * A relative or absolute module is resolved against the working directory the
 * server was started in, not against this file, which is where a bare
 * `import()` would look for it.
 */
function toModuleSpecifier(module: string): string {
  if (module.startsWith('.') || path.isAbsolute(module)) {
    return pathToFileURL(path.resolve(process.cwd(), module)).href;
  }
  return module;
}

function readExport(module: unknown, exportName: string): unknown {
  if (!isRecord(module) || !(exportName in module)) {
    throw new Error(`${exportName} is not exported by the module`);
  }
  return module[exportName];
}

function hasPluginCallbacks(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    PLUGIN_CALLBACKS.every((callback) => typeof value[callback] === 'function')
  );
}

function isPlugin(value: unknown): value is BasePlugin {
  return hasPluginCallbacks(value) && typeof value['name'] === 'string';
}

function isPluginConstructor(value: unknown): value is PluginConstructor {
  return typeof value === 'function' && hasPluginCallbacks(value.prototype);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
