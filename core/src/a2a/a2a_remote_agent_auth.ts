/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {buildAuthHeaders} from '../auth/auth_headers.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from '../auth/auth_preprocessor.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent} from '../events/event.js';
import {State} from '../sessions/state.js';
import {createAuthRequestEvent} from '../workflow/utils/hitl_utils.js';

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

/**
 * Resolves the credential for one invocation.
 *
 * A credential already collected for this session wins; otherwise the raw
 * credential the caller configured is used when it is usable as-is (an API key
 * or a bearer token needs no exchange). When neither yields headers, the
 * caller must ask the client to collect one.
 *
 * The resolved credential is returned rather than stored: it lives in the
 * caller's local for the length of the run, so it never reaches the session.
 *
 * @throws When the scheme requires an exchange the configured credential
 *   cannot start (see `AuthHandler.generateAuthRequest`).
 */
export function resolveRemoteAuth(
  authConfig: AuthConfig,
  ctx: InvocationContext,
  agentName: string,
): ResolvedRemoteAuth {
  const state = new State(ctx.session.state);
  const collected = new AuthHandler(authConfig).getAuthResponse(state);
  const headers =
    buildAuthHeaders(collected, authConfig.authScheme) ??
    buildAuthHeaders(authConfig.rawAuthCredential, authConfig.authScheme);
  if (headers) {
    return {headers};
  }

  // The id is prefixed so the auth preprocessor stores the response without
  // trying to resume a function call that never existed.
  const requestEvent = createAuthRequestEvent(
    authConfig,
    `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${agentName}`,
  );
  return {
    authRequestEvent: {
      ...requestEvent,
      author: agentName,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
    },
  };
}
