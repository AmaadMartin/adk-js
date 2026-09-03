/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, Message} from '@a2a-js/sdk';
import {ServiceParameters, withA2AExtensions} from '@a2a-js/sdk/client';
import {createHash} from 'node:crypto';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {buildAuthHeaders} from '../auth/auth_headers.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent, isEvent} from '../events/event.js';
import {State} from '../sessions/state.js';
import {A2AEvent} from './a2a_event.js';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  A2ARequestParameters,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
} from './a2a_remote_agent_config.js';

/**
 * Collects the HTTP headers the card request interceptors contribute.
 *
 * Headers merge in list order, so a later interceptor wins a key conflict.
 *
 * @returns The merged headers, or `undefined` when none was contributed.
 */
export async function executeBeforeCardRequestInterceptors(
  interceptors: A2ACardRequestInterceptor[] | undefined,
  ctx: InvocationContext | undefined,
): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = {};
  if (interceptors && ctx) {
    for (const interceptor of interceptors) {
      if (!interceptor.beforeRequest) {
        continue;
      }
      Object.assign(headers, (await interceptor.beforeRequest(ctx)).headers);
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Runs the request interceptors in list order before the request is sent.
 *
 * @returns The message to send and the accumulated parameters. When an
 *   interceptor returns an ADK event, that event is returned in place of the
 *   message and the remaining interceptors do not run.
 */
export async function executeBeforeRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  request: Message,
): Promise<[Message | AdkEvent, A2ARequestParameters]> {
  let params: A2ARequestParameters = {};
  let message = request;
  for (const interceptor of interceptors ?? []) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const [result, next] = await interceptor.beforeRequest(
      ctx,
      message,
      params,
    );
    params = next;
    if (isEvent(result)) {
      return [result, params];
    }
    message = result;
  }
  return [message, params];
}

/**
 * Runs the request interceptors in reverse list order after a response chunk
 * has been converted, so an interceptor sees the response inside the same
 * bracket its `beforeRequest` opened.
 *
 * @returns The event to emit, or `undefined` when an interceptor dropped it.
 */
export async function executeAfterRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  response: A2AEvent,
  event: AdkEvent,
): Promise<AdkEvent | undefined> {
  let current = event;
  for (const interceptor of [...(interceptors ?? [])].reverse()) {
    if (!interceptor.afterRequest) {
      continue;
    }
    const result = await interceptor.afterRequest(ctx, response, current);
    if (!result) {
      return undefined;
    }
    current = result;
  }
  return current;
}

/**
 * Asks the server to answer with the new ADK integration, by declaring the
 * extension on the outgoing call.
 */
export const newIntegrationExtensionInterceptor: A2ARequestInterceptor = {
  beforeRequest: async (_ctx, request, params) => [
    request,
    {
      ...params,
      serviceParameters: ServiceParameters.createFrom(
        params.serviceParameters,
        withA2AExtensions(NEW_A2A_ADK_INTEGRATION_EXTENSION),
      ),
    },
  ],
};

/** The remote a credential is meant for: a URL, a path, or a card name. */
function remoteIdentity(agentCard: AgentCard | string | undefined): string {
  if (typeof agentCard === 'string') {
    return agentCard.trim();
  }
  return agentCard?.url || agentCard?.name || '';
}

/** The leading 16 hex characters of the SHA-256 digest of `value`. */
function shortDigest(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 16);
}

/** The credential key the scheme or the credential names, if it names one. */
function namedCredentialKey(value: object | undefined): string | undefined {
  if (value && 'credentialKey' in value) {
    const key = value.credentialKey;
    if (typeof key === 'string' && key) {
      return key;
    }
  }
  return undefined;
}

/**
 * Builds the auth config a remote agent resolves its credential against.
 *
 * The derived key digests the scheme and the credential, then the remote's own
 * identity. Without the second digest two agents sharing one scheme would share
 * a cache entry, and the first agent's token would go to the second agent's
 * host.
 */
export function buildRemoteAuthConfig(options: {
  authScheme: AuthScheme;
  authCredential?: AuthCredential;
  credentialKey?: string;
  agentCard?: AgentCard | string;
}): AuthConfig {
  const {authScheme, authCredential, credentialKey, agentCard} = options;
  const named =
    credentialKey ??
    namedCredentialKey(authCredential) ??
    namedCredentialKey(authScheme);
  return {
    authScheme,
    rawAuthCredential: authCredential,
    credentialKey:
      named ??
      `adk_a2a_${shortDigest(
        JSON.stringify({authScheme, authCredential}),
      )}_${shortDigest(remoteIdentity(agentCard))}`,
  };
}

/**
 * Builds the interceptors that turn the credential resolved for this
 * invocation into request headers, on both the card fetch and the message
 * send.
 *
 * The credential is read from invocation-scoped `temp:` state rather than
 * captured here, so one agent instance serves many invocations without ever
 * holding another user's credential.
 */
export function buildAuthInterceptors(authConfig: AuthConfig): {
  cardInterceptor: A2ACardRequestInterceptor;
  requestInterceptor: A2ARequestInterceptor;
} {
  const headersFor = (ctx: InvocationContext): Record<string, string> => {
    const credential = new State(ctx.session.state).get<AuthCredential>(
      `${State.TEMP_PREFIX}${authConfig.credentialKey}`,
    );
    return buildAuthHeaders(credential, authConfig.authScheme) ?? {};
  };

  return {
    cardInterceptor: {
      beforeRequest: async (ctx) => {
        const headers = headersFor(ctx);
        return Object.keys(headers).length > 0 ? {headers} : {};
      },
    },
    requestInterceptor: {
      beforeRequest: async (ctx, request, params) => {
        const headers = headersFor(ctx);
        if (Object.keys(headers).length === 0) {
          return [request, params];
        }
        return [
          request,
          {
            ...params,
            serviceParameters: {...params.serviceParameters, ...headers},
          },
        ];
      },
    },
  };
}
