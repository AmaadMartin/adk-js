/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {NotFoundError} from '../../errors/not_found_error.js';
import {logger} from '../../utils/logger.js';
import {evalModel, type EvalModel} from '../common.js';

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

/** Renders a behavior's instructions as one bulleted block. */
export function behaviorInstructionsToString(behavior: UserBehavior): string {
  return toBulletedList(behavior.behaviorInstructions);
}

/** Renders a behavior's violation rubrics as one bulleted block. */
export function violationRubricsToString(behavior: UserBehavior): string {
  return toBulletedList(behavior.violationRubrics);
}

function toBulletedList(items: string[]): string {
  return items.map((item) => `  * ${item}`).join('\n');
}

/**
 * The personas a user simulator can be asked for by id.
 *
 * A scenario names a persona rather than spelling one out, and the registry
 * turns that name back into the persona. Call
 * {@link getDefaultPersonaRegistry} for the pre-built set.
 */
export class UserPersonaRegistry {
  private readonly personas = new Map<string, UserPersona>();

  /**
   * Returns the persona registered under `personaId`.
   *
   * @throws {NotFoundError} If no persona is registered under that id.
   */
  getPersona(personaId: string): UserPersona {
    const persona = this.personas.get(personaId);
    if (persona === undefined) {
      throw new NotFoundError(`${personaId} not found in registry.`);
    }
    return persona;
  }

  /** Registers a persona under `personaId`, replacing any existing one. */
  registerPersona(personaId: string, userPersona: UserPersona): void {
    if (this.personas.has(personaId)) {
      logger.debug(`Replacing the user persona registered as ${personaId}.`);
    }
    this.personas.set(personaId, userPersona);
  }

  /** Returns every registered persona, in registration order. */
  getRegisteredPersonas(): UserPersona[] {
    return [...this.personas.values()];
  }
}
