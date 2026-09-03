/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart} from '@a2a-js/sdk';
import {Content, Part as GenAIPart} from '@google/genai';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../agents/functions.js';
import {InvocationContext, requireAgent} from '../agents/invocation_context.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from '../auth/auth_preprocessor.js';
import {
  Event as AdkEvent,
  createEvent,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {FINISH_TASK_TOOL_NAME} from '../tools/finish_task_tool.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {logger} from '../utils/logger.js';
import {AdkMetadataKeys} from './metadata_converter_utils.js';
import {
  GenAIPartToA2APartConverter,
  toA2APart,
  toA2AParts,
} from './part_converter_utils.js';

export interface UserFunctionCall {
  response: AdkEvent;
  taskId: string;
  contextId: string;
}

/**
 * Returns a UserFunctionCall when the event at `index` contains a
 * FunctionResponse that can be traced back to a preceding FunctionCall event.
 *
 * @param session - The session whose event history to inspect.
 * @param index - Index of the candidate event to examine.
 * @returns The matching `UserFunctionCall`, or `undefined` if the event at
 *   `index` is not a user function-response event or has no preceding call.
 */
export function getUserFunctionCallAt(
  session: Session,
  index: number,
): UserFunctionCall | undefined {
  const events = session.events;
  if (index < 0 || index >= events.length) {
    return undefined;
  }

  const candidate = events[index];
  if (candidate.author !== 'user') {
    return undefined;
  }

  const fnCallId = getFunctionResponseCallId(candidate);
  if (!fnCallId) {
    return undefined;
  }

  for (let i = index - 1; i >= 0; i--) {
    const request = events[i];
    if (!isFunctionCallEvent(request, fnCallId)) {
      continue;
    }

    const metadata = request.customMetadata || {};
    const taskId = (metadata[AdkMetadataKeys.TASK_ID] as string) || '';
    const contextId = (metadata[AdkMetadataKeys.CONTEXT_ID] as string) || '';

    return {
      response: candidate,
      taskId,
      contextId,
    };
  }

  return undefined;
}

/**
 * Checks if an event contains a function call with the given ID.
 *
 * @param event - The event to inspect.
 * @param callId - The function call ID to look for.
 * @returns `true` if a part in the event has a matching `functionCall.id`.
 */
export function isFunctionCallEvent(event: AdkEvent, callId: string): boolean {
  if (!event || !event.content || !event.content.parts) {
    return false;
  }

  return event.content.parts.some(
    (part: GenAIPart) => part.functionCall && part.functionCall.id === callId,
  );
}

/**
 * Finds the first part with a FunctionResponse and returns the call ID.
 *
 * @param event - The event to inspect.
 * @returns The `id` of the first FunctionResponse part, or `undefined` if
 *   none is found.
 */
export function getFunctionResponseCallId(event: AdkEvent): string | undefined {
  if (!event || !event.content || !event.content.parts) {
    return undefined;
  }

  const responsePart = event.content.parts.find(
    (part: GenAIPart) => part.functionResponse,
  );

  return responsePart?.functionResponse?.id;
}

// Top-level keys of a serialized AuthConfig that indicate credential
// material, the shape an adk_request_credential call's arguments (one level
// down, under `authConfig`) and its response (flat) both carry.
const AUTH_CONFIG_SCHEME_KEY = 'authScheme';
const AUTH_CONFIG_CREDENTIAL_KEYS: ReadonlyArray<string> = [
  // camelCase only by design: callers normalise the payload with
  // camelCaseKeys() before these keys are looked up, so the snake_case
  // spellings (raw_auth_credential, exchanged_auth_credential) are covered.
  'rawAuthCredential',
  'exchangedAuthCredential',
];

/**
 * Whether `payload` looks like a serialized AuthConfig carrying credential
 * material. Requires `authScheme` plus at least one credential-bearing
 * field, rather than requiring every field AuthConfig's type declares --
 * a config read back off a function call's args can arrive missing fields
 * its type promises (see credential_response_binding.ts), so requiring all
 * of them would leave a gap for an incomplete-but-still-credential-bearing
 * envelope.
 *
 * NOTE: this check is fail-OPEN, not fail-closed: a payload that doesn't
 * match is forwarded unredacted, not dropped. Ambiguous input is treated as
 * safe to forward, which is the direction that risks a leak, not the
 * direction that risks over-dropping legitimate content.
 */
function payloadIsAuthConfig(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const keys = new Set(Object.keys(payload as Record<string, unknown>));
  if (!keys.has(AUTH_CONFIG_SCHEME_KEY)) {
    return false;
  }
  return AUTH_CONFIG_CREDENTIAL_KEYS.some((key) => keys.has(key));
}

/**
 * Whether a function_call carries credential material.
 *
 * NOTE: fail-open, as above -- an ambiguous call is left unscrubbed.
 */
function isCredentialFunctionCall(functionCall: {
  name?: string;
  args?: unknown;
}): boolean {
  if (functionCall.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return true;
  }
  // A request wraps the AuthConfig in an AuthToolArguments envelope, so the
  // shape has to be read one level down, under `authConfig`. Args are
  // normalised with camelCaseKeys first: generateAuthEvent (the primary,
  // in-tree producer) emits this envelope in snake_case
  // (function_call_id/auth_config), and reading it raw would silently never
  // match that shape.
  const args = camelCaseKeys(functionCall.args);
  if (!args || typeof args !== 'object') {
    return false;
  }
  const authConfig = (args as Record<string, unknown>)['authConfig'];
  return payloadIsAuthConfig(authConfig);
}

/**
 * Whether a function_response carries credential material.
 *
 * NOTE: fail-open, as above -- an ambiguous response is left unscrubbed.
 */
function isCredentialFunctionResponse(functionResponse: {
  name?: string;
  response?: unknown;
}): boolean {
  if (functionResponse.name === REQUEST_CREDENTIAL_FUNCTION_CALL_NAME) {
    return true;
  }
  return payloadIsAuthConfig(camelCaseKeys(functionResponse.response));
}

/**
 * Ids of credential requests the remote peer raised itself. An id that ANY
 * non-peer event also issued a call for is excluded: the peer authors its
 * own session events under its own name (`toAdkEvent` forces
 * `author = this.name`) and controls `functionCall.id` verbatim, so a bare
 * id match -- without checking whether some OTHER event also issued a call
 * for that same id -- would let a peer re-label this agent's own pending
 * credential request as one the peer had asked for, by sending an
 * unrelated reply that happens to carry a function_call part whose id
 * collides with it.
 */
export function peerRequestedCallIds(
  events: readonly AdkEvent[],
  peerName: string,
): ReadonlySet<string> {
  const peer = new Set<string>();
  const local = new Set<string>();
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const id = part.functionCall?.id;
      if (!id || id.startsWith(TOOLSET_AUTH_CREDENTIAL_ID_PREFIX)) {
        // A request this agent raised for its own transport credential is
        // authored under this agent's name, so it would otherwise read as one
        // the peer asked for. The peer never sees that credential: it travels
        // as an HTTP header, and forwarding it as message content would put it
        // in the peer's own session.
        continue;
      }
      (event.author === peerName ? peer : local).add(id);
    }
  }
  return new Set([...peer].filter((id) => !local.has(id)));
}

