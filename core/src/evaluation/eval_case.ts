/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionCall,
  FunctionResponse,
  GroundingMetadata,
  Part,
} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {AppDetails} from './app_details.js';
import {ConversationScenario} from './conversation_scenarios.js';
import {Rubric} from './eval_rubrics.js';

export type {ConversationScenario} from './conversation_scenarios.js';

const UNSUPPORTED_INTERMEDIATE_DATA = 'Unsupported type for intermediate_data';

const CONVERSATION_XOR_SCENARIO =
  'Exactly one of conversation and conversationScenario must be provided in' +
  ' an EvalCase.';

/**
 * Intermediate data an agent produces on its way to a final answer.
 */
export interface IntermediateData {
  /** Tool use trajectory in chronological order. */
  toolUses?: FunctionCall[];

  /** Tool response trajectory in chronological order. */
  toolResponses?: FunctionResponse[];

  /**
   * Responses that sub-agents emit to convey progress, as `[author, parts]`
   * pairs. These are distinct from the invocation's final response.
   */
  intermediateResponses?: Array<[string, Part[]]>;
}

/**
 * A single point in an agent's invocation: a reply, a tool call, or a tool
 * result. This is a projection of the runtime `Event` for the eval system.
 */
export interface InvocationEvent {
  /** The name of the agent that authored this event. */
  author: string;

  content?: Content;

  /** The grounding metadata the model attached to the event. */
  groundingMetadata?: GroundingMetadata;
}

/** Events that occurred during one invocation. */
export interface InvocationEvents {
  invocationEvents: InvocationEvent[];
}

/**
 * The two shapes an invocation's intermediate steps can take. Recorded eval
 * data uses {@link IntermediateData}; a run replayed from events uses
 * {@link InvocationEvents}.
 */
export type IntermediateDataType = IntermediateData | InvocationEvents;

/** One turn of a conversation, from the user's message to the agent's reply. */
export interface Invocation {
  /** Unique identifier for the invocation. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /** The route the agent took to reach {@link finalResponse}. */
  intermediateData?: IntermediateDataType;

  /** Creation time in seconds since the epoch, for debugging. */
  creationTimestamp?: number;

  /** Rubrics that apply to this invocation only. */
  rubrics?: Rubric[];

  /** Details about the app that served this invocation. */
  appDetails?: AppDetails;
}

/** The state of the session. */
export type SessionState = Record<string, unknown>;

/** Values that initialize the session an eval case runs in. */
export interface SessionInput {
  appName: string;

  userId: string;

  /**
   * A fixed session id for this eval case. Artifacts are keyed by
   * `(appName, userId, sessionId)`, so pinning the id lets a case reach
   * artifacts that were pre-loaded for that session. When unset, a random id
   * is generated per case.
   */
  sessionId?: string;

  /** The state the session starts from. Applied only when creating it. */
  state?: SessionState;

  /**
   * adk-python declares this model `extra="allow"`, so a field it does not
   * name is kept rather than dropped. A caller attaches its own metadata to an
   * eval case this way and reads it back after a round trip.
   */
  [key: string]: unknown;
}

/** A conversation whose user query for each invocation is already written. */
export type StaticConversation = Invocation[];

/** One evaluation case: a conversation plus the session it runs in. */
export interface EvalCase {
  /** Unique identifier for the eval case. */
  evalId: string;

  /**
   * A static conversation between the user and the agent. Exactly one of this
   * and {@link EvalCase.conversationScenario} is set; see
   * {@link validateEvalCase}.
   */
  conversation?: StaticConversation;

  /**
   * A scenario for a simulated user to play out. Exactly one of this and
   * {@link EvalCase.conversation} is set; see {@link validateEvalCase}.
   */
  conversationScenario?: ConversationScenario;

  sessionInput?: SessionInput;

  /** Creation time in seconds since the epoch. */
  creationTimestamp: number;

  /** Rubrics that apply to every invocation in the conversation. */
  rubrics?: Rubric[];

  /** The expected session state at the end of the conversation. */
  finalSessionState?: SessionState;

  /** Extra fields are kept, for the reason given on {@link SessionInput}. */
  [key: string]: unknown;
}

