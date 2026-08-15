/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionCall} from '@google/genai';

import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../../events/event.js';
import {ToolConfirmation} from '../../tools/tool_confirmation.js';
import {AsyncQueue} from '../../utils/async_queue.js';
import {isNodeTool} from '../../workflow/nodes/node_tool.js';
import {
  createPlainTextResumeEvents,
  interruptResponseMismatch,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  responseSchemasByInterruptId,
} from '../../workflow/utils/hitl_utils.js';
import {unwrapResponse} from '../../workflow/utils/rehydration_utils.js';
import {handleFunctionCallList} from '../functions.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {ReadonlyContext} from '../readonly_context.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Resumes a {@link NodeTool} call that paused for input. When a node/workflow
 * run inside a node-tool raises a `RequestInput` interrupt, the node-tool's
 * function call is left pending (no response) and the invocation pauses. On the
 * next turn, once the user answers the `adk_request_input` interrupt, this
 * processor re-runs the pending node-tool with the answer(s) threaded as
 * `resumeInputs`, then emits the tool's function response so the agent can
 * continue. Analogous to {@link RequestConfirmationLlmRequestProcessor}.
 */
export class RequestInputLlmRequestProcessor extends BaseLlmRequestProcessor {
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

    // 1. Collect resume inputs (interruptId -> value): prefer structured
    //    `adk_request_input` responses, else map a plain-text reply to any
    //    pending interrupt (so an interactive client can resume by typing).
    const resume = collectResumeInputs(events);
    if (Object.keys(resume.inputs).length === 0) {
      return;
    }

    // 2. Resolve the agent's node-tools.
    const toolsList = await agent.canonicalTools(
      new ReadonlyContext(invocationContext),
    );
    const toolsDict = Object.fromEntries(toolsList.map((t) => [t.name, t]));
    const nodeToolNames = new Set(
      toolsList.filter((t) => isNodeTool(t)).map((t) => t.name),
    );
    if (nodeToolNames.size === 0) {
      return;
    }

    // 3. Find pending node-tool function calls (raised but not yet answered).
    const answeredIds = new Set<string>();
    for (const event of events) {
      for (const fr of getFunctionResponses(event)) {
        if (fr.id) {
          answeredIds.add(fr.id);
        }
      }
    }
    const pending: Record<string, FunctionCall> = {};
    for (const event of events) {
      for (const fc of getFunctionCalls(event)) {
        if (
          fc.id &&
          fc.name &&
          nodeToolNames.has(fc.name) &&
          !answeredIds.has(fc.id)
        ) {
          pending[fc.id] = fc;
        }
      }
    }
    if (Object.keys(pending).length === 0) {
      return;
    }

    // 4. Record each interrupt a typed reply resolved, before the node-tool
    //    re-runs and rehydrates from the session. A structured reply is the
    //    client's own message and is already recorded.
    if (resume.text !== undefined) {
      yield* createPlainTextResumeEvents({
        interruptIds: Object.keys(resume.inputs),
        text: resume.text,
        events,
        invocationId: invocationContext.invocationId,
        branch: invocationContext.branch,
      });
    }

    // 5. Re-run each pending node-tool, threading the resume inputs through the
    //    tool confirmation payload (read by NodeTool as the node's resumeInputs).
    const toolConfirmationDict: Record<string, ToolConfirmation> = {};
    for (const id of Object.keys(pending)) {
      toolConfirmationDict[id] = new ToolConfirmation({
        confirmed: true,
        payload: resume.inputs,
      });
    }

    const eventQueue = new AsyncQueue<Event>();
    invocationContext.eventQueue = eventQueue;
    const task = (async (): Promise<Event | null> => {
      try {
        return await handleFunctionCallList({
          invocationContext,
          functionCalls: Object.values(pending),
          toolsDict,
          beforeToolCallbacks: agent.canonicalBeforeToolCallbacks,
          afterToolCallbacks: agent.canonicalAfterToolCallbacks,
          filters: new Set(Object.keys(pending)),
          toolConfirmationDict,
        });
      } finally {
        eventQueue.close();
      }
    })();
    for await (const queuedEvent of eventQueue) {
      yield queuedEvent;
    }
    const functionResponseEvent = await task;
    invocationContext.eventQueue = undefined;
    if (functionResponseEvent) {
      yield functionResponseEvent;
    }
  }
}

