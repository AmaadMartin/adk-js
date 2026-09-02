/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolves the agent an eval run scores from the module that defines it.
 *
 * The conventions match adk-python: the module either exposes the agent
 * itself, or re-exports it under an `agent` namespace, and the agent is either
 * a `rootAgent` binding or the first element returned by `getAgentAsync()`.
 */

import {BaseAgent, isBaseAgent} from '../agents/base_agent.js';
import {App, isApp} from '../apps/app.js';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Matches a specifier whose module is named `agent`, with or without a file
 * extension. adk-python spells this module `my_agent.agent`; a TypeScript
 * caller spells it `./my_agent/agent.js`, so both forms are accepted.
 */
const AGENT_MODULE_SPECIFIER = /(^|[./\\])agent(\.[^./\\]+)?$/;

/** Names the module in a message when the caller passed an object. */
const ANONYMOUS_MODULE_LABEL = 'the agent module';

/** The shape of a module that exposes an agent to evaluate. */
export interface AgentModuleExports {
  /** A nested `agent` namespace, as `my_agent/agent.ts` re-exported. */
  agent?: AgentModuleExports;

  /** The agent to evaluate. */
  rootAgent?: unknown;

  /** Returns the root agent and opaque cleanup metadata. */
  getAgentAsync?: () => Promise<readonly [BaseAgent, unknown]>;

  /** The app wrapping the agent. Ignored when it is not an {@link App}. */
  app?: unknown;
}

/** A module specifier to import, or an already-imported module. */
export type AgentModuleRef = string | AgentModuleExports;

/** The agent an eval run scores, and the app it belongs to. */
export interface ResolvedAgent {
  agent: BaseAgent;

  /** The app the module exposes, when it exposes one. */
  app?: App;
}

/**
 * Names the agent module in a message.
 *
 * A module object carries no name and stringifying it produces noise, so it is
 * described generically.
 */
export function describeAgentModule(agentModule: AgentModuleRef): string {
  return typeof agentModule === 'string' ? agentModule : ANONYMOUS_MODULE_LABEL;
}

/**
 * Imports a module specifier.
 *
 * @throws {InputValidationError} When the module neither exposes an `agent`
 *   member nor is itself named `agent`, so it names no agent module.
 */
async function importAgentModule(
  specifier: string,
): Promise<AgentModuleExports> {
  const moduleExports: AgentModuleExports = await import(specifier);
  if (
    moduleExports.agent === undefined &&
    !AGENT_MODULE_SPECIFIER.test(specifier)
  ) {
    throw new InputValidationError(
      `Module ${specifier} does not have a member named \`agent\` or the ` +
        'name should end with `agent`.',
    );
  }
  return moduleExports;
}

/** Returns the agent the module binds, awaiting its factory when it has one. */
async function resolveRootAgent(
  moduleExports: AgentModuleExports,
  moduleName: string,
): Promise<BaseAgent> {
  let candidate: unknown = moduleExports.rootAgent;
  if (candidate === undefined) {
    if (typeof moduleExports.getAgentAsync !== 'function') {
      throw new InputValidationError(
        `Module ${moduleName} does not have a rootAgent or getAgentAsync ` +
          'method.',
      );
    }
    [candidate] = await moduleExports.getAgentAsync();
  }
  if (!isBaseAgent(candidate)) {
    throw new InputValidationError(
      `Module ${moduleName} does not expose an agent as its \`rootAgent\`.`,
    );
  }
  return candidate;
}

/**
 * Resolves the agent to evaluate and the wrapping app, if any.
 *
 * When `agentModule` is a specifier it is loaded with a dynamic `import()`,
 * which executes the module. That is the same trust boundary as importing it
 * from the test file directly: the caller is the test author, and the
 * specifier never comes from eval data or from a config file. Prefer passing
 * an already-imported module, because a relative specifier resolves against
 * this file rather than against the caller.
 *
 * When `agentName` is given the named sub-agent is returned, and the app is
 * still surfaced so that its application-wide configuration is honored.
 *
 * @throws {InputValidationError} When the module exposes no agent, or when
 *   `agentName` names no sub-agent.
 */
export async function resolveAgentForEval(
  agentModule: AgentModuleRef,
  agentName?: string,
): Promise<ResolvedAgent> {
  const moduleName = describeAgentModule(agentModule);
  const moduleExports: AgentModuleExports =
    typeof agentModule === 'string'
      ? await importAgentModule(agentModule)
      : agentModule;

  const agentExports = moduleExports.agent ?? moduleExports;
  const rootAgent = await resolveRootAgent(agentExports, moduleName);
  const app = isApp(agentExports.app) ? agentExports.app : undefined;

  if (!agentName) {
    return {agent: rootAgent, app};
  }
  const selected = rootAgent.findAgent(agentName);
  if (!selected) {
    throw new InputValidationError(`Sub-Agent '${agentName}' not found.`);
  }
  return {agent: selected, app};
}
