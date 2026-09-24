/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, Logger} from '@google/adk';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isRecord} from '../utils/type_utils.js';

/** Export read from a module when the specifier names none. */
const DEFAULT_EXPORT_NAME = 'default';

/** A plugin specifier split into the module to load and the export to read. */
export interface PluginSpecifier {
  moduleSpecifier: string;
  /** Export to read. `undefined` selects the module's default export. */
  exportName?: string;
}

/**
 * Splits a `<module>#<export>` plugin specifier into its two halves.
 *
 * The separator is the last `#`, so a module specifier that contains one of
 * its own still resolves. adk-python splits on the last dot instead, which is
 * unusable here: `./plugin.js` would split into `./plugin` and `js`.
 */
export function parsePluginSpecifier(spec: string): PluginSpecifier {
  const separator = spec.lastIndexOf('#');
  if (separator === -1) {
    return {moduleSpecifier: spec};
  }

  return {
    moduleSpecifier: spec.slice(0, separator),
    exportName: spec.slice(separator + 1),
  };
}

/**
 * Turns a module specifier into something `import()` accepts. A relative or
 * absolute path is resolved against `agentsDir` — the directory the operator
 * pointed the server at — and converted to a file URL. A bare package
 * specifier is passed through so Node resolves it from `node_modules`.
 */
function resolveModuleUrl(
  moduleSpecifier: string,
  agentsDir: string | undefined,
): string {
  if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) {
    return moduleSpecifier;
  }

  return pathToFileURL(
    path.resolve(agentsDir ?? process.cwd(), moduleSpecifier),
  ).href;
}

/** A class that a plugin specifier may name, instantiated with its own spec. */
type PluginConstructor = new (name: string) => unknown;

function isPluginConstructor(value: unknown): value is PluginConstructor {
  return typeof value === 'function';
}

/**
 * Duck-types a loaded value as a plugin.
 *
 * `instanceof BasePlugin` is not usable here: when a project resolves two
 * copies of `@google/adk`, a plugin built against one copy fails the check
 * against the class from the other. `onUserMessageCallback` stands in for the
 * callback surface `PluginManager` drives on every run.
 */
function isPlugin(value: unknown): value is BasePlugin {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['onUserMessageCallback'] === 'function'
  );
}

async function importPluginObject(
  spec: string,
  agentsDir: string | undefined,
): Promise<unknown> {
  const {moduleSpecifier, exportName} = parsePluginSpecifier(spec);
  const loaded: unknown = await import(
    resolveModuleUrl(moduleSpecifier, agentsDir)
  );
  const name = exportName ?? DEFAULT_EXPORT_NAME;
  if (!isRecord(loaded) || !(name in loaded)) {
    throw new Error(`module ${moduleSpecifier} has no export named ${name}`);
  }

  return loaded[name];
}

async function loadExtraPlugin(
  spec: string,
  agentsDir: string | undefined,
): Promise<BasePlugin> {
  const value = await importPluginObject(spec, agentsDir);
  // A class is instantiated with its own specifier as the plugin name, which
  // is what adk-python passes to `plugin_obj(name=qualified_name)`.
  const plugin = isPluginConstructor(value) ? new value(spec) : value;
  if (!isPlugin(plugin)) {
    throw new Error(`${spec} is neither a plugin instance nor a plugin class`);
  }

  return plugin;
}

/**
 * Loads the plugins named by `specs`, in order.
 *
 * A specifier that cannot be imported, or that names a value which is not a
 * plugin, is logged and skipped, so one bad entry does not cost the others.
 * adk-python skips a non-plugin value silently; reporting it here turns a
 * mistyped specifier into a log line instead of a support ticket.
 */
export async function loadExtraPlugins(
  specs: string[],
  agentsDir: string | undefined,
  logger: Logger,
): Promise<BasePlugin[]> {
  const plugins: BasePlugin[] = [];

  for (const spec of specs) {
    try {
      plugins.push(await loadExtraPlugin(spec, agentsDir));
    } catch (e: unknown) {
      logger.error(`Failed to load plugin ${spec}: ${e}`);
    }
  }

  return plugins;
}
