/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {TaskState as A2ATaskState, Message, Task} from '@a2a-js/sdk';
import {FunctionResponse as GenAIFunctionResponse} from '@google/genai';
import {createHash} from 'node:crypto';
import {isPausedTaskStatusUpdateEvent} from './a2a_event.js';
import {toGenAIParts} from './part_converter_utils.js';

/** A single human-reviewed action frozen at the moment the task paused. */
export interface PendingAction {
  /** The function-call id the human was asked to approve. */
  id: string;
  /** The function-call name (e.g. `adk_request_confirmation`). */
  name: string;
  /** Stable digest of the call arguments as presented to the human. */
  argsDigest: string;
}

/** The frozen request a paused task is waiting on. */
export interface IntentBinding {
  taskId: string;
  contextId: string;
  /** The paused state the task is in. */
  state: A2ATaskState;
  /** `messageId` of the status message that paused the task, when present. */
  pauseMessageId?: string;
  actions: PendingAction[];
}

/** Why a resume request failed intent verification. */
export enum IntentMismatchReason {
  MISSING_RESPONSE = 'missing_response',
  UNKNOWN_ACTION = 'unknown_action',
  PAYLOAD_MISMATCH = 'payload_mismatch',
  UNSOLICITED_CONTENT = 'unsolicited_content',
}

/** Outcome of verifying a resume message against a frozen intent. */
export interface IntentVerification {
  ok: boolean;
  reason?: IntentMismatchReason;
  /** Human-readable detail, safe to surface in a task-failed message. */
  detail?: string;
}

/** Whether the conversation moved while the task was paused. */
export interface ContextMutation {
  mutatedWhilePaused: boolean;
  /** `messageId`s that landed after the pause, excluding the resume message. */
  messageIdsSincePause: string[];
}

/**
 * The argument key under which a confirmation request carries the call the
 * human is asked to approve.
 */
const ORIGINAL_FUNCTION_CALL_KEY = 'originalFunctionCall';

/**
 * Freezes the action a paused task is waiting on.
 *
 * The binding is derived from the task status message, which the server
 * authored when it paused. It is never derived from the incoming message,
 * which the caller controls.
 *
 * @param task The task to freeze the pending action of.
 * @returns The frozen request, or `undefined` when the task is not paused on a
 *   function call.
 */
export function freezeIntent(task: Task): IntentBinding | undefined {
  if (!isPausedTaskStatusUpdateEvent(task) || !task.status.message) {
    return undefined;
  }

  const actions: PendingAction[] = [];
  for (const part of toGenAIParts(task.status.message.parts)) {
    const functionCall = part.functionCall;
    if (!functionCall?.id) {
      continue;
    }

    actions.push({
      id: functionCall.id,
      name: functionCall.name || '',
      argsDigest: digest(reviewedPayload(functionCall.args)),
    });
  }

  if (actions.length === 0) {
    return undefined;
  }

  return {
    taskId: task.id,
    contextId: task.contextId,
    state: task.status.state,
    pauseMessageId: task.status.message.messageId,
    actions,
  };
}

/**
 * Verifies a resume message against the action frozen when the task paused.
 *
 * Never throws and never mutates its inputs: callers decide what a mismatch
 * means. Detail strings name function-call ids only, so a rejection can be
 * surfaced in a task message without echoing caller-supplied content back.
 *
 * `binding` is the frozen request from {@link freezeIntent}, `userMessage` is
 * the incoming resume message, and `strict` also rejects responses to actions
 * that were never frozen and parts that answer no frozen action.
 *
 * @returns The verification outcome.
 */
export function verifyIntent({
  binding,
  userMessage,
  strict = false,
}: {
  binding: IntentBinding;
  userMessage: Message;
  strict?: boolean;
}): IntentVerification {
  const parts = toGenAIParts(userMessage.parts);
  const responses = new Map<string, GenAIFunctionResponse>();
  for (const part of parts) {
    const functionResponse = part.functionResponse;
    if (functionResponse?.id) {
      responses.set(functionResponse.id, functionResponse);
    }
  }

  for (const action of binding.actions) {
    const response = responses.get(action.id);
    if (!response) {
      return {
        ok: false,
        reason: IntentMismatchReason.MISSING_RESPONSE,
        detail: `no response for action ${action.id}`,
      };
    }

    const echoed = isRecord(response.response)
      ? response.response[ORIGINAL_FUNCTION_CALL_KEY]
      : undefined;
    if (echoed !== undefined && digest(echoed) !== action.argsDigest) {
      return {
        ok: false,
        reason: IntentMismatchReason.PAYLOAD_MISMATCH,
        detail: `action ${action.id} was reviewed with different arguments`,
      };
    }
  }

  if (!strict) {
    return {ok: true};
  }

  const frozenIds = new Set(binding.actions.map((action) => action.id));
  for (const id of responses.keys()) {
    if (!frozenIds.has(id)) {
      return {
        ok: false,
        reason: IntentMismatchReason.UNKNOWN_ACTION,
        detail: `response for action ${id}, which was never requested`,
      };
    }
  }

  for (const part of parts) {
    const isAnswer = part.functionResponse?.id !== undefined;
    const isBlankText = part.text !== undefined && part.text.trim() === '';
    if (isAnswer || isBlankText) {
      continue;
    }

    return {
      ok: false,
      reason: IntentMismatchReason.UNSOLICITED_CONTENT,
      detail: 'resume message carries content that answers no frozen action',
    };
  }

  return {ok: true};
}

/**
 * Reports whether other messages landed on the task while it was paused.
 *
 * @param task The paused task.
 * @param userMessage The incoming resume message, which is not a mutation.
 * @returns The messages that arrived during the pause. An unlocatable pause
 *   message reports no mutation, so a task store that keeps no history does
 *   not report every resume as mutated.
 */
export function detectContextMutation(
  task: Task,
  userMessage: Message,
): ContextMutation {
  const history = task.history || [];
  const pauseMessageId = task.status.message?.messageId;
  const pauseIndex = pauseMessageId
    ? history.findIndex((message) => message.messageId === pauseMessageId)
    : -1;
  if (pauseIndex < 0) {
    return {mutatedWhilePaused: false, messageIdsSincePause: []};
  }

  const messageIdsSincePause = history
    .slice(pauseIndex + 1)
    .map((message) => message.messageId)
    .filter((messageId) => messageId !== userMessage.messageId);

  return {
    mutatedWhilePaused: messageIdsSincePause.length > 0,
    messageIdsSincePause,
  };
}

/**
 * Returns the payload the human reviewed. A confirmation request wraps the
 * reviewed call in `originalFunctionCall`; any other call is reviewed as it
 * stands.
 */
function reviewedPayload(args: unknown): unknown {
  if (isRecord(args) && args[ORIGINAL_FUNCTION_CALL_KEY] !== undefined) {
    return args[ORIGINAL_FUNCTION_CALL_KEY];
  }

  return args;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/**
 * Serialises a value to JSON with object keys sorted at every depth, so that
 * two payloads that differ only in key order produce the same digest.
 */
function canonicalize(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) =>
      isRecord(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([left], [right]) =>
              left < right ? -1 : 1,
            ),
          )
        : entry,
    ) ?? 'null'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
