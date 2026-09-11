/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  isBasePlugin,
  isBasePluginClass,
  Logger,
  resolveFullyQualifiedName,
} from '@google/adk';

import {errorMessage} from '../utils/error_utils.js';

/**
 * Instantiates the plugins an operator named on the command line.
 *
 * A name is a fully-qualified name, `<module specifier>#<export>`, and may
 * resolve either to a plugin instance or to a plugin class, which is then
 * constructed with the qualified name as its plugin name. adk-python spells
 * the same option `my_package.my_plugin.MyPlugin`; the separator differs
 * because a JavaScript module specifier may itself contain dots.
 *
 * Loading a plugin runs the named module's top-level code, so an operator
 * must trust the names as far as they trust the command line. No failure is
 * thrown: one unusable name must not stop the server from serving the rest of
 * the agents, matching adk-python.
 */
export async function loadExtraPlugins(
  qualifiedNames: readonly string[],
  logger: Logger,
): Promise<BasePlugin[]> {
  const plugins: BasePlugin[] = [];
  for (const qualifiedName of qualifiedNames) {
    const plugin = await loadExtraPlugin(qualifiedName, logger);
    if (plugin) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

/** Resolves one plugin name, reporting rather than throwing every failure. */
async function loadExtraPlugin(
  qualifiedName: string,
  logger: Logger,
): Promise<BasePlugin | undefined> {
  let resolved: unknown;
  try {
    resolved = await resolveFullyQualifiedName(qualifiedName);
  } catch (error: unknown) {
    logger.error(
      `Failed to load plugin ${qualifiedName}: ${errorMessage(error)}`,
    );
    return undefined;
  }

  if (isBasePlugin(resolved)) {
    return resolved;
  }
  if (isBasePluginClass(resolved)) {
    return new resolved(qualifiedName);
  }

  logger.error(
    `Failed to load plugin ${qualifiedName}: it is neither a BasePlugin ` +
      `instance nor a BasePlugin subclass.`,
  );
  return undefined;
}
