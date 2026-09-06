/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Translates Antigravity trajectory steps into ADK events.
 *
 * Kept separate from the agent wrapper so the mapping rules stay readable and
 * independently testable.
 *
 * Scope: model text (final and, in SSE streaming mode, partial thinking and
 * text deltas), function calls, function responses, and {@link finalModelText}
 * for reading an event's text back out.
 *
 * A client-side tool's result never reaches the trajectory; it arrives through
 * the post-tool-call hook instead, which is why {@link drainToolResults} is
 * also called once at the end of a turn.
 *
 * TODO: Surface SYSTEM_MESSAGE steps (emitted on turn cancellation) as ADK
 * events; they are currently dropped.
 */

import {Part} from '@google/genai';

import {InvocationContext} from '../../agents/invocation_context.js';
import {createEvent, Event} from '../../events/event.js';
import {
  AntigravityStep,
  AntigravityToolCall,
  AntigravityToolResult,
} from './sdk_types.js';
import {ToolResultBuffer} from './tool_result_capture.js';

/** The correlation fields every converted event carries. */
interface EventCorrelation {
  /** The invocation the step belongs to. */
  ctx: InvocationContext;
  /** The ADK agent name to stamp on model-authored events. */
  author: string;
}

/** The per-turn state the converter reads and updates. */
interface TurnState {
  /**
   * Ids of tool calls already emitted, mutated in place to deduplicate calls
   * repeated across step transitions.
   */
  seenToolCalls: Set<string>;
  /**
   * Ids of tool results already emitted, mutated in place to deduplicate
   * results repeated across step transitions.
   */
  seenToolResults: Set<string>;
  /**
   * This conversation's client-tool outcomes, or `undefined` when no capture
   * hook was registered.
   */
  toolResults?: ToolResultBuffer;
}

/** Options for {@link convertStepToEvents}. */
export interface ConvertStepOptions extends EventCorrelation, TurnState {
  /**
   * Whether the run is in SSE mode, in which case incremental thinking and text
   * deltas are also emitted as partial events.
   */
  streaming?: boolean;
}

/** Options for {@link drainToolResults}. */
export interface DrainToolResultsOptions extends TurnState {
  /** The invocation the results belong to. */
  ctx: InvocationContext;
}

/** A stable tool-call id, synthesized when the SDK omits one. */
function buildToolCallId(
  step: AntigravityStep,
  call: AntigravityToolCall,
): string {
  return call.id || `${step.stepIndex ?? 0}-${call.name}`;
}

/** Builds a partial model event carrying a single streamed delta part. */
function partialEvent({ctx, author}: EventCorrelation, part: Part): Event {
  return createEvent({
    invocationId: ctx.invocationId,
    author,
    branch: ctx.branch,
    content: {role: 'model', parts: [part]},
    partial: true,
  });
}

/**
 * Converts a model step's incremental deltas into partial events.
 *
 * Only called in SSE streaming mode. `thinkingDelta` and `contentDelta` are
 * independent (a step may carry either or both); thinking is emitted first,
 * matching the SDK's own chunk ordering.
 */
function convertPartialDeltas(
  step: AntigravityStep,
  correlation: EventCorrelation,
): Event[] {
  if (step.source !== 'MODEL') {
    return [];
  }

  const events: Event[] = [];
  if (step.thinkingDelta) {
    events.push(
      partialEvent(correlation, {text: step.thinkingDelta, thought: true}),
    );
  }
  if (step.contentDelta) {
    events.push(partialEvent(correlation, {text: step.contentDelta}));
  }
  return events;
}

/**
 * Converts a completed model text response into one final model text event.
 *
 * The SDK re-broadcasts the cumulative `content` on every step transition as
 * the response grows, so emitting on each transition would record the same
 * message many times. Only a step with `isCompleteResponse` set is emitted,
 * carrying the final cumulative `content`. Partial streaming is handled
 * separately by {@link convertPartialDeltas}.
 */
function convertModelText(
  step: AntigravityStep,
  {ctx, author}: EventCorrelation,
): Event[] {
  const stepType = step.type ?? 'UNKNOWN';
  const isModelText =
    step.source === 'MODEL' &&
    (stepType === 'TEXT_RESPONSE' || stepType === 'UNKNOWN');
  if (!isModelText || !step.isCompleteResponse || !step.content) {
    return [];
  }

  return [
    createEvent({
      invocationId: ctx.invocationId,
      author,
      branch: ctx.branch,
      content: {role: 'model', parts: [{text: step.content}]},
    }),
  ];
}

/** Converts model-issued tool calls into model function-call events. */
function convertFunctionCalls(
  step: AntigravityStep,
  {ctx, author}: EventCorrelation,
  seenToolCalls: Set<string>,
): Event[] {
  if (step.source !== 'MODEL' || !step.toolCalls?.length) {
    return [];
  }

  const events: Event[] = [];
  for (const call of step.toolCalls) {
    const callId = buildToolCallId(step, call);
    if (seenToolCalls.has(callId)) {
      continue;
    }
    seenToolCalls.add(callId);

    events.push(
      createEvent({
        invocationId: ctx.invocationId,
        author,
        branch: ctx.branch,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: call.name,
                args: call.args ?? {},
                id: callId,
              },
            },
          ],
        },
      }),
    );
  }
  return events;
}

/** Builds the ADK event recording one tool's answer to one call. */
function functionResponseEvent(
  ctx: InvocationContext,
  name: string,
  callId: string,
  response: Record<string, unknown>,
): Event {
  return createEvent({
    invocationId: ctx.invocationId,
    // The author is the tool name so session history attributes the response to
    // the tool, mirroring ADK's own function-response events.
    author: name,
    branch: ctx.branch,
    content: {
      role: 'user',
      parts: [{functionResponse: {name, id: callId, response}}],
    },
  });
}

