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
import {isRecord} from '../utils/object_notation_utils.js';
import {AppDetails} from './app_details.js';
import {ConversationScenario} from './conversation_scenarios.js';
// Type-only: `eval_rubrics.ts` imports `EvalCase` and `Invocation` from here,
// and erasing both directions keeps the two modules out of a runtime import
// cycle.
import type {Rubric} from './eval_rubrics.js';

export type {ConversationScenario} from './conversation_scenarios.js';

/**
 * Intermediate data an agent produces on its way to a final answer.
 */
export interface IntermediateData {
  /** Tool use trajectory in chronological order. */
  toolUses: FunctionCall[];

  /** Tool response trajectory in chronological order. */
  toolResponses: FunctionResponse[];

  /**
   * Responses that sub-agents emit to convey progress, as `[author, parts]`
   * pairs. These are distinct from the invocation's final response.
   */
  intermediateResponses: Array<[string, Part[]]>;
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
  /** Unique identifier for the invocation. Defaults to an empty string. */
  invocationId?: string;

  userContent: Content;

  finalResponse?: Content;

  /** The route the agent took to reach {@link finalResponse}. */
  intermediateData?: IntermediateDataType;

  /**
   * Creation time in seconds since the epoch, for debugging. Defaults to 0.
   */
  creationTimestamp?: number;

  /** Rubrics that apply to this invocation alone. */
  rubrics?: Rubric[];

  /** Details about the app that served this invocation. */
  appDetails?: AppDetails;
}

/** The state of the session an eval case runs in. */
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
}

/** A conversation whose user turns are already recorded. */
export type StaticConversation = Invocation[];

/**
 * One evaluation case: a conversation or a conversation scenario, plus the
 * session it runs in.
 *
 * Unknown keys are carried rather than rejected, matching adk-python's
 * `extra="allow"` on this model.
 */
export interface EvalCase {
  /** Unique identifier for the eval case. */
  evalId: string;

  /**
   * A static conversation between the user and the agent. Set this or
   * {@link conversationScenario}, but not both.
   */
  conversation?: StaticConversation;

  /**
   * A scenario a user simulator plays out. Set this or {@link conversation},
   * but not both.
   */
  conversationScenario?: ConversationScenario;

  sessionInput?: SessionInput;

  /** Creation time in seconds since the epoch. Defaults to 0. */
  creationTimestamp?: number;

  /** Rubrics that apply to every invocation of this eval case. */
  rubrics?: Rubric[];

  /** The expected session state at the end of the conversation. */
  finalSessionState?: SessionState;
}

/** A tool call paired with its response, when one was recorded. */
export type ToolCallAndResponse = [FunctionCall, FunctionResponse | undefined];

/** The keys that mark the recorded-trajectory shape of intermediate data. */
const RECORDED_TRAJECTORY_KEYS = [
  'toolUses',
  'toolResponses',
  'intermediateResponses',
] as const;

const CONVERSATION_XOR_MESSAGE =
  'Exactly one of conversation and conversation_scenario must be provided in' +
  ' an EvalCase.';

/** Returns true when the intermediate data is a list of invocation events. */
export function isInvocationEvents(value: unknown): value is InvocationEvents {
  return isRecord(value) && 'invocationEvents' in value;
}

/**
 * Returns true when the intermediate data is a recorded trajectory.
 *
 * This is the structural stand-in for adk-python's `isinstance` check, and the
 * only thing that works for data read from a file. A value qualifies when it
 * carries at least one trajectory key, because adk-python defaults all three.
 * An object carrying none of them — `{}` included — is evidence of neither
 * shape, so it is unsupported, exactly as adk-python rejects a bare `dict`.
 */
export function isIntermediateData(value: unknown): value is IntermediateData {
  return (
    isRecord(value) &&
    !isInvocationEvents(value) &&
    RECORDED_TRAJECTORY_KEYS.some((key) => key in value)
  );
}

function collectFromEvents<T>(
  events: InvocationEvents,
  select: (part: Part) => T | undefined,
): T[] {
  const collected: T[] = [];
  for (const event of events.invocationEvents) {
    for (const part of event.content?.parts ?? []) {
      const selected = select(part);
      if (selected) {
        collected.push(selected);
      }
    }
  }
  return collected;
}

function collectFromIntermediateData<T>(
  intermediateData: IntermediateDataType | undefined,
  selectRecorded: (recorded: IntermediateData) => T[] | undefined,
  selectFromPart: (part: Part) => T | undefined,
): T[] {
  if (!intermediateData) {
    return [];
  }
  if (isIntermediateData(intermediateData)) {
    // adk-python defaults every trajectory list, so data that omits one still
    // reads as a recorded trajectory with that list empty.
    return selectRecorded(intermediateData) ?? [];
  }
  if (isInvocationEvents(intermediateData)) {
    return collectFromEvents(intermediateData, selectFromPart);
  }
  throw new InputValidationError(
    `Unsupported type for intermediate_data \`${String(intermediateData)}\``,
  );
}

/**
 * Returns every tool call recorded in the given intermediate data, in
 * chronological order.
 *
 * @throws {InputValidationError} If the intermediate data is present but is
 *   neither a recorded trajectory nor a list of invocation events.
 */
export function getAllToolCalls(
  intermediateData?: IntermediateDataType,
): FunctionCall[] {
  return collectFromIntermediateData(
    intermediateData,
    (recorded) => recorded.toolUses,
    (part) => part.functionCall,
  );
}

/**
 * Returns every tool response recorded in the given intermediate data, in
 * chronological order.
 *
 * @throws {InputValidationError} If the intermediate data is present but is
 *   neither a recorded trajectory nor a list of invocation events.
 */
export function getAllToolResponses(
  intermediateData?: IntermediateDataType,
): FunctionResponse[] {
  return collectFromIntermediateData(
    intermediateData,
    (recorded) => recorded.toolResponses,
    (part) => part.functionResponse,
  );
}

/**
 * Returns every tool call paired with the response that carries the same id,
 * or with `undefined` when no response matches. When two responses share an
 * id the later one wins.
 *
 * @throws {InputValidationError} If the intermediate data is present but is
 *   neither a recorded trajectory nor a list of invocation events.
 */
export function getAllToolCallsWithResponses(
  intermediateData?: IntermediateDataType,
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
 * Checks that an eval case carries exactly one of {@link EvalCase.conversation}
 * and {@link EvalCase.conversationScenario}, and returns it unchanged.
 *
 * An empty `conversation` array counts as present, so `{evalId, conversation:
 * []}` is valid. This is the port of adk-python's `EvalCase` model validator,
 * which a TypeScript interface cannot carry.
 *
 * @throws {InputValidationError} If both fields are set, or neither is.
 */
export function validateEvalCase(evalCase: EvalCase): EvalCase {
  if (
    (evalCase.conversation === undefined) ===
    (evalCase.conversationScenario === undefined)
  ) {
    throw new InputValidationError(CONVERSATION_XOR_MESSAGE);
  }
  return evalCase;
}