/**
 * Returns `content` with any credential-bearing function_call or
 * function_response part removed, except a function_response whose id is
 * in `peerRequestedIds` -- that credential was requested BY the remote
 * peer, so withholding it would silently strand the peer's pending request
 * forever with nothing logged to explain why. Every other credential-
 * bearing part is a request this local agent raised for its own tools, or
 * an answer to one, and must never cross the trust boundary to the peer.
 *
 * The peer-requested exception only applies when the peer's own request
 * event was authored under a non-'user' role: `messageToAdkEvent` sets
 * `author: msg.role === 'user' ? 'user' : agentName`, so a peer that sends
 * its own `adk_request_credential` inside a `role: 'user'` message is
 * classified the same as a local request, and its answer is withheld --
 * the handshake stalls (logged via the drop warning below, not silent),
 * rather than leaking. Nothing in the A2A spec obliges a peer to use a
 * non-user role.
 *
 * An adk_request_credential call carries a serialized AuthConfig in its
 * arguments -- including rawAuthCredential, an OAuth2 client secret or a
 * service account key -- and its response carries the exchanged credential
 * back (an API key, bearer token, or exchanged OAuth token). Forwarding
 * either to a remote A2A peer would leak that credential material outside
 * the trust boundary it was issued within.
 */
function withoutCredentialParts(
  content: Content | undefined,
  peerRequestedIds: ReadonlySet<string>,
): Content | undefined {
  if (!content || !content.parts) {
    return content;
  }

  const isDroppedCredentialPart = (part: GenAIPart): boolean => {
    if (part.functionCall && isCredentialFunctionCall(part.functionCall)) {
      return true;
    }
    if (
      part.functionResponse &&
      isCredentialFunctionResponse(part.functionResponse)
    ) {
      const id = part.functionResponse.id;
      return !(id && peerRequestedIds.has(id));
    }
    return false;
  };

  const parts = content.parts.filter((part) => !isDroppedCredentialPart(part));
  if (parts.length === content.parts.length) {
    return content;
  }
  logger.warn(
    `Dropped ${content.parts.length - parts.length} credential-bearing ` +
      'part(s) before forwarding to the remote peer -- it did not request them.',
  );
  return {...content, parts};
}

