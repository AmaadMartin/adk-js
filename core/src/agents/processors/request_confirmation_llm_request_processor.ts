/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';
import {isEqual} from 'lodash-es';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {ToolConfirmation} from '../../tools/tool_confirmation.js';
import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  handleFunctionCallList,
} from '../functions.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Resumes tool calls that were paused for user confirmation. Scans the session
 * event history for pending confirmation responses and re-invokes the
 * corresponding tools before the next LLM turn.
 */
export class RequestConfirmationLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Resumes tool calls that were paused for user confirmation, re-invoking
   * them with the confirmed or denied decision before the next LLM turn.
   *
   * @param invocationContext - The current invocation context, including the
   *   session event history used to locate pending confirmation responses.
   * @yields Function response events for tools that have been confirmed and
   *   are ready to resume.
   */
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

    const requestConfirmationFunctionResponses: {
      [key: string]: ToolConfirmation;
    } = {};

    let confirmationEventIndex = -1;
    // Step 1: Find the FIRST confirmation event authored by user.
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author !== 'user') {
        continue;
      }
      const responses = getFunctionResponses(event);
      if (!responses) {
        continue;
      }

      let foundConfirmation = false;
      for (const functionResponse of responses) {
        if (functionResponse.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
          continue;
        }
        foundConfirmation = true;

        let toolConfirmation = null;

        if (
          functionResponse.response &&
          Object.keys(functionResponse.response).length === 1 &&
          'response' in functionResponse.response
        ) {
          toolConfirmation = JSON.parse(
            functionResponse.response['response'] as string,
          ) as ToolConfirmation;
        } else if (functionResponse.response) {
          toolConfirmation = new ToolConfirmation({
            hint: functionResponse.response['hint'] as string,
            payload: functionResponse.response['payload'],
            confirmed: functionResponse.response['confirmed'] as boolean,
          });
        }

        if (functionResponse.id && toolConfirmation) {
          requestConfirmationFunctionResponses[functionResponse.id] =
            toolConfirmation;
        }
      }
      if (foundConfirmation) {
        confirmationEventIndex = i;
        break;
      }
    }

    // Plain-text fallback: an interactive user (e.g. `adk run`) can approve or
    // deny a pending confirmation by simply typing a reply (yes/no) instead of
    // sending a structured confirmation response. Opt-in only
    // (`runConfig.plainTextToolConfirmation`) so that on a web/API surface an
    // ordinary chat message is never silently reinterpreted as a tool-gate
    // decision — that binding is what the structured path exists to guarantee.
    if (
      Object.keys(requestConfirmationFunctionResponses).length === 0 &&
      invocationContext.runConfig?.plainTextToolConfirmation
    ) {
      const fallback = mapPlainTextConfirmation(events);
      Object.assign(requestConfirmationFunctionResponses, fallback.responses);
      if (fallback.turnIndex >= 0) {
        confirmationEventIndex = fallback.turnIndex;
      }
    }

    if (Object.keys(requestConfirmationFunctionResponses).length === 0) {
      return;
    }

    const historyCalls = indexFunctionCallsById(events);

    // Step 2: Find the system generated FunctionCall event requesting the tool
    // confirmation
    for (let i = confirmationEventIndex - 1; i >= 0; i--) {
      const event = events[i];
      const functionCalls = getFunctionCalls(event);
      if (!functionCalls) {
        continue;
      }

      const candidates = new Map<string, ConfirmationTarget>();

      for (const functionCall of functionCalls) {
        if (
          functionCall.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME ||
          !functionCall.id ||
          !(functionCall.id in requestConfirmationFunctionResponses)
        ) {
          continue;
        }

        const originalFunctionCall = parseOriginalFunctionCall(
          functionCall.args?.['originalFunctionCall'],
        );
        if (!originalFunctionCall) {
          continue;
        }

        candidates.set(originalFunctionCall.id, {
          call: originalFunctionCall,
          confirmation: requestConfirmationFunctionResponses[functionCall.id],
        });
      }
      if (candidates.size === 0) {
        continue;
      }

      // Step 3: Remove the tools that have already been confirmed AND resumed.
      // This runs before validation because the processor re-runs on every LLM
      // step of the turn while the approval stays the last user event: a
      // consumed confirmation must be dropped rather than re-validated against
      // state that has already moved on.
      for (let j = events.length - 1; j > confirmationEventIndex; j--) {
        const eventToCheck = events[j];
        const functionResponses = getFunctionResponses(eventToCheck);
        if (!functionResponses) {
          continue;
        }

        for (const fr of functionResponses) {
          if (fr.id) {
            candidates.delete(fr.id);
          }
        }
        if (candidates.size === 0) {
          break;
        }
      }

      if (candidates.size === 0) {
        continue;
      }

      // Step 4: Validate each confirmation against session history.
      const toolsToResume = resolveConfirmationTargets(
        candidates,
        historyCalls,
        agent.name,
      );
      if (toolsToResume.size === 0) {
        continue;
      }

      const toolsList = await agent.canonicalTools(
        new ReadonlyContext(invocationContext),
      );
      const toolsDict = Object.fromEntries(
        toolsList.map((tool) => [tool.name, tool]),
      );

      const functionResponseEvent = await handleFunctionCallList({
        invocationContext: invocationContext,
        functionCalls: [...toolsToResume.values()].map((target) => target.call),
        toolsDict: toolsDict,
        beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
        afterToolCallbacks: agent.canonicalAfterToolCallbacks,
        filters: new Set(toolsToResume.keys()),
        toolConfirmationDict: Object.fromEntries(
          [...toolsToResume].map(([id, target]) => [id, target.confirmation]),
        ),
      });

      if (functionResponseEvent) {
        // Put the response in the in-memory session before yielding it. The
        // content builder runs immediately behind this processor in the same
        // step and reads `session.events`, while a yielded event only reaches
        // the runner — which is what durably appends it — once the step is
        // done. Without this the model is rebuilt with neither the tool call
        // nor its result in view, and re-issues the call every turn.
        //
        // In memory only, deliberately: the runner appends this same event
        // through the session service, and `VertexAiSessionService` posts to
        // the remote store unconditionally rather than deduping by event id,
        // so appending here too would write it twice on Agent Engine.
        const events = invocationContext.session.events;
        const existing = events.findIndex(
          (e) => e.id === functionResponseEvent.id,
        );
        if (existing >= 0) {
          events[existing] = functionResponseEvent;
        } else {
          events.push(functionResponseEvent);
        }
        yield functionResponseEvent;
      }
      return;
    }
  }
}

