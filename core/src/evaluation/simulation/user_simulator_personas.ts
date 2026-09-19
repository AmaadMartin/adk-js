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

/** Renders one prompt bullet per entry: two spaces, an asterisk, the entry. */
function toPromptBullets(entries: string[]): string {
  return entries.map((entry) => `  * ${entry}`).join('\n');
}

/**
 * Renders the behavior instructions as prompt bullets.
 *
 * @param behavior The behavior to read the instructions from.
 * @returns One bullet per instruction, or `''` when there are none.
 */
export function getBehaviorInstructionsStr(behavior: UserBehavior): string {
  return toPromptBullets(behavior.behaviorInstructions);
}

/**
 * Renders the violation rubrics as prompt bullets.
 *
 * @param behavior The behavior to read the rubrics from.
 * @returns One bullet per rubric, or `''` when there are none.
 */
export function getViolationRubricsStr(behavior: UserBehavior): string {
  return toPromptBullets(behavior.violationRubrics);
}

/** An in-process registry of the personas an eval run can simulate. */
export class UserPersonaRegistry {
  // A Map, not a plain object: the ids come from user data, and a Map has no
  // prototype keys for them to collide with.
  private readonly registry = new Map<string, UserPersona>();

  /**
   * Returns the persona registered under an id.
   *
   * @param personaId The id the persona was registered under.
   * @returns The registered persona, by reference.
   * @throws {NotFoundError} When no persona is registered under `personaId`.
   */
  getPersona(personaId: string): UserPersona {
    const persona = this.registry.get(personaId);
    if (persona === undefined) {
      throw new NotFoundError(`${personaId} not found in registry.`);
    }
    return persona;
  }

  /**
   * Registers a persona under an id, replacing any persona already there.
   *
   * The id is the lookup key. It does not have to equal `userPersona.id`, so
   * the same persona can answer to more than one id.
   *
   * @param personaId The id to register the persona under.
   * @param userPersona The persona to register.
   */
  registerPersona(personaId: string, userPersona: UserPersona): void {
    if (this.registry.has(personaId)) {
      logger.debug(`Updating the user persona registered as ${personaId}.`);
    }
    this.registry.set(personaId, userPersona);
  }

  /**
   * Returns the registered personas in registration order.
   *
   * @returns A fresh array. The personas in it are not copied.
   */
  getRegisteredPersonas(): UserPersona[] {
    return [...this.registry.values()];
  }
}
