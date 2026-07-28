/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '../../errors/not_found_error.js';
import {logger} from '../../utils/logger.js';

/**
 * Container for a single behavior of a persona.
 *
 * Parity with the adk-python `UserBehavior`.
 */
export interface UserBehavior {
  /** Name of the `UserBehavior`. */
  name: string;

  /**
   * General description of the expected behavior. Used both in the instructions
   * for the user simulator and in the user-simulator evaluator.
   */
  description: string;

  /**
   * Instructions the user should follow. These are included in the instructions
   * for the user simulator.
   */
  behaviorInstructions: string[];

  /**
   * Rubrics used to evaluate whether the user simulator presents the behavior.
   * If a user response presents any of these violations, the evaluator
   * considers the user-simulator response invalid.
   */
  violationRubrics: string[];
}

/**
 * Container for a persona.
 *
 * Parity with the adk-python `UserPersona`.
 */
export interface UserPersona {
  /**
   * Human-readable identifier for the `UserPersona`. Persona registries refer to
   * this identifier.
   */
  id: string;

  /**
   * Description for the `UserPersona`. Included in the instructions for the user
   * simulator and its verifier.
   */
  description: string;

  /**
   * Behaviors for the persona. Included in the instructions for the user
   * simulator and its verifier.
   */
  behaviors: UserBehavior[];
}

/**
 * Returns a string version of the behavior instructions.
 *
 * Each instruction is rendered as a two-space-indented `* ` bullet, joined with
 * newlines. Ported as a standalone module function (the adk-python instance
 * method uses no instance identity).
 *
 * @param behavior The behavior whose instructions to render.
 * @returns The formatted behavior instructions.
 */
export function getBehaviorInstructionsStr(behavior: UserBehavior): string {
  return behavior.behaviorInstructions.map((i) => `  * ${i}`).join('\n');
}

/**
 * Returns a string version of the violation rubrics.
 *
 * Each rubric is rendered as a two-space-indented `* ` bullet, joined with
 * newlines. Ported as a standalone module function (the adk-python instance
 * method uses no instance identity).
 *
 * @param behavior The behavior whose violation rubrics to render.
 * @returns The formatted violation rubrics.
 */
export function getViolationRubricsStr(behavior: UserBehavior): string {
  return behavior.violationRubrics.map((v) => `  * ${v}`).join('\n');
}

/**
 * A registry for `UserPersona` instances.
 *
 * Parity with the adk-python `UserPersonaRegistry`.
 */
export class UserPersonaRegistry {
  private readonly registry = new Map<string, UserPersona>();

  /**
   * Returns the `UserPersona` associated with the given id.
   *
   * @param personaId The persona id to look up.
   * @returns The registered persona.
   * @throws {NotFoundError} If no persona is registered under `personaId`.
   */
  getPersona(personaId: string): UserPersona {
    const persona = this.registry.get(personaId);
    if (persona === undefined) {
      throw new NotFoundError(`${personaId} not found in registry.`);
    }
    return persona;
  }

  /**
   * Registers a user persona under the given id, overwriting any existing entry.
   *
   * @param personaId The id to register the persona under.
   * @param userPersona The persona to register.
   */
  registerPersona(personaId: string, userPersona: UserPersona): void {
    if (this.registry.has(personaId)) {
      logger.debug(`Updating User Persona for ${personaId}.`);
    }
    this.registry.set(personaId, userPersona);
  }

  /**
   * Returns the list of user personas registered so far.
   *
   * @returns The registered personas.
   */
  getRegisteredPersonas(): UserPersona[] {
    return [...this.registry.values()];
  }
}
