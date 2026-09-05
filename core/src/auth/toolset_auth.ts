/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {buildAuthRequestEvent} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent, type LlmAgent} from '../agents/llm_agent.js';
import {BaseLlmRequestProcessor} from '../agents/processors/base_llm_processor.js';
import {Event} from '../events/event.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthHandler} from './auth_handler.js';
import {AuthConfig} from './auth_tool.js';

/**
 * Prefix of the function call id ADK mints for a toolset's credential request.
 *
 * A tool-level request carries the id of the call that needs the credential.
 * A toolset has no such call, so the id is synthesised from this prefix and
 * the toolset's class name, and the resume path recognises it by the prefix.
 */
export const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

/**
 * Resolves the credential each of the agent's toolsets needs, before ADK lists
 * their tools.
 *
 * A toolset declares its requirement through `BaseToolset.getAuthConfig()`. A
 * credential that is already available is stored on the invocation under its
 * credential key. When a credential is missing, the generator yields one event
 * asking the client for every missing credential and ends the invocation.
 *
 * @param invocationContext The current invocation context.
 * @param agent The agent whose toolsets are resolved.
 * @yields The single auth request event, when a credential is missing.
 */
export async function* resolveToolsetAuth(
  invocationContext: InvocationContext,
  agent: LlmAgent,
): AsyncGenerator<Event, void, void> {
  if (!agent.tools.length) {
    return;
  }

  const pendingAuthRequests: Record<string, AuthConfig> = {};
  const callbackContext = new Context({invocationContext});

  for (const toolUnion of agent.tools) {
    if (!isBaseToolset(toolUnion)) {
      continue;
    }
    const authConfig = toolUnion.getAuthConfig();
    if (!authConfig) {
      continue;
    }

    // The toolset owns its config and reuses it across invocations, so this
    // invocation resolves against a copy.
    const authConfigCopy = cloneDeep(authConfig);
    const toolsetName = toolUnion.constructor.name;

    let credential: AuthCredential | undefined;
    try {
      credential = callbackContext.getAuthResponse(authConfigCopy);
    } catch (error: unknown) {
      // A malformed config stops that toolset from authenticating; the toolset
      // may still work without a credential, so the flow carries on.
      logger.warn(
        `Failed to get auth credential for toolset ${toolsetName}:`,
        error,
      );
      credential = undefined;
    }

    if (credential) {
      const credentialKey = authConfig.credentialKey;
      if (!credentialKey) {
        throw new Error('Resolved toolset auth is missing a credential key.');
      }
      invocationContext.credentialByKey[credentialKey] = credential;
      continue;
    }

    // Two toolsets of the same class share this id, so the later one wins and
    // the client is asked once. This matches adk-python.
    pendingAuthRequests[`${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${toolsetName}`] =
      authConfigCopy;
  }

  if (Object.keys(pendingAuthRequests).length === 0) {
    return;
  }

  const authRequests: Record<string, AuthConfig> = {};
  for (const [credentialId, authConfig] of Object.entries(
    pendingAuthRequests,
  )) {
    authRequests[credentialId] = new AuthHandler(
      authConfig,
    ).generateAuthRequest();
  }

  yield buildAuthRequestEvent(invocationContext, authRequests, {
    author: agent.name,
  });

  invocationContext.endInvocation = true;
}

/**
 * Resolves toolset credentials as part of request preprocessing.
 *
 * It is a request processor rather than a step of the flow because adk-js
 * lists an agent's tools from `ToolFilterRequestProcessor`. Ordering it
 * against the other processors is what puts the credential in place before
 * anything calls `getTools()`, and after `AuthPreprocessor` has stored the
 * credential the client just sent.
 */
export class ToolsetAuthPreprocessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    yield* resolveToolsetAuth(invocationContext, agent);
  }
}

export const TOOLSET_AUTH_PREPROCESSOR = new ToolsetAuthPreprocessor();