/**
 * Converts genai parts to A2A parts for forwarding to the remote peer,
 * scrubbing credential material the peer did not itself request.
 *
 * NOT the single point both session-forwarding paths converge on:
 * `toMissingRemoteSessionParts` calls `withoutCredentialParts` directly,
 * since it has to interleave `presentAsUserMessage` between the scrub and
 * `toA2AParts`. The shared guarantee lives one level down, in
 * `withoutCredentialParts` -- a third path calling `toA2AParts` directly
 * would still bypass it.
 */
export function toForwardableA2AParts(
  content: Content | undefined,
  longRunningToolIds: string[] | undefined,
  peerRequestedIds: ReadonlySet<string>,
  converter: GenAIPartToA2APartConverter = toA2APart,
): A2APart[] {
  const scrubbed = withoutCredentialParts(content, peerRequestedIds);
  if (!scrubbed?.parts) {
    return [];
  }
  return toA2AParts(scrubbed.parts, longRunningToolIds, converter);
}

/**
 * The arguments of the most recent `finish_task` call in the session.
 *
 * @param session - The session whose history to search.
 * @param isolationScope - Restricts the search to one task's events.
 * @param completedEvent - The terminal `finish_task` response, when there is
 *   one. Its response id picks out the matching call, so a task that called
 *   `finish_task` more than once resolves to the call that actually completed.
 * @returns The call arguments, or `undefined` when there is no matching call.
 */
export function findFinishTaskArgsFromHistory(
  session: Session,
  isolationScope?: string,
  completedEvent?: AdkEvent,
): Record<string, unknown> | undefined {
  const matchingCallId = completedEvent
    ? getFunctionResponses(completedEvent).find(
        (fr) => fr.name === FINISH_TASK_TOOL_NAME,
      )?.id
    : undefined;

  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i];
    if (isolationScope && event.isolationScope !== isolationScope) {
      continue;
    }
    for (const call of getFunctionCalls(event)) {
      if (call.name !== FINISH_TASK_TOOL_NAME) {
        continue;
      }
      if (matchingCallId !== undefined && call.id !== matchingCallId) {
        continue;
      }
      return {...(call.args ?? {})};
    }
  }
  return undefined;
}

