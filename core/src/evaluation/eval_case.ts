/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {ConversationScenario} from './conversation_scenarios.js';

/**
 * Represents a single invocation.
 *
 * Minimal shape needed by this subsystem (static replay + provider). The full
 * `Invocation` (final response, intermediate data, rubrics, app details) is a
 * separate port.
 */
export interface Invocation {
  /** Unique identifier for the invocation. */
  invocationId: string;

  /** Content provided by the user in this invocation. */
  userContent: Content;
}

/** An ordered list of pre-authored invocations replayed as a conversation. */
export type StaticConversation = Invocation[];

/**
 * Result of evaluating a set of invocations.
 *
 * Minimal shape needed by this subsystem; the full evaluator framework (scores
 * per invocation, rubric scores, statuses) is a separate port.
 */
export interface EvaluationResult {
  /** Overall score, based on each invocation. */
  overallScore?: number;
}

/**
 * A metrics evaluator interface.
 *
 * Used here only as the return type of `UserSimulator.getSimulationEvaluator`.
 * The concrete simulation-quality evaluator is a separate port. (Colocated with
 * the eval-case data models to avoid a standalone type-only module; the full
 * evaluator framework will move it to its own file.)
 */
export interface Evaluator {
  /**
   * Returns an {@link EvaluationResult} for the given invocations.
   *
   * @param actualInvocations Invocations obtained from the agent under test.
   * @param expectedInvocations Optional benchmark/golden invocations.
   * @param conversationScenario Optional scenario for multi-turn conversations.
   */
  evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult>;
}

/**
 * Initializer for an {@link EvalCase}.
 */
export interface EvalCaseInit {
  /** Unique identifier for the eval case. */
  evalId: string;
  /** Pre-authored static conversation to replay. */
  conversation?: StaticConversation;
  /** Scenario driving a simulated conversation. */
  conversationScenario?: ConversationScenario;
}

/**
 * A single evaluation case.
 *
 * Enforces the "exactly one of `conversation` / `conversationScenario`"
 * invariant at construction time (parity with the adk-python `EvalCase`), so
 * consumers such as `UserSimulatorProvider` need no defensive both/neither
 * checks.
 */
export class EvalCase {
  /** Unique identifier for the eval case. */
  readonly evalId: string;

  /** Pre-authored static conversation, if this case replays static turns. */
  readonly conversation?: StaticConversation;

  /** Scenario, if this case drives a simulated conversation. */
  readonly conversationScenario?: ConversationScenario;

  /**
   * Creates an `EvalCase`.
   *
   * @param init The eval-case fields.
   * @throws {Error} If neither or both of `conversation` and
   *     `conversationScenario` are provided.
   */
  constructor(init: EvalCaseInit) {
    const hasConversation = init.conversation !== undefined;
    const hasScenario = init.conversationScenario !== undefined;
    if (hasConversation && hasScenario) {
      throw new Error(
        'Both static invocations and conversation scenario provided in' +
          ' EvalCase. Provide exactly one.',
      );
    }
    if (!hasConversation && !hasScenario) {
      throw new Error(
        'Neither static invocations nor conversation scenario provided in' +
          ' EvalCase. Provide exactly one.',
      );
    }
    this.evalId = init.evalId;
    this.conversation = init.conversation;
    this.conversationScenario = init.conversationScenario;
  }
}