/** The resume inputs a turn supplies, and the typed reply behind them. */
interface ResumeInputs {
  /** interruptId -> the value handed to the waiting node. */
  inputs: Record<string, unknown>;
  /**
   * The text the user typed, when `inputs` came from a plain-text reply.
   * `undefined` for a structured reply, whose own message already records the
   * resolution.
   */
  text?: string;
}

/**
 * Collects resume inputs from the current turn: structured `adk_request_input`
 * function responses take precedence; otherwise a plain-text reply is mapped to
 * every still-pending interrupt id.
 */
function collectResumeInputs(events: Event[]): ResumeInputs {
  const responseSchemas = responseSchemasByInterruptId(events);
  const lastUser = [...events].reverse().find((e) => e.author === 'user');
  const structured = structuredResumeInputs(lastUser, responseSchemas);
  if (structured) {
    return {inputs: structured};
  }

  // Plain-text fallback: map the latest plain-text user turn to pending
  // interrupts (mirrors a workflow root's interactive resume).
  const pending = pendingInterruptIds(events, responseSchemas);
  if (pending.size === 0) {
    return {inputs: {}};
  }
  const parts = lastUser?.content?.parts ?? [];
  const isPlainText =
    parts.length > 0 && parts.every((p) => typeof p.text === 'string');
  if (!isPlainText) {
    return {inputs: {}};
  }
  const text = parts.map((p) => p.text).join('');
  const inputs: Record<string, unknown> = {};
  for (const id of pending) {
    // Read the value back out of the envelope the marker records, so this turn
    // delivers exactly what a later replay of that marker delivers.
    inputs[id] = unwrapResponse({result: text});
  }
  return {inputs, text};
}

/**
 * The structured `adk_request_input` replies the current turn's user event
 * carries, or `undefined` when it carries none.
 *
 * Only that one event is read. An earlier turn's replies already resolved their
 * interrupts, and a typed reply now records a reply of its own, so a backward
 * scan would resume the node with the previous turn's answer.
 *
 * @throws if a reply does not match the schema its interrupt declared. The
 *   reply is the one that just arrived, so the client hears about it once;
 *   later replays skip it in {@link pendingInterruptIds}, leaving the pause
 *   open for the next answer.
 */
function structuredResumeInputs(
  userEvent: Event | undefined,
  responseSchemas: Map<string, unknown>,
): Record<string, unknown> | undefined {
  if (!userEvent) {
    return undefined;
  }
  const structured: Record<string, unknown> = {};
  let found = false;
  for (const fr of getFunctionResponses(userEvent)) {
    if (fr.name !== REQUEST_INPUT_FUNCTION_CALL_NAME || !fr.id) {
      continue;
    }
    const response = unwrapResponse(fr.response);
    const mismatch = interruptResponseMismatch(
      fr.id,
      response,
      responseSchemas.get(fr.id),
    );
    if (mismatch) {
      throw new Error(mismatch);
    }
    structured[fr.id] = response;
    found = true;
  }
  return found ? structured : undefined;
}

/**
 * Interrupt ids raised via `adk_request_input` that have no user response.
 *
 * A reply rejected by its schema does not count as one: it was never handed to
 * the waiting node, so the interrupt is still owed an answer.
 */
function pendingInterruptIds(
  events: Event[],
  responseSchemas: Map<string, unknown>,
): Set<string> {
  const answered = new Set<string>();
  for (const event of events) {
    if (event.author !== 'user') {
      continue;
    }
    for (const fr of getFunctionResponses(event)) {
      if (!fr.id) {
        continue;
      }
      const mismatch = interruptResponseMismatch(
        fr.id,
        unwrapResponse(fr.response),
        responseSchemas.get(fr.id),
      );
      if (!mismatch) {
        answered.add(fr.id);
      }
    }
  }
  const pending = new Set<string>();
  for (const event of events) {
    for (const fc of getFunctionCalls(event)) {
      if (
        fc.name === REQUEST_INPUT_FUNCTION_CALL_NAME &&
        fc.id &&
        !answered.has(fc.id)
      ) {
        pending.add(fc.id);
      }
    }
  }
  return pending;
}

export const REQUEST_INPUT_LLM_REQUEST_PROCESSOR =
  new RequestInputLlmRequestProcessor();