/** An `originalFunctionCall` payload proven to carry an id and a name. */
type OriginalFunctionCall = FunctionCall & {id: string; name: string};

/** A tool call waiting to resume, with the decision the user gave for it. */
interface ConfirmationTarget {
  call: FunctionCall;
  confirmation: ToolConfirmation;
}

/** A function call recorded in session history, with the author that made it. */
interface HistoryCall {
  call: FunctionCall;
  author?: string;
}

/** Whether `value` is a plain object rather than an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrows the `originalFunctionCall` payload read off a confirmation call.
 * The payload is client-supplied, so nothing about its shape is assumed.
 *
 * @param value - The raw `originalFunctionCall` entry of the confirmation call.
 * @returns The payload, or `undefined` when it is absent or malformed.
 */
function parseOriginalFunctionCall(
  value: unknown,
): OriginalFunctionCall | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const {id, name, args} = value;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
    return undefined;
  }
  if (args !== undefined && !isRecord(args)) {
    return undefined;
  }
  return {id, name, args};
}

/**
 * Indexes every function call in the session by its id, so a confirmation can
 * be checked against the call the model actually issued. Confirmation requests
 * are excluded: they are never themselves resumable.
 *
 * @param events - The session event history.
 * @returns The last call recorded for each function call id.
 */
function indexFunctionCallsById(events: Event[]): Map<string, HistoryCall> {
  const historyCalls = new Map<string, HistoryCall>();
  for (const event of events) {
    for (const call of getFunctionCalls(event)) {
      if (call.id && call.name !== REQUEST_CONFIRMATION_FUNCTION_CALL_NAME) {
        historyCalls.set(call.id, {call, author: event.author});
      }
    }
  }
  return historyCalls;
}

/**
 * Validates each pending confirmation against session history and returns the
 * calls that may resume, keyed by original function call id. A call authored by
 * another agent is dropped, so that agent's processor resumes it instead.
 *
 * @param candidates - Pending confirmations keyed by original function call id.
 * @param historyCalls - The function calls recorded in the session.
 * @param agentName - The name of the agent running this processor.
 * @returns The confirmations that may resume, carrying the historical call.
 * @throws Error when a payload names a call that is absent from history, or
 *   describes it differently from the way the model issued it.
 */
