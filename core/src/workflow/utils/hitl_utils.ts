/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for Human-in-the-Loop (HITL) workflows.
 *
 * Ported (subset) from `google/adk-python`
 * `workflow/utils/_workflow_hitl_utils.py`.
 */

import {FunctionResponse, Part} from '@google/genai';
import {isEqual} from 'lodash-es';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {AuthHandler} from '../../auth/auth_handler.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {createEvent, Event} from '../../events/event.js';
import {State} from '../../sessions/state.js';
import {toJsonSchema} from '../../utils/schema.js';
import {ResumeMismatchReason} from '../errors.js';
import {RequestInput} from '../request_input.js';

/** Function-call name marking a request-for-input interrupt. */
export const REQUEST_INPUT_FUNCTION_CALL_NAME = 'adk_request_input';

/** Function-call name marking a request-for-credential interrupt. */
export const REQUEST_CREDENTIAL_FUNCTION_CALL_NAME = 'adk_request_credential';

/** Args key under which an interrupt freezes the payload the human reviews. */
const REQUEST_INPUT_PAYLOAD_KEY = 'payload';

/**
 * Creates an interrupt {@link Event} from a {@link RequestInput}. The event
 * carries an `adk_request_input` function call and marks the interrupt id as a
 * long-running tool id.
 */
export function createRequestInputEvent(requestInput: RequestInput): Event {
  const args: Record<string, unknown> = {
    interruptId: requestInput.interruptId,
    [REQUEST_INPUT_PAYLOAD_KEY]: requestInput.payload ?? null,
    message: requestInput.message ?? null,
    responseSchema: requestInput.responseSchema
      ? toJsonSchema(requestInput.responseSchema)
      : null,
  };

  return createEvent({
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_INPUT_FUNCTION_CALL_NAME,
            args,
            id: requestInput.interruptId,
          },
        },
      ],
    },
    longRunningToolIds: [requestInput.interruptId],
  });
}

/** Returns whether an event contains a `request_input` function call. */
export function hasRequestInputFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_INPUT_FUNCTION_CALL_NAME,
  );
}

/** Returns whether an event contains an `adk_request_credential` function call. */
export function hasAuthRequestFunctionCall(event: Event): boolean {
  return (event.content?.parts ?? []).some(
    (p) => p.functionCall?.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  );
}

/** Extracts interrupt ids from `request_input` function calls in an event. */
export function getRequestInputInterruptIds(event: Event): string[] {
  const ids: string[] = [];
  for (const part of event.content?.parts ?? []) {
    const fc = part.functionCall;
    if (fc && fc.name === REQUEST_INPUT_FUNCTION_CALL_NAME && fc.id) {
      ids.push(fc.id);
    }
  }
  return ids;
}

/**
 * Creates a `FunctionResponse` part answering a `request_input` interrupt,
 * suitable for appending to a session as the user's resume response.
 */
export function createRequestInputResponse(
  interruptId: string,
  response: Record<string, unknown>,
): Part {
  return {
    functionResponse: {
      id: interruptId,
      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
      response,
    },
  };
}

// ---------------------------------------------------------------------------
// Resume intent binding (frozen request <-> resume response)
// ---------------------------------------------------------------------------

/** The request a node froze when it paused, read back off the interrupt event. */
export interface FrozenRequest {
  interruptId: string;
  /** The interrupt call name (`adk_request_input` / `adk_request_credential`). */
  name: string;
  /** The payload the human was shown, when the request froze one. */
  payload?: unknown;
}

/**
 * Reads the frozen request(s) an interrupt event carries.
 *
 * Only function calls whose id is listed in `event.longRunningToolIds` are
 * read, so the frozen request always comes from an engine-authored interrupt.
 * An interrupt event that carries `longRunningToolIds` but no function-call
 * part froze no request, and yields no entry.
 */
export function readFrozenRequests(event: Event): FrozenRequest[] {
  const interruptIds = new Set(event.longRunningToolIds);
  const frozen: FrozenRequest[] = [];
  for (const part of event.content?.parts ?? []) {
    const fc = part.functionCall;
    if (fc?.id && fc.name && interruptIds.has(fc.id)) {
      frozen.push({
        interruptId: fc.id,
        name: fc.name,
        payload: fc.args?.[REQUEST_INPUT_PAYLOAD_KEY],
      });
    }
  }
  return frozen;
}

/**
 * Verifies a resume function response against the request frozen when the node
 * paused. Pure: never throws, never mutates, returns the mismatch reason or
 * `undefined` when the response binds.
 *
 * A response with no function name is accepted: `FunctionResponse.name` is
 * optional in `@google/genai`, and an absent name cannot be attributed to
 * another call. The payload check applies only when the request froze a payload
 * and the response echoes one, so it stays inert for a message-only request and
 * for `adk_request_credential`.
 */
