/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';

import {Context} from '../agents/context.js';
import {buildAuthRequestEvent} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent, ToolUnion} from '../agents/llm_agent.js';
import {BaseLlmRequestProcessor} from '../agents/processors/base_llm_processor.js';
import {Event} from '../events/event.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';

import {AuthCredential} from './auth_credential.js';
import {AuthHandler} from './auth_handler.js';
import {AuthConfig, TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from './auth_tool.js';

/**
 * Resolves toolset-level credentials before any later processor lists tools.
 *
 * It runs directly after `AuthPreprocessor`, which is what stores the
 * credential the client returned for an earlier request.
 */
export class ToolsetAuthPreprocessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }
    yield* resolveToolsetAuth(invocationContext, agent.tools);
  }
}

export const TOOLSET_AUTH_PREPROCESSOR = new ToolsetAuthPreprocessor();

/**
 * Resolves the toolset-level credentials an agent's toolsets declared through
 * `BaseToolset.getAuthConfig`.
 *
 * Every resolved credential is parked on `invocationContext.credentialByKey`,
 * where the toolset reads it back with `ReadonlyContext.getCredential`. When a
 * toolset resolves to no credential, the generator asks the client for one and
 * ends the invocation, so no toolset lists its tools with a missing credential.
 *
 * @param invocationContext The invocation context.
 * @param tools The agent's declared tools.
 * @return At most one event, carrying one `adk_request_credential` function
 *     call per unresolved toolset.
 */
export async function* resolveToolsetAuth(
  invocationContext: InvocationContext,
  tools: ToolUnion[],
): AsyncGenerator<Event, void, void> {
  const context = new Context({invocationContext});
  const pendingAuthRequests: Record<string, AuthConfig> = {};

  for (const toolUnion of tools) {
    if (!isBaseToolset(toolUnion)) {
      continue;
    }

    const authConfig = toolUnion.getAuthConfig();
    if (!authConfig) {
      continue;
    }

    // The toolset instance is typically shared across users and sessions, so
    // resolution must never write to the config it handed us.
    const authConfigCopy = cloneDeep(authConfig);

    let credential: AuthCredential | undefined;
    try {
      credential = await resolveToolsetCredential(authConfigCopy, context);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `Failed to get auth credential for toolset ${authConfig.credentialKey}: ${message}`,
      );
    }

    if (credential) {
      invocationContext.credentialByKey[authConfig.credentialKey] = credential;
    } else {
      const credentialId = `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${authConfig.credentialKey}`;
      pendingAuthRequests[credentialId] = new AuthHandler(
        authConfigCopy,
      ).generateAuthRequest();
    }
  }

  const event = buildAuthRequestEvent(
    invocationContext,
    pendingAuthRequests,
    'model',
  );
  if (!event) {
    return;
  }
  yield event;
  invocationContext.endInvocation = true;
}

/**
 * Resolves a single toolset credential from the credential service, falling
 * back to the credential the client returned for an earlier auth request.
 *
 * This is the seam adk-python fills with `CredentialManager`, which adk-js does
 * not have yet. The OAuth2 round trip is still complete, because
 * `AuthPreprocessor` exchanges the authorization code before it writes the
 * credential to the session state this function reads.
 *
 * @param authConfig A private copy of the toolset's auth config. The caller
 *     must not pass the toolset's own object: a successful recovery writes
 *     `exchangedAuthCredential` onto it.
 * @param context The context of the current invocation.
 * @return The credential, or `undefined` when the client must supply one.
 */
async function resolveToolsetCredential(
  authConfig: AuthConfig,
  context: Context,
): Promise<AuthCredential | undefined> {
  const credentialService = context.invocationContext.credentialService;
  const stored = await credentialService?.loadCredential(authConfig, context);
  if (stored) {
    return stored;
  }

  const fromAuthResponse = context.getAuthResponse(authConfig);
  if (fromAuthResponse && credentialService) {
    authConfig.exchangedAuthCredential = fromAuthResponse;
    await credentialService.saveCredential(authConfig, context);
  }
  return fromAuthResponse;
}