/** A tool call paired with its response, when the response was recorded. */
export type ToolCallAndResponse = [FunctionCall, FunctionResponse | undefined];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOrAbsent(value: unknown): boolean {
  return value === undefined || Array.isArray(value);
}

/** Returns true when the value is a list of invocation events. */
export function isInvocationEvents(value: unknown): value is InvocationEvents {
  return isRecord(value) && Array.isArray(value['invocationEvents']);
}

/** Returns true when the value is recorded intermediate data. */
export function isIntermediateData(value: unknown): value is IntermediateData {
  if (!isRecord(value) || isInvocationEvents(value)) {
    return false;
  }
  return (
    isArrayOrAbsent(value['toolUses']) &&
    isArrayOrAbsent(value['toolResponses']) &&
    isArrayOrAbsent(value['intermediateResponses'])
  );
}

function collectFromEvents<T>(
  events: InvocationEvents,
  selectPart: (part: Part) => T | undefined,
): T[] {
  const collected: T[] = [];
  for (const event of events.invocationEvents) {
    for (const part of event.content?.parts ?? []) {
      const value = selectPart(part);
      if (value) {
        collected.push(value);
      }
    }
  }
  return collected;
}

function unsupportedIntermediateData(value: unknown): InputValidationError {
  return new InputValidationError(
    `${UNSUPPORTED_INTERMEDIATE_DATA} \`${String(value)}\``,
  );
}

/**
 * Returns every tool call recorded in the given intermediate data, in order.
 *
 * @throws {InputValidationError} If the value is neither
 *   {@link IntermediateData} nor {@link InvocationEvents}.
 */
export function getAllToolCalls(intermediateData?: unknown): FunctionCall[] {
  if (!intermediateData) {
    return [];
  }
  if (isInvocationEvents(intermediateData)) {
    return collectFromEvents(intermediateData, (part) => part.functionCall);
  }
  if (isIntermediateData(intermediateData)) {
    return intermediateData.toolUses ?? [];
  }
  throw unsupportedIntermediateData(intermediateData);
}

/**
 * Returns every tool response recorded in the given intermediate data, in
 * order.
 *
 * @throws {InputValidationError} If the value is neither
 *   {@link IntermediateData} nor {@link InvocationEvents}.
 */
export function getAllToolResponses(
  intermediateData?: unknown,
): FunctionResponse[] {
  if (!intermediateData) {
    return [];
  }
  if (isInvocationEvents(intermediateData)) {
    return collectFromEvents(intermediateData, (part) => part.functionResponse);
  }
  if (isIntermediateData(intermediateData)) {
    return intermediateData.toolResponses ?? [];
  }
  throw unsupportedIntermediateData(intermediateData);
}

/**
 * Pairs every tool call with the response that carries the same id.
 *
 * A call with no recorded response is paired with `undefined`. When two
 * responses share one id, the later response wins.
 *
 * @throws {InputValidationError} If the value is neither
 *   {@link IntermediateData} nor {@link InvocationEvents}.
 */
export function getAllToolCallsWithResponses(
  intermediateData?: unknown,
): ToolCallAndResponse[] {
  const responsesByCallId = new Map<string | undefined, FunctionResponse>();
  for (const response of getAllToolResponses(intermediateData)) {
    responsesByCallId.set(response.id, response);
  }
  return getAllToolCalls(intermediateData).map(
    (call): ToolCallAndResponse => [call, responsesByCallId.get(call.id)],
  );
}

/**
 * Checks the invariant an {@link EvalCase} must hold: exactly one of
 * `conversation` and `conversationScenario` is set. An empty `conversation`
 * array counts as set.
 *
 * adk-python enforces this in the model validator that runs when an `EvalCase`
 * is constructed. `EvalCase` is a plain interface here, so a caller applies the
 * check to a value it has built or loaded.
 *
 * @throws {InputValidationError} If both are set, or neither is.
 */
export function validateEvalCase(evalCase: EvalCase): void {
  const hasConversation = evalCase.conversation !== undefined;
  const hasScenario = evalCase.conversationScenario !== undefined;
  if (hasConversation === hasScenario) {
    throw new InputValidationError(CONVERSATION_XOR_SCENARIO);
  }
}