/**
 * Returns the `FunctionResponse.response` object for one captured result.
 *
 * The harness hands a client tool's value back as a JSON string, so it usually
 * needs unwrapping; text that is not JSON is wrapped rather than raising.
 */
function bufferedResultPayload(
  result: AntigravityToolResult,
): Record<string, unknown> {
  if (result.error) {
    return {error: result.error};
  }

  let value = result.result;
  if (typeof value === 'string') {
    value = parseJsonOrKeep(value);
  }
  if (isPlainObject(value)) {
    return value;
  }
  return {result: value === null || value === undefined ? 'success' : value};
}

/** Parses `text` as JSON, returning it unchanged when it is not JSON. */
function parseJsonOrKeep(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Whether `value` can be used as a `FunctionResponse.response` as it stands. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts completed tool-execution steps into function-response events. */
function convertFunctionResponses(
  step: AntigravityStep,
  ctx: InvocationContext,
  state: TurnState,
): Event[] {
  const status = step.status ?? 'UNKNOWN';
  const isToolResponse =
    step.type === 'TOOL_CALL' && (status === 'DONE' || status === 'ERROR');
  if (!isToolResponse) {
    return [];
  }

  // A client-side tool: the SDK blanks its `toolCalls` and a step has no field
  // for a result, so the step names nothing and holds nothing.
  if (!step.toolCalls?.length) {
    return drainToolResults({ctx, ...state});
  }

  // The hook fires for these tools too, but its copy is keyed by an id this
  // side never sees: the SDK gives a builtin's call id the step id, while the
  // hook is handed the model's own call id. That copy therefore cannot be
  // dropped by id here — and need not be: the same mismatch keeps it out of
  // `drainToolResults`, which only takes ids in `seenToolCalls`. The turn
  // clears the buffer at its end.
  const events: Event[] = [];
  for (const call of step.toolCalls) {
    const callId = buildToolCallId(step, call);
    if (state.seenToolResults.has(callId)) {
      continue;
    }
    state.seenToolResults.add(callId);

    const response =
      status === 'ERROR'
        ? {
            error:
              step.error || `Tool call execution failed with status ${status}.`,
          }
        : {result: step.content || 'success'};

    events.push(functionResponseEvent(ctx, call.name, callId, response));
  }
  return events;
}

/**
 * Answers emitted calls that have a captured outcome and no response yet.
 *
 * @param options.ctx The active invocation context, for event correlation.
 * @param options.seenToolCalls Ids of calls already emitted. Read to decide
 *     what may be answered; not mutated.
 * @param options.seenToolResults Ids of results already emitted, mutated in
 *     place to record the ones answered here.
 * @param options.toolResults This conversation's client-tool outcomes, or
 *     `undefined` when no capture hook was registered, in which case nothing is
 *     answered. Drained of every id this call answers.
 * @returns One function-response event per answered call, in the order the
 *     tools finished in. Empty when nothing is owed a response.
 */
export function drainToolResults({
  ctx,
  seenToolCalls,
  seenToolResults,
  toolResults,
}: DrainToolResultsOptions): Event[] {
  if (!toolResults) {
    return [];
  }

  // A response may not precede the call it answers, hence `seenToolCalls`.
  const answerable = new Set(
    [...seenToolCalls].filter((callId) => !seenToolResults.has(callId)),
  );

  const events: Event[] = [];
  for (const [callId, result] of toolResults.take(answerable)) {
    seenToolResults.add(callId);
    events.push(
      functionResponseEvent(
        ctx,
        result.name,
        callId,
        bufferedResultPayload(result),
      ),
    );
  }
  return events;
}

/**
 * Translates one Antigravity step into the ADK events it maps to.
 *
 * @param step A step from `conversation.receiveSteps()`.
 * @param options The correlation fields, the turn's dedup state, and whether
 *     the run is streaming.
 * @returns The ADK events the step maps to, in emission order. Partial deltas
 *     precede the final aggregated text event. May be empty for steps carrying
 *     no user-visible content, such as compaction.
 */
export function convertStepToEvents(
  step: AntigravityStep,
  options: ConvertStepOptions,
): Event[] {
  const {ctx, author, seenToolCalls, seenToolResults, toolResults, streaming} =
    options;
  const correlation: EventCorrelation = {ctx, author};
  return [
    ...(streaming ? convertPartialDeltas(step, correlation) : []),
    ...convertModelText(step, correlation),
    ...convertFunctionCalls(step, correlation, seenToolCalls),
    ...convertFunctionResponses(step, ctx, {
      seenToolCalls,
      seenToolResults,
      toolResults,
    }),
  ];
}

/**
 * Returns an event's user-visible model text, or `undefined` if it carries
 * none.
 *
 * Partials and thought or function parts never count.
 *
 * @param event The event to inspect.
 * @param author If given, only this ADK agent's own events count. A composite
 *     ADK agent authors its events under its sub-agents' names, so leave this
 *     unset to accept whatever the ADK agent tree produced.
 * @returns The user-visible text, its parts joined with newlines as
 *     `AgentTool` does, or `undefined` if the event carries none.
 */
export function finalModelText(
  event: Event,
  author?: string,
): string | undefined {
  if (event.partial || !event.content) {
    return undefined;
  }
  if (author !== undefined && event.author !== author) {
    return undefined;
  }
  const chunks: string[] = [];
  for (const part of event.content.parts ?? []) {
    if (
      part.text &&
      !part.thought &&
      !part.functionCall &&
      !part.functionResponse
    ) {
      chunks.push(part.text);
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : undefined;
}