/** Options for {@link toMissingRemoteSessionParts}. */
export interface MissingRemoteSessionPartsOptions {
  /** Per-part conversion for the outgoing message. Defaults to `toA2APart`. */
  converter?: GenAIPartToA2APartConverter;
  /**
   * Task mode: the isolation scope of the delegated task. The walk is
   * restricted to it, so one task never sees another task's history.
   */
  taskScope?: string;
  /**
   * Send the whole session to a peer that has not returned a context id. A
   * stateless peer keeps no history of its own, so stopping at its last reply
   * would drop everything before it.
   */
  fullHistoryWhenStateless?: boolean;
}

/**
 * Returns A2A content parts for all events not yet seen by the remote agent,
 * along with the A2A context ID found in the most recent remote agent event.
 *
 * @param ctx - The current invocation context, used to identify the remote
 *   agent's authored events.
 * @param session - The local session whose event history to diff.
 * @param options - Converter, task scope and stateless-history behaviour.
 * @returns An object with the missing `parts` and an optional `contextId`.
 * @throws If a task scope names a FunctionCall that is not in the history.
 */
export function toMissingRemoteSessionParts(
  ctx: InvocationContext,
  session: Session,
  options: MissingRemoteSessionPartsOptions = {},
): {parts: A2APart[]; contextId?: string} {
  const {
    converter = toA2APart,
    taskScope,
    fullHistoryWhenStateless = false,
  } = options;
  const events = session.events;
  const peerName = requireAgent(ctx).name;
  let contextId: string | undefined = undefined;
  const eventsToProcess: AdkEvent[] = [];
  let foundBoundary = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];

    if (taskScope && event.isolationScope !== taskScope) {
      // The coordinator's FunctionCall that triggered this task carries the
      // task's inputs, and nothing older belongs to this task's lifetime.
      if (getFunctionCalls(event).some((fc) => fc.id === taskScope)) {
        eventsToProcess.push(event);
        foundBoundary = true;
        break;
      }
      continue;
    }

    if (isRemoteResponse(event, peerName, taskScope !== undefined)) {
      contextId = readContextId(event) ?? contextId;
      // A stateful peer already holds this history in its own session. A
      // stateless one (no context id) needs it resent when the caller asks.
      if (!fullHistoryWhenStateless || contextId) {
        foundBoundary = true;
        break;
      }
    }
    eventsToProcess.push(event);
  }

  if (taskScope && !foundBoundary) {
    throw new Error(
      `RemoteA2aAgent '${peerName}' in task mode could not find the triggering` +
        ` FunctionCall for isolation scope '${taskScope}' in session history.` +
        ' Workflow path scopes are not supported.',
    );
  }

  const peerRequestedIds = peerRequestedCallIds(events, peerName);
  const remoteCallIds = peerIssuedCallIds(events, peerName, taskScope);
  const missingParts: A2APart[] = [];

  for (const original of eventsToProcess.reverse()) {
    let event = original;

    // Scrub before presentAsUserMessage, not after: it renders a
    // function_call/function_response as text with its arguments inlined,
    // which would embed the secret in a string no shape check can catch.
    const scrubbedContent = withoutCredentialParts(
      event.content,
      peerRequestedIds,
    );
    if (scrubbedContent !== event.content) {
      event = {...event, content: scrubbedContent};
    }

    const isUserInput = event.author === 'user';
    if (!isUserInput && event.author !== peerName) {
      event = presentAsUserMessage(ctx, event);
    }

    for (const part of event.content?.parts ?? []) {
      const converted = toForwardedParts(part, {
        converter,
        taskScope,
        remoteCallIds,
      });
      if (converted.length === 0) {
        logger.warn(`Failed to convert part to A2A format: ${part}`);
        continue;
      }
      if (isUserInput) {
        for (const a2aPart of converted) {
          a2aPart.metadata = {...a2aPart.metadata, is_user_input: true};
        }
      }
      missingParts.push(...converted);
    }
  }

  return {
    parts: missingParts,
    contextId,
  };
}

