/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {createHash} from 'node:crypto';
import {Context} from '../agents/context.js';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {buildAuthHeaders} from '../auth/auth_headers.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from '../auth/auth_preprocessor.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent} from '../events/event.js';
import {getFunctionResponses} from '../models/llm_response.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  createAuthRequestEvent,
  processAuthResume,
} from '../workflow/utils/hitl_utils.js';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
} from './a2a_remote_agent_interceptors.js';

/** Characters of a sha256 digest kept when building a credential key. */
const CREDENTIAL_KEY_DIGEST_CHARS = 16;

/** The card and request interceptors that carry a resolved credential. */
export interface A2AAuthInterceptors {
  card: A2ACardRequestInterceptor;
  request: A2ARequestInterceptor;
}

/**
 * Derives the key a resolved credential is cached under.
 *
 * The digest covers the remote as well as the scheme and the credential.
 * Without the remote, two agents sharing one scheme would share a cache entry
 * and the first agent's token would go to the second agent's host.
 *
 * @param authScheme The scheme the credential is resolved for.
 * @param authCredential The configured credential, if any.
 * @param agentCard The card object or the URL/path the card comes from.
 * @return A key that is stable for the same scheme, credential and remote.
 */
export function deriveCredentialKey(
  authScheme: AuthScheme,
  authCredential: AuthCredential | undefined,
  agentCard: AgentCard | string,
): string {
  const identity = digest(remoteIdentity(agentCard));
  const config = digest(stableStringify({authScheme, authCredential}));
  return `a2a_${config}_${identity}`;
}

/**
 * Builds the interceptors that attach the resolved credential to the card fetch
 * and to the message send.
 */
export function buildAuthInterceptors(
  authConfig: AuthConfig,
): A2AAuthInterceptors {
  const headersFor = (ctx: InvocationContext): Record<string, string> =>
    buildAuthHeaders(
      ctx.credentialByKey[authConfig.credentialKey],
      authConfig.authScheme,
    ) ?? {};

  return {
    card: {
      async beforeRequest(ctx) {
        return {headers: headersFor(ctx)};
      },
    },
    request: {
      async beforeRequest(ctx, request, params) {
        const headers = headersFor(ctx);
        return {
          request,
          params: {...params, headers: {...params.headers, ...headers}},
        };
      },
    },
  };
}

/**
 * Makes the credential for `authConfig` available in `ctx.credentialByKey`.
 *
 * Resolution order: the invocation cache, the credential the client already
 * supplied for this key, the credential service, then the configured
 * credential. A credential that produces no headers counts as unresolved,
 * because a failed exchange would otherwise send the request unauthenticated.
 *
 * @return An event asking the client to collect the credential, or `undefined`
 *   once the credential is available.
 */
export async function resolveAuthCredential(
  ctx: InvocationContext,
  authConfig: AuthConfig,
  agentName: string,
): Promise<AdkEvent | undefined> {
  const credentialKey = authConfig.credentialKey;
  if (ctx.credentialByKey[credentialKey]) {
    return undefined;
  }

  // Resolve against a copy, so a credential exchanged for one user is never
  // written back onto the config every invocation shares.
  const invocationConfig: AuthConfig = {...authConfig};
  const context = new Context({invocationContext: ctx});
  const requestId = credentialRequestId(agentName);

  await storeAnsweredCredential(ctx, invocationConfig, requestId, context);
  const credential = await loadCredential(ctx, invocationConfig, context);

  if (credential && buildAuthHeaders(credential, authConfig.authScheme)) {
    ctx.credentialByKey[credentialKey] = credential;
    return undefined;
  }

  const event = createAuthRequestEvent(invocationConfig, requestId);
  // Authored so the event reads as this agent's, like every other event it
  // emits. `AuthPreprocessor` only honours a request raised by the LlmAgent
  // whose flow is running, so this agent reads its own answer back instead.
  event.author = agentName;
  ctx.endInvocation = true;
  return event;
}

/** The deterministic id this agent raises its credential request under. */
export function credentialRequestId(agentName: string): string {
  return `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${agentName}`;
}

/**
 * Stores the credential the client supplied in answer to `requestId`.
 *
 * This agent raises its own credential request, so it reads its own answer
 * back: `AuthPreprocessor` deliberately ignores a request that the LlmAgent
 * running the flow did not author, which a remote agent's request never is.
 */
async function storeAnsweredCredential(
  ctx: InvocationContext,
  authConfig: AuthConfig,
  requestId: string,
  context: Context,
): Promise<void> {
  const responseData = findCredentialResponse(ctx.session.events, requestId);
  if (responseData === undefined) {
    return;
  }
  await processAuthResume({
    responseData,
    authConfig,
    state: context.state,
  });
}

/** The payload of the credential response answering `requestId`, if any. */
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

/** Reads the credential from state, the credential service or the config. */
async function loadCredential(
  ctx: InvocationContext,
  authConfig: AuthConfig,
  context: Context,
): Promise<AuthCredential | undefined> {
  const fromState = context.getAuthResponse(authConfig);
  if (fromState) {
    return fromState;
  }
  if (ctx.credentialService) {
    try {
      const stored = await ctx.credentialService.loadCredential(
        authConfig,
        context,
      );
      if (stored) {
        return stored;
      }
    } catch (e: unknown) {
      logger.warn(
        `Failed to load the stored credential for '${authConfig.credentialKey}': ` +
          formatError(e),
      );
    }
  }
  return authConfig.rawAuthCredential;
}

/** The remote a credential is meant for: a URL, a path, or the card's name. */
function remoteIdentity(agentCard: AgentCard | string): string {
  if (typeof agentCard === 'string') {
    return agentCard.trim();
  }
  return agentCard.url || agentCard.name || '';
}

/** The first {@link CREDENTIAL_KEY_DIGEST_CHARS} hex characters of a sha256. */
function digest(value: string): string {
  return createHash('sha256')
    .update(value, 'utf-8')
    .digest('hex')
    .slice(0, CREDENTIAL_KEY_DIGEST_CHARS);
}

/**
 * Serializes a value with object keys sorted, so two structurally equal configs
 * built in different property orders digest to the same key.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => a.localeCompare(b)),
        )
      : val,
  );
}