export function verifyResumeResponse(
  frozen: FrozenRequest,
  response: FunctionResponse,
): ResumeMismatchReason | undefined {
  if (response.name && response.name !== frozen.name) {
    return ResumeMismatchReason.WRONG_FUNCTION;
  }
  if (frozen.payload === undefined || frozen.payload === null) {
    return undefined;
  }
  const body = response.response;
  if (!isRecord(body) || !(REQUEST_INPUT_PAYLOAD_KEY in body)) {
    return undefined;
  }
  try {
    if (
      !isEqual(
        jsonValue(body[REQUEST_INPUT_PAYLOAD_KEY]),
        jsonValue(frozen.payload),
      )
    ) {
      return ResumeMismatchReason.PAYLOAD_MISMATCH;
    }
  } catch {
    // A value JSON.stringify refuses (a cycle) cannot be shown to match.
    return ResumeMismatchReason.PAYLOAD_MISMATCH;
  }
  return undefined;
}

/**
 * Projects a value onto its JSON representation, so an echo that crossed the
 * wire compares equal to a frozen payload still held in memory. The session may
 * hold the interrupt event un-serialised (`InMemorySessionService` deep-clones
 * it), which leaves `Date`s and `undefined`-valued keys the echo cannot carry.
 */
function jsonValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value) ?? 'null');
}

/** Narrows an unknown value to a plain (non-array) record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Auth-credential utilities (auth gate)
// ---------------------------------------------------------------------------

/** Whether a credential for the given auth config already exists in state. */
export function hasAuthCredential(
  authConfig: AuthConfig,
  state: State,
): boolean {
  return new AuthHandler(authConfig).getAuthResponse(state) !== undefined;
}

/**
 * Creates an event requesting user authentication credentials
 * (`adk_request_credential`), marking the interrupt id as a long-running tool.
 *
 * Ported from `google/adk-python` `create_auth_request_event`.
 */
export function createAuthRequestEvent(
  authConfig: AuthConfig,
  interruptId: string,
): Event {
  const authRequest = new AuthHandler(authConfig).generateAuthRequest();
  const args: Record<string, unknown> = {
    functionCallId: interruptId,
    authConfig: authRequest,
    message: buildAuthMessage(authConfig),
  };
  return createEvent({
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            id: interruptId,
            args,
          },
        },
      ],
    },
    longRunningToolIds: [interruptId],
  });
}

/** Parameters for {@link processAuthResume}. */
export interface ProcessAuthResumeParams {
  /** The resume response: a full {@link AuthConfig} or a plain value. */
  responseData: unknown;
  /** The auth config the credential is being stored for. */
  authConfig: AuthConfig;
  /** The session state to store the credential in. */
  state: State;
}

/**
 * Stores credentials from an auth resume response into session state. Accepts a
 * full {@link AuthConfig} (web UI flow) or a plain value (e.g. an API key
 * string), mirroring `google/adk-python` `process_auth_resume`.
 */
export async function processAuthResume({
  responseData,
  authConfig,
  state,
}: ProcessAuthResumeParams): Promise<void> {
  let responseConfig: AuthConfig;
  if (isAuthConfigLike(responseData)) {
    responseConfig = {
      ...(responseData as AuthConfig),
      credentialKey: authConfig.credentialKey,
    };
  } else {
    responseConfig = {
      ...authConfig,
      exchangedAuthCredential: buildCredentialFromValue(
        authConfig,
        responseData,
      ),
    };
  }
  await new AuthHandler(responseConfig).parseAndStoreAuthResponse(state);
}

function isAuthConfigLike(value: unknown): value is AuthConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authScheme' in value &&
    'credentialKey' in value
  );
}

function buildCredentialFromValue(
  authConfig: AuthConfig,
  value: unknown,
): AuthCredential {
  if (authConfig.rawAuthCredential?.authType === AuthCredentialTypes.API_KEY) {
    return {authType: AuthCredentialTypes.API_KEY, apiKey: String(value)};
  }
  return value as AuthCredential;
}

function buildAuthMessage(authConfig: AuthConfig): string {
  const authType = authConfig.rawAuthCredential?.authType;
  if (authType === AuthCredentialTypes.API_KEY) {
    return 'Please provide your API key.';
  }
  if (
    authType === AuthCredentialTypes.OAUTH2 ||
    authType === AuthCredentialTypes.OPEN_ID_CONNECT
  ) {
    return 'Please complete the authentication flow.';
  }
  return 'Please provide your authentication credentials.';
}
