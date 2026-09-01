/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the agent an eval runs against from a module specifier.
 *
 * The specifier comes from the caller's own test code, so it is trusted only
 * as far as that caller is. Importing it runs the module's top-level code.
 * Two checks bound the damage a specifier from a config file could do: a Node
 * built-in is refused outright, and a filesystem path is converted with
 * `pathToFileURL` before import so that a Windows drive letter is not read as
 * a URL scheme. Neither check is a sandbox.
 */

import {isBuiltin} from 'node:module';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {App, isApp} from '../apps/app.js';
import {InputValidationError} from '../errors/input_validation_error.js';

/** Export names an agent module can use, in the order they are tried. */
const APP_EXPORTS = ['app', 'rootApp'] as const;
const ROOT_AGENT_EXPORT = 'rootAgent';
const AGENT_FACTORY_EXPORT = 'getAgentAsync';

/** The agent to evaluate, and the app it belongs to when it has one. */
export interface AgentForEval {
  agent: BaseAgent;

  /**
   * The app, so that its plugins and its resumability config take part in the
   * run. Present even when {@link agent} is a sub-agent.
   */
  app?: App;
}

/**
 * Loads the module, converting a filesystem path to a URL first.
 *
 * A module namespace is a string-keyed object, so it is returned as a record
 * whose values are `unknown` and have to be narrowed before use.
 */
async function importAgentModule(
  moduleSpecifier: string,
): Promise<Record<string, unknown>> {
  if (isBuiltin(moduleSpecifier)) {
    throw new InputValidationError(
      `Module ${moduleSpecifier} is a Node built-in, not an agent module.`,
    );
  }
  // A specifier is a path when Node would read it as one; anything else is a
  // package name and is passed through unchanged.
  const isPath = isAbsolute(moduleSpecifier) || moduleSpecifier.startsWith('.');
  const url = isPath ? pathToFileURL(moduleSpecifier).href : moduleSpecifier;
  return import(url);
}

/**
 * Returns the agent an eval should run against.
 *
 * The module is expected to export an `app` (or `rootApp`), a `rootAgent`, or
 * a `getAgentAsync` factory that resolves to one. An `app` export that is not
 * an {@link App} is ignored rather than rejected, so that a module can name
 * something else `app`.
 *
 * @param moduleSpecifier The agent module, as a package name or a path.
 * @param agentName Selects a sub-agent instead of the root agent.
 * @throws {InputValidationError} If the module exposes no agent, or the named
 *   sub-agent is not in the tree.
 */
export async function getAgentForEval(
  moduleSpecifier: string,
  agentName?: string,
): Promise<AgentForEval> {
  const agentModule = await importAgentModule(moduleSpecifier);
  const app = APP_EXPORTS.map((name) => agentModule[name]).find(isApp);
  const rootAgent = isBaseAgent(app?.rootAgent)
    ? app.rootAgent
    : await resolveRootAgent(agentModule, moduleSpecifier);

  if (!agentName) {
    return {agent: rootAgent, app};
  }
  const selected = rootAgent.findAgent(agentName);
  if (!selected) {
    throw new InputValidationError(`Sub-Agent '${agentName}' not found.`);
  }
  return {agent: selected, app};
}

/** Reads `rootAgent`, or awaits `getAgentAsync`, from the loaded module. */
async function resolveRootAgent(
  agentModule: Record<string, unknown>,
  moduleSpecifier: string,
): Promise<BaseAgent> {
  const rootAgent = agentModule[ROOT_AGENT_EXPORT];
  if (isBaseAgent(rootAgent)) {
    return rootAgent;
  }
  const factory = agentModule[AGENT_FACTORY_EXPORT];
  if (typeof factory === 'function') {
    const produced: unknown = await factory();
    const agent = Array.isArray(produced) ? produced[0] : produced;
    if (isBaseAgent(agent)) {
      return agent;
    }
  }
  throw new InputValidationError(
    `Module ${moduleSpecifier} does not export a \`${ROOT_AGENT_EXPORT}\` ` +
      `or a \`${AGENT_FACTORY_EXPORT}\`.`,
  );
}
