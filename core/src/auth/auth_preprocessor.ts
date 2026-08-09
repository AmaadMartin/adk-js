/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEqual} from 'lodash-es';

import {
  REQUEST_EUC_FUNCTION_CALL_NAME,
  handleFunctionCallsAsync,
} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {BaseLlmRequestProcessor} from '../agents/processors/base_llm_processor.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {State} from '../sessions/state.js';
import {BaseTool} from '../tools/base_tool.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthHandler} from './auth_handler.js';
import {AuthScheme} from './auth_schemes.js';
import {AuthConfig} from './auth_tool.js';

const TOOLSET_AUTH_CREDENTIAL_ID_PREFIX = '_adk_toolset_auth_';

interface RequestCredentialArgs {
  authConfig?: AuthConfig;
  functionCallId?: string;
}

/** Shape of a client-supplied `adk_request_credential` response. */
interface AuthResumeResponse {
  authScheme?: unknown;
  exchangedAuthCredential?: AuthCredential;
}

/**
 * Whether a resume-supplied auth scheme contradicts the frozen requested one.
 *
 * Only the keys the response sets are compared, so a client that drops fields
 * the request left `undefined` (a JSON round trip does exactly that) keeps
 * working, while any changed or added field is a mismatch.
 */
function schemeContradictsRequest(
  responseScheme: unknown,
  requestedScheme: AuthScheme | undefined,
): boolean {
  if (responseScheme === undefined || responseScheme === null) {
    return false;
  }
  const requested = (requestedScheme ?? {}) as Record<string, unknown>;
  return Object.entries(responseScheme as Record<string, unknown>).some(
    ([key, value]) => value !== undefined && !isEqual(value, requested[key]),
  );
}

async function storeAuthAndCollectResumeTargets(
  events: Event[],
  authFcIds: Set<string>,
  authResponses: Record<string, unknown>,
  state: State,
): Promise<Set<string>> {
  const requestById: Record<string, RequestCredentialArgs> = {};
  for (const event of events) {
    // A client authors user events, so a function call it carries cannot
    // define the frozen credential request.
    if (event.author === 'user') {
      continue;
    }
    const eventFunctionCalls = getFunctionCalls(event);
    for (const functionCall of eventFunctionCalls) {
      if (
        functionCall.id &&
        authFcIds.has(functionCall.id) &&
        functionCall.name === REQUEST_EUC_FUNCTION_CALL_NAME
      ) {
        requestById[functionCall.id] = camelCaseKeys(
          functionCall.args,
        ) as RequestCredentialArgs;
      }
    }
  }

  const toolsToResume: Set<string> = new Set();
  for (const fcId of authFcIds) {
    const request = requestById[fcId];
    const response = authResponses[fcId] as AuthResumeResponse | undefined;

    if (!request?.authConfig?.credentialKey) {
      logger.warn(
        `Ignoring auth response for ${fcId}: no matching credential request.`,
      );
      continue;
    }

    if (
      schemeContradictsRequest(
        response?.authScheme,
        request.authConfig.authScheme,
      )
    ) {
      logger.warn(
        `Ignoring auth response for ${fcId}: authScheme does not match the requested one.`,
      );
      continue;
    }

    // The frozen request decides how the credential is stored and exchanged.
    // A resume message may only carry the credential the user just obtained.
    await new AuthHandler({
      ...request.authConfig,
      exchangedAuthCredential: response?.exchangedAuthCredential,
    }).parseAndStoreAuthResponse(state);

    const {functionCallId} = request;
    if (
      functionCallId &&
      !functionCallId.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)
    ) {
      toolsToResume.add(functionCallId);
    }
  }

  return toolsToResume;
}

export class AuthPreprocessor extends BaseLlmRequestProcessor {
  override async *runAsync(
    invocationContext: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    const events = invocationContext.session.events;
    if (!events || events.length === 0) {
      return;
    }

    let lastEventWithContent = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.content !== undefined) {
        lastEventWithContent = event;
        break;
      }
    }

    if (!lastEventWithContent || lastEventWithContent.author !== 'user') {
      return;
    }

    const responses = getFunctionResponses(lastEventWithContent);
    if (!responses || responses.length === 0) {
      return;
    }

    const authFcIds: Set<string> = new Set();
    const authResponses: Record<string, unknown> = {};

    for (const functionCallResponse of responses) {
      if (functionCallResponse.name !== REQUEST_EUC_FUNCTION_CALL_NAME) {
        continue;
      }
      if (functionCallResponse.id) {
        authFcIds.add(functionCallResponse.id);
        authResponses[functionCallResponse.id] = functionCallResponse.response;
      }
    }

    if (authFcIds.size === 0) {
      return;
    }

    const state = new State(invocationContext.session.state);
    const toolsToResume = await storeAuthAndCollectResumeTargets(
      events,
      authFcIds,
      authResponses,
      state,
    );

    if (toolsToResume.size === 0) {
      return;
    }

    for (let i = events.length - 2; i >= 0; i--) {
      const event = events[i];
      const functionCalls = getFunctionCalls(event);
      if (!functionCalls || functionCalls.length === 0) {
        continue;
      }

      const hasMatchingCall = functionCalls.some((call) =>
        call.id ? toolsToResume.has(call.id) : false,
      );

      if (hasMatchingCall) {
        const canonicalTools = await agent.canonicalTools(
          new ReadonlyContext(invocationContext),
        );
        const toolsDict: Record<string, BaseTool> = {};
        for (const tool of canonicalTools) {
          toolsDict[tool.name] = tool;
        }

        const functionResponseEvent = await handleFunctionCallsAsync({
          invocationContext,
          functionCallEvent: event,
          toolsDict,
          beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
          afterToolCallbacks: agent.canonicalAfterToolCallbacks,
          filters: toolsToResume,
        });

        if (functionResponseEvent) {
          yield functionResponseEvent;
        }
        return;
      }
    }
  }
}

export const AUTH_PREPROCESSOR = new AuthPreprocessor();
