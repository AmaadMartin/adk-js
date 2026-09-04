/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {NotFoundError} from '../../errors/not_found_error.js';
import {logger} from '../../utils/logger.js';
import {evalModel, type EvalModel} from '../common.js';

/** The prefix every rendered instruction and rubric line carries. */
const LINE_PREFIX = '  * ';

/** One behavior a simulated user follows. */
export interface UserBehavior {
  /** The name of the behavior. */
  name: string;

  /**
   * What the behavior looks like. The user simulator and the simulator's
   * evaluator both read this.
   */
  description: string;

  /** Instructions given to the user simulator. */
  behaviorInstructions: string[];

  /**
   * Rubrics that decide whether the simulator kept to the behavior. A response
   * that violates any of them is not a valid user turn.
   */
  violationRubrics: string[];
}

/** The persona a simulated user adopts. */
export interface UserPersona {
  /** Human readable identifier. A persona registry refers to this id. */
  id: string;

  /** What the persona is. Included in the user simulator's instructions. */
  description: string;

  /** The behaviors that make up the persona. */
  behaviors: UserBehavior[];
}

/** Renders a behavior's instructions as the simulator's prompt shows them. */
export function behaviorInstructionsText(behavior: UserBehavior): string {
  return renderLines(behavior.behaviorInstructions);
}

/** Renders a behavior's violation rubrics as the verifier's prompt shows them. */
export function violationRubricsText(behavior: UserBehavior): string {
  return renderLines(behavior.violationRubrics);
}

function renderLines(lines: string[]): string {
  return lines.map((line) => `${LINE_PREFIX}${line}`).join('\n');
}

/** Validates a {@link UserBehavior} payload. */
export const userBehaviorModel: EvalModel<UserBehavior> = evalModel(
  {
    name: z.string(),
    description: z.string(),
    behaviorInstructions: z.array(z.string()),
    violationRubrics: z.array(z.string()),
  },
  {name: 'UserBehavior'},
);

/** Validates a {@link UserPersona} payload. */
export const userPersonaModel: EvalModel<UserPersona> = evalModel(
  {
    id: z.string(),
    description: z.string(),
    behaviors: z.array(userBehaviorModel.schema),
  },
  {name: 'UserPersona'},
);

/** A set of personas a scenario can name by id. */
export class UserPersonaRegistry {
  private readonly personas = new Map<string, UserPersona>();

  /**
   * Returns the persona registered under `personaId`.
   *
   * @throws {NotFoundError} When no persona holds that id.
   */
  getPersona(personaId: string): UserPersona {
    const persona = this.personas.get(personaId);
    if (persona === undefined) {
      throw new NotFoundError(`${personaId} not found in registry.`);
    }
    return persona;
  }

  /** Registers a persona, replacing any persona already under that id. */
  registerPersona(personaId: string, userPersona: UserPersona): void {
    if (this.personas.has(personaId)) {
      logger.debug(`Replacing the user persona registered under ${personaId}.`);
    }
    this.personas.set(personaId, userPersona);
  }

  /** Returns every persona registered so far. */
  getRegisteredPersonas(): UserPersona[] {
    return [...this.personas.values()];
  }
}