function resolveConfirmationTargets(
  candidates: Map<string, ConfirmationTarget>,
  historyCalls: Map<string, HistoryCall>,
  agentName: string,
): Map<string, ConfirmationTarget> {
  const targets = new Map<string, ConfirmationTarget>();
  for (const [id, candidate] of candidates) {
    const historyCall = historyCalls.get(id);
    if (!historyCall) {
      throw new Error(
        `Original function call for ID '${id}' not found in session history.`,
      );
    }
    if (historyCall.author !== agentName) {
      continue;
    }
    if (historyCall.call.name !== candidate.call.name) {
      throw new Error(
        `Function call name mismatch for ID '${id}': history has ` +
          `'${historyCall.call.name}', confirmation has ` +
          `'${candidate.call.name}'.`,
      );
    }
    if (!isEqual(historyCall.call.args ?? {}, candidate.call.args ?? {})) {
      // Arguments can carry user data, so the message names only the id.
      throw new Error(`Function call arguments mismatch for ID '${id}'.`);
    }
    // The payload is now proven equal to the historical call on id, name and
    // args. Resuming the historical one keeps payload-only fields off the tool.
    targets.set(id, {
      call: historyCall.call,
      confirmation: candidate.confirmation,
    });
  }
  return targets;
}

/** Words interpreted as an approval when a user confirms by plain text. */
const AFFIRMATIVE = new Set([
  'yes',
  'y',
  'true',
  'approve',
  'approved',
  'ok',
  'okay',
  'confirm',
  'confirmed',
]);

/** Words interpreted as an explicit denial when a user confirms by plain text. */
const NEGATIVE = new Set([
  'no',
  'n',
  'false',
  'reject',
  'rejected',
  'deny',
  'denied',
  'cancel',
  'cancelled',
]);

/**
 * Maps a plain-text user reply to a confirmation for the single pending
 * `adk_request_confirmation` call it is answering, so an interactive user can
 * approve/deny by typing. Deliberately conservative (see the security review on
 * PR #594):
 *
 * - Only the SINGLE most-recent pending confirmation is resolved — never a
 *   broadcast across every unanswered gate in the history.
 * - The plain-text reply must IMMEDIATELY follow the confirmation request (no
 *   intervening user turn), so an unrelated later message can't resolve a stale
 *   gate.
 * - Only recognized affirmative/negative words decide; any other text (a
 *   question, a typo, an answer to something else) is left as NO decision so the
 *   gate stays pending rather than being silently denied.
 *
 * Returns the synthesized confirmation keyed by the confirmation call id, and
 * the index of the plain-text user turn (or -1 when not applicable).
 */
function mapPlainTextConfirmation(events: Event[]): {
  responses: Record<string, ToolConfirmation>;
  turnIndex: number;
} {
  const none = {responses: {}, turnIndex: -1};

  // The reply is the most recent user turn, and only if it is plain text.
  let turnIndex = -1;
  let text = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author !== 'user') {
      continue;
    }
    const parts = event.content?.parts ?? [];
    const isPlainText =
      parts.length > 0 && parts.every((p) => typeof p.text === 'string');
    if (isPlainText) {
      turnIndex = i;
      text = parts.map((p) => p.text).join('');
    }
    break;
  }
  if (turnIndex < 0) {
    return none;
  }

  const answered = new Set<string>();
  for (const event of events) {
    if (event.author !== 'user') {
      continue;
    }
    for (const fr of getFunctionResponses(event)) {
      if (fr.id) {
        answered.add(fr.id);
      }
    }
  }

  // Find the pending confirmation call the reply is answering: scan back from
  // the reply for the most recent unanswered `adk_request_confirmation`, and
  // require it to immediately precede the reply (stop at any other user turn).
  let pendingId: string | undefined;
  for (let i = turnIndex - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author === 'user') {
      break; // another user turn between request and reply -> not immediate
    }
    for (const fc of getFunctionCalls(event)) {
      if (
        fc.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME &&
        fc.id &&
        !answered.has(fc.id)
      ) {
        pendingId = fc.id;
        break;
      }
    }
    if (pendingId) {
      break;
    }
  }
  if (!pendingId) {
    return none;
  }

  const normalized = text.trim().toLowerCase();
  let confirmed: boolean;
  if (AFFIRMATIVE.has(normalized)) {
    confirmed = true;
  } else if (NEGATIVE.has(normalized)) {
    confirmed = false;
  } else {
    return none; // unrecognized -> no decision, leave the gate pending
  }

  return {
    responses: {[pendingId]: new ToolConfirmation({confirmed})},
    turnIndex,
  };
}

export const REQUEST_CONFIRMATION_LLM_REQUEST_PROCESSOR =
  new RequestConfirmationLlmRequestProcessor();
