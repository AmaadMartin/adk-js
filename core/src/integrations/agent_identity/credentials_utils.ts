/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../agents/framework_function_calls.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {getFunctionCalls, getFunctionResponses} from '../../events/event.js';

/** How long to wait between polls while the service reports no credential. */
export const NON_INTERACTIVE_TOKEN_POLL_INTERVAL_MS = 1000;

/** How long to keep polling before giving up. */
export const NON_INTERACTIVE_TOKEN_POLL_TIMEOUT_MS = 10000;

/** The argument that carries the tool call a credential request belongs to. */
const FUNCTION_CALL_ID_ARG = 'functionCallId';

/** The header a custom-header credential always carries alongside its own. */
const GOOGLE_API_KEY_HEADER = 'X-GOOG-API-KEY';

/** The upstream service, as it names itself in the errors below. */
export enum CredentialsServiceName {
  AGENT_IDENTITY = 'Agent Identity Credentials',
  IAM_CONNECTOR = 'IAM Connector Credentials',
}

/** What each service calls the resource a scheme names. */
export enum CredentialsResourceNoun {
  PROVIDER = 'provider',
  CONNECTOR = 'connector',
}

/** The header/token pair both credentials services return on success. */
export interface HeaderCredentials {
  /** The HTTP header that carries the token, e.g. `Authorization: Bearer`. */
  header?: string;

  /** The token itself. */
  token?: string;
}

/** Sleeps for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The error both providers throw when the upstream call fails. */
export function retrievalFailure(
  userId: string,
  resourceName: string,
  noun: CredentialsResourceNoun,
  cause: unknown,
): Error {
  return new Error(
    `Failed to retrieve credential for user '${userId}' on ${noun} ` +
      `'${resourceName}'.`,
    {cause},
  );
}

/**
 * Builds an HTTP credential from the header/token pair a service returned.
 *
 * A header of `Authorization: Bearer` becomes a bearer credential. Any other
 * header name is sent verbatim, alongside `X-GOOG-API-KEY`.
 *
 * @param credentials The header/token pair the service returned.
 * @param service The service that returned them, named in the error below.
 * @returns The credential a tool can authenticate with.
 * @throws Error If either the header or the token is empty.
 */
export function constructAuthCredential(
  credentials: HeaderCredentials,
  service: CredentialsServiceName,
): AuthCredential {
  const {header, token} = credentials;
  if (!header || !token) {
    throw new Error(
      `Received either empty header or token from ${service} service.`,
    );
  }

  const separator = header.indexOf(':');
  const headerName = separator === -1 ? header : header.slice(0, separator);
  const headerValue = separator === -1 ? '' : header.slice(separator + 1);
  if (
    headerName.trim().toLowerCase() === 'authorization' &&
    headerValue.trim().toLowerCase().startsWith('bearer')
  ) {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token}},
    };
  }

  return {
    authType: AuthCredentialTypes.HTTP,
    http: {
      // A custom header carries the token itself, so scheme and credentials
      // stay empty.
      scheme: '',
      credentials: {},
      additionalHeaders: {[header]: token, [GOOGLE_API_KEY_HEADER]: token},
    },
  };
}

/**
 * True when the end user already answered the credential request that belongs
 * to this tool call.
 *
 * A provider uses it to tell a first consent prompt from a repeat one: a second
 * consent request after the user answered means the consent did not produce a
 * credential.
 */
export function isConsentCompleted(context: Context): boolean {
  if (!context.functionCallId) {
    return false;
  }
  const requestedFunctionCallIds = new Map<string, unknown>();
  const answeredCallIds = new Set<string>();
  for (const event of context.invocationContext.session.events) {
    for (const call of getFunctionCalls(event)) {
      if (call.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME && call.id) {
        requestedFunctionCallIds.set(
          call.id,
          call.args?.[FUNCTION_CALL_ID_ARG],
        );
      }
    }
    for (const response of getFunctionResponses(event)) {
      if (
        response.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME &&
        response.id
      ) {
        answeredCallIds.add(response.id);
      }
    }
  }

  for (const callId of answeredCallIds) {
    if (requestedFunctionCallIds.get(callId) === context.functionCallId) {
      return true;
    }
  }
  return false;
}
