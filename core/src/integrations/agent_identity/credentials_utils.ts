/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {REQUEST_EUC_FUNCTION_CALL_NAME} from '../../agents/functions.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {camelCaseKeys} from '../../utils/case_utils.js';

/** Interval between two polls of a pending credentials request. */
export const NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS = 1000;

/** Deadline for polling a pending credentials request. */
export const NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS = 10000;

/** Thrown when the caller supplied no context identifying the end user. */
export const MISSING_USER_ID_ERROR =
  'GcpAuthProvider requires a context with a valid userId.';

/** Thrown when the end user declined the consent request. */
export const CONSENT_REJECTED_ERROR =
  'Operation failed: User consent rejected.';

/** Thrown when consent completed yet the service still demands it. */
export const CONSENT_ALREADY_COMPLETED_ERROR =
  'Failed to retrieve consent based credential.';

/** Thrown when polling did not reach a terminal state in time. */
export const TIMEOUT_ERROR = 'Timeout waiting for credentials.';

/** Header injected alongside a custom header so API-key tools can find it. */
const GOOGLE_API_KEY_HEADER = 'X-GOOG-API-KEY';

/**
 * The subset of `Context` the Agent Identity providers rely on.
 *
 * Declared structurally so the integration does not depend on the agent layer
 * and so callers can pass any equivalent carrier.
 */
export interface AgentIdentityContext {
  readonly userId?: string;
  readonly functionCallId?: string;
  readonly invocationContext?: {session?: {events?: Event[]}};
}

/** An {@link AgentIdentityContext} known to identify an end user. */
export interface ResolvedAgentIdentityContext extends AgentIdentityContext {
  readonly userId: string;
}

/** The header/token pair returned by both credentials services. */
export interface HeaderTokenCredential {
  header?: string;
  token?: string;
}

/** Narrows an opaque callback context to {@link AgentIdentityContext}. */
export function asAgentIdentityContext(
  context: unknown,
): AgentIdentityContext | undefined {
  if (typeof context !== 'object' || context === null) {
    return undefined;
  }
  const candidate: AgentIdentityContext = context;
  return candidate;
}

/**
 * Narrows an opaque callback context and asserts that it identifies an end
 * user.
 *
 * @throws If the context is absent or carries no user id.
 */
export function requireAgentIdentityContext(
  context: unknown,
): ResolvedAgentIdentityContext {
  const candidate = asAgentIdentityContext(context);
  if (!candidate || !hasUserId(candidate)) {
    throw new Error(MISSING_USER_ID_ERROR);
  }
  return candidate;
}

/** Converts an arbitrary thrown value into an `Error`. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Builds the message reported when a credentials retrieval fails. */
export function retrievalFailedMessage(
  userId: string,
  resourceKind: string,
  resourceName: string,
): string {
  return `Failed to retrieve credential for user '${userId}' on ${resourceKind} '${resourceName}'.`;
}

/**
 * Runs `retrieve`, rethrowing any failure as `message` with the original
 * failure attached as its cause.
 */
export async function wrapRetrievalFailure<T>(
  retrieve: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await retrieve();
  } catch (e: unknown) {
    throw new Error(message, {cause: toError(e)});
  }
}

/**
 * Builds an ADK credential from the header/token pair returned by a
 * credentials service.
 *
 * @param credential The header/token pair, if the service returned one.
 * @param serviceLabel Name of the service, used in the failure message.
 * @throws If either the header or the token is missing.
 */
export function constructAuthCredential(
  credential: HeaderTokenCredential | undefined,
  serviceLabel: string,
): AuthCredential {
  const header = credential?.header;
  const token = credential?.token;
  if (!header || !token) {
    throw new Error(
      `Received either empty header or token from ${serviceLabel}.`,
    );
  }

  if (isBearerAuthorizationHeader(header)) {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token}},
    };
  }

  return {
    authType: AuthCredentialTypes.HTTP,
    // For custom headers the scheme and credentials fields are not used.
    http: {
      scheme: '',
      credentials: {},
      additionalHeaders: {[header]: token, [GOOGLE_API_KEY_HEADER]: token},
    },
  };
}

/**
 * Builds the OAuth2 credential that drives the end user through consent.
 *
 * @throws If consent already completed for this function call, meaning the
 *     service would keep demanding it.
 */
export function buildConsentCredential(
  context: AgentIdentityContext,
  authUri: string | undefined,
  nonce: string | undefined,
): AuthCredential {
  if (isConsentCompleted(context)) {
    throw new Error(CONSENT_ALREADY_COMPLETED_ERROR);
  }
  return {authType: AuthCredentialTypes.OAUTH2, oauth2: {authUri, nonce}};
}

/**
 * Returns whether the end-user consent flow already completed for the function
 * call currently being served.
 */
export function isConsentCompleted(context: AgentIdentityContext): boolean {
  const targetToolCallId = context.functionCallId;
  if (!targetToolCallId) {
    return false;
  }

  const session = context.invocationContext?.session;
  if (!session) {
    return false;
  }

  const eucCallArgsById = new Map<string, unknown>();
  const eucResponseIds = new Set<string>();
  for (const event of session.events ?? []) {
    for (const call of getFunctionCalls(event)) {
      if (call.name === REQUEST_EUC_FUNCTION_CALL_NAME && call.id) {
        eucCallArgsById.set(call.id, call.args);
      }
    }
    for (const response of getFunctionResponses(event)) {
      if (response.name === REQUEST_EUC_FUNCTION_CALL_NAME && response.id) {
        eucResponseIds.add(response.id);
      }
    }
  }

  for (const responseId of eucResponseIds) {
    if (!eucCallArgsById.has(responseId)) {
      continue;
    }
    if (
      readFunctionCallId(eucCallArgsById.get(responseId)) === targetToolCallId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Repeatedly invokes `fetchOnce` until it yields a terminal value or the
 * deadline expires.
 *
 * @throws If the deadline expires before a terminal value is produced.
 */
export async function pollWithDeadline<T>(
  fetchOnce: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  options: {timeoutMs: number; intervalMs: number},
): Promise<T> {
  const endTime = Date.now() + options.timeoutMs;
  while (Date.now() < endTime) {
    const value = await fetchOnce();
    if (isTerminal(value)) {
      return value;
    }
    await sleep(options.intervalMs);
  }
  throw new Error(TIMEOUT_ERROR);
}

function hasUserId(
  context: AgentIdentityContext,
): context is ResolvedAgentIdentityContext {
  return typeof context.userId === 'string' && context.userId.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mirrors Python's `str.partition(':')`: the header name is everything before
 * the FIRST colon, so a header value that itself contains a colon survives.
 */
function isBearerAuthorizationHeader(header: string): boolean {
  const separatorIndex = header.indexOf(':');
  if (separatorIndex < 0) {
    return false;
  }
  const name = header.slice(0, separatorIndex);
  const value = header.slice(separatorIndex + 1);
  return (
    name.trim().toLowerCase() === 'authorization' &&
    value.trim().toLowerCase().startsWith('bearer')
  );
}

/**
 * Reads the `functionCallId` argument of an `adk_request_credential` call.
 *
 * adk-js writes those args as snake_case (`function_call_id`), so they are
 * normalized before the lookup.
 */
function readFunctionCallId(args: unknown): string | undefined {
  const camelCased = camelCaseKeys(args);
  if (
    typeof camelCased === 'object' &&
    camelCased !== null &&
    'functionCallId' in camelCased
  ) {
    const functionCallId = camelCased.functionCallId;
    return typeof functionCallId === 'string' ? functionCallId : undefined;
  }
  return undefined;
}