/**
 * Whether an event is a reply the remote peer produced, and therefore already
 * present in a stateful peer's own session.
 */
function isRemoteResponse(
  event: AdkEvent,
  peerName: string,
  taskMode: boolean,
): boolean {
  if (event.author === peerName) {
    return true;
  }
  // In task mode the delegation also completes through a function response
  // named after the peer, synthesized by the coordinator.
  return (
    taskMode && getFunctionResponses(event).some((fr) => fr.name === peerName)
  );
}

/** The A2A context id an event carries, if it carries one. */
function readContextId(event: AdkEvent): string | undefined {
  const contextId = event.customMetadata?.[AdkMetadataKeys.CONTEXT_ID];
  return typeof contextId === 'string' ? contextId : undefined;
}

/**
 * The ids of function calls the peer issued itself, within the task scope when
 * there is one. A function response answering one of these resumes a call the
 * peer made; anything else belongs to someone else's call.
 */
function peerIssuedCallIds(
  events: readonly AdkEvent[],
  peerName: string,
  taskScope?: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.author !== peerName) {
      continue;
    }
    if (taskScope && event.isolationScope !== taskScope) {
      continue;
    }
    for (const call of getFunctionCalls(event)) {
      if (call.id) {
        ids.add(call.id);
      }
    }
  }
  return ids;
}

/** Context {@link toForwardedParts} needs to decide how to send one part. */
interface ForwardedPartOptions {
  converter: GenAIPartToA2APartConverter;
  taskScope?: string;
  remoteCallIds: ReadonlySet<string>;
}

/** Converts one GenAI part into the A2A parts that carry it to the peer. */
function toForwardedParts(
  part: GenAIPart,
  {converter, taskScope, remoteCallIds}: ForwardedPartOptions,
): A2APart[] {
  const callId = part.functionCall?.id;
  if (
    taskScope &&
    callId &&
    callId !== taskScope &&
    !remoteCallIds.has(callId)
  ) {
    // A sibling call the coordinator made for another tool or agent.
    return [];
  }

  const response = part.functionResponse;
  if (taskScope && response && !remoteCallIds.has(response.id ?? '')) {
    // The peer has no invocation to resume for a call it never made, and the
    // receiving runner rejects a function response alongside the same history
    // as text.
    return [
      {
        kind: 'text',
        text: `Tool ${response.name} returned: ${JSON.stringify(response.response)}`,
      },
    ];
  }

  return toA2AParts([part], undefined, converter);
}

/**
 * Wraps an agent event as a user message so it can be sent as context to a
 * remote agent that only accepts user-role messages.
 *
 * @param ctx - The current invocation context.
 * @param agentEvent - The agent-authored event to reframe as a user message.
 * @returns A new event with `author: 'user'` whose parts summarise the
 *   original agent event's text, function calls, and function responses.
 */
export function presentAsUserMessage(
  ctx: InvocationContext,
  agentEvent: AdkEvent,
): AdkEvent {
  const event = createEvent({
    author: 'user',
    invocationId: ctx.invocationId,
  });

  if (!agentEvent.content || !agentEvent.content.parts) {
    return event;
  }

  const parts: GenAIPart[] = [{text: 'For context:'}];

  for (const part of agentEvent.content.parts) {
    if (part.thought) {
      continue;
    }

    if (part.text) {
      parts.push({
        text: `[${agentEvent.author}] said: ${part.text}`,
      });
    } else if (part.functionCall) {
      const call = part.functionCall;
      parts.push({
        text: `[${agentEvent.author}] called tool ${call.name} with parameters: ${JSON.stringify(call.args)}`,
      });
    } else if (part.functionResponse) {
      const resp = part.functionResponse;
      parts.push({
        text: `[${agentEvent.author}] ${resp.name} tool returned result: ${JSON.stringify(resp.response)}`,
      });
    } else {
      parts.push(part);
    }
  }

  if (parts.length > 1) {
    event.content = {
      role: 'user',
      parts,
    };
  }

  return event;
}
