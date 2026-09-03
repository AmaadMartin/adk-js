/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {buildAuthHeaders} from '../auth/auth_headers.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from '../auth/auth_preprocessor.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent, getFunctionResponses} from '../events/event.js';
import {State} from '../sessions/state.js';
import {
  createAuthRequestEvent,
  processAuthResume,
} from '../workflow/utils/hitl_utils.js';

/** Prefix of the credential key derived when the caller supplies none. */
const DERIVED_CREDENTIAL_KEY_PREFIX = 'adk_a2a_';

/** The credential settings a {@link RemoteA2AAgent} authenticates with. */
export interface RemoteA2AAuthOptions {
  /** The scheme the remote agent authenticates with. */
  authScheme: AuthScheme;
  /** The credential for `authScheme`. */
  authCredential?: AuthCredential;
  /** Key the resolved credential is stored under. Derived when omitted. */
  credentialKey?: string;
}

/**
 * Builds the {@link AuthConfig} a remote agent resolves its credential from.
 *
 * The derived key names the agent, so two remote agents sharing one scheme do
 * not share a stored credential and the first agent's token cannot go to the
 * second agent's host. adk-python digests the scheme, the credential and the
 * remote instead; a name is enough here because an ADK agent name is already
 * unique within its tree.
 */
export function buildRemoteAuthConfig(
  agentName: string,
  options: RemoteA2AAuthOptions,
): AuthConfig {
  return {
    authScheme: options.authScheme,
    rawAuthCredential: options.authCredential,
    credentialKey:
      options.credentialKey ?? `${DERIVED_CREDENTIAL_KEY_PREFIX}${agentName}`,
  };
}

/** The outcome of resolving a remote agent's credential for one invocation. */
export interface ResolvedRemoteAuth {
  /** Headers carrying the credential, when one is available. */
  headers?: Record<string, string>;
  /** Event asking the client to collect a credential, when none is. */
  authRequestEvent?: AdkEvent;
}

/** The id of the credential request this agent raises for itself. */
export function credentialRequestId(agentName: string): string {
  // Prefixed so the auth preprocessor stores a response without trying to
  // resume a function call that never existed.
  return `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${agentName}`;
}

/**
 * Resolves the credential for one invocation.
 *
 * A credential the client sent in answer to this agent's own request wins,
 * then one already in session state, then the raw credential the caller
 * configured when it is usable as-is (an API key or a bearer token needs no
 * exchange). When none of them yields headers, the caller must ask the client
 * to collect one.
 *
 * The agent stores the client's answer itself. `AuthPreprocessor` cannot: it
 * runs only for an `LlmAgent`, and it ignores a request event another agent
 * authored, so the credential collected for this agent would never be written
 * and the agent would ask for it again on every turn.
 *
 * The resolved credential is returned rather than kept on the agent: it lives
 * in the caller's local for the length of the run.
 *
 * @throws When the scheme requires an exchange the configured credential
 *   cannot start (see `AuthHandler.generateAuthRequest`).
 */
export async function resolveRemoteAuth(
  authConfig: AuthConfig,
  ctx: InvocationContext,
  agentName: string,
): Promise<ResolvedRemoteAuth> {
  const state = new State(ctx.session.state);
  const handler = new AuthHandler(authConfig);
  const requestId = credentialRequestId(agentName);

  if (!handler.getAuthResponse(state)) {
    const responseData = findCredentialResponse(ctx.session.events, requestId);
    if (responseData !== undefined) {
      await processAuthResume({responseData, authConfig, state});
    }
  }

  const headers =
    buildAuthHeaders(handler.getAuthResponse(state), authConfig.authScheme) ??
    buildAuthHeaders(authConfig.rawAuthCredential, authConfig.authScheme);
  if (headers) {
    return {headers};
  }

  const requestEvent = createAuthRequestEvent(authConfig, requestId);
  return {
    authRequestEvent: {
      ...requestEvent,
      author: agentName,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
    },
  };
}

/** The newest credential the client sent in answer to `requestId`. */
function findCredentialResponse(
  events: readonly AdkEvent[],
  requestId: string,
): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    for (const response of getFunctionResponses(events[i])) {
      if (
        response.id === requestId &&
        response.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME
      ) {
        return response.response;
      }
    }
  }
  return undefined;
}
