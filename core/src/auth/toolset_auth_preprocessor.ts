/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {buildAuthRequestEvent} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {BaseLlmRequestProcessor} from '../agents/processors/base_llm_processor.js';
import {Event} from '../events/event.js';
import {State} from '../sessions/state.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';
import {AuthHandler, requiresCredentialExchange} from './auth_handler.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from './auth_preprocessor.js';
import {AuthConfig} from './auth_tool.js';

/**
 * Returns whether a usable credential is already available for `authConfig`.
 */
function hasCredential(authConfig: AuthConfig, state: State): boolean {
  if (new AuthHandler(authConfig).getAuthResponse(state)) {
    return true;
  }
  // A raw credential that needs no exchange is usable as supplied, so it needs
  // no user interaction.
  return (
    !requiresCredentialExchange(authConfig.authScheme) &&
    authConfig.rawAuthCredential !== undefined
  );
}

/**
 * Resolves toolset-level authentication before the agent lists its tools.
 *
 * For every toolset in `agent.tools` that declares an `AuthConfig` through
 * {@link BaseToolset.getAuthConfig}, the processor checks whether a credential
 * is already available. If every toolset is satisfied it does nothing. If any
 * toolset is not, it emits one credential request carrying a function call per
 * unsatisfied toolset and interrupts the invocation, so no toolset lists its
 * tools without a credential.
 *
 * This processor must run after `AUTH_PREPROCESSOR`, which stores the
 * credential the client returns, and before
 * `TOOL_FILTER_REQUEST_PROCESSOR`, which lists the tools.
 */
export class ToolsetAuthPreprocessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    const state = new State(invocationContext.session.state);
    // Keyed by the synthetic function call id, so two toolsets that share a
    // credential key collapse into a single request.
    const authRequests: Record<string, AuthConfig> = {};

    for (const toolUnion of agent.tools) {
      if (!isBaseToolset(toolUnion)) {
        continue;
      }

      const authConfig = toolUnion.getAuthConfig();
      if (!authConfig || hasCredential(authConfig, state)) {
        continue;
      }

      const credentialId = `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${authConfig.credentialKey}`;
      try {
        authRequests[credentialId] = new AuthHandler(
          authConfig,
        ).generateAuthRequest();
      } catch (e: unknown) {
        // A misconfigured toolset must not break the turn: the toolset may
        // still work without a credential, and the other toolsets still get
        // their requests.
        logger.warn(
          `Skipping the toolset credential request for credential key ${authConfig.credentialKey}.`,
          e,
        );
      }
    }

    if (Object.keys(authRequests).length === 0) {
      return;
    }

    yield buildAuthRequestEvent(invocationContext, authRequests);
    invocationContext.endInvocation = true;
  }
}

export const TOOLSET_AUTH_PREPROCESSOR = new ToolsetAuthPreprocessor();
