/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

// This sub-port ports the persona *types* only. `UserPersonaRegistry`,
// `getDefaultPersonaRegistry`, and the built-in persona data (which require a
// `NotFoundError` type and a large persona dataset) are delivered by the
// simulation subsystem sub-port.

/**
 * Container for a single behavior that a persona can exhibit.
 */
export const UserBehaviorSchema = z
  .object({
    /** Name of the user behavior. */
    name: z.string(),
    /**
     * General description of the expected behavior. Used both in the
     * instructions for the user simulator and in the user simulator evaluator.
     */
    description: z.string(),
    /**
     * Instructions the user should follow. Included in the instructions for the
     * user simulator.
     */
    behaviorInstructions: z.array(z.string()),
    /**
     * Rubrics used to evaluate whether the user simulator presents the
     * behavior. If a user response presents any of these violations, the
     * evaluator considers the response invalid.
     */
    violationRubrics: z.array(z.string()),
  })
  .strict();

/**
 * Container for a single behavior that a persona can exhibit.
 */
export type UserBehavior = z.infer<typeof UserBehaviorSchema>;

/**
 * Container for a user persona.
 */
export const UserPersonaSchema = z
  .object({
    /**
     * Human readable identifier for the persona. Persona registries refer to
     * this identifier.
     */
    id: z.string(),
    /**
     * Description for the persona. Included in the instructions for the user
     * simulator and its verifier.
     */
    description: z.string(),
    /**
     * Behaviors for the persona. Included in the instructions for the user
     * simulator and its verifier.
     */
    behaviors: z.array(UserBehaviorSchema),
  })
  .strict();

/**
 * Container for a user persona.
 */
export type UserPersona = z.infer<typeof UserPersonaSchema>;

/**
 * Returns the behavior instructions rendered as a bulleted string.
 */
export function getBehaviorInstructionsStr(behavior: UserBehavior): string {
  return behavior.behaviorInstructions.map((i) => `  * ${i}`).join('\n');
}

/**
 * Returns the violation rubrics rendered as a bulleted string.
 */
export function getViolationRubricsStr(behavior: UserBehavior): string {
  return behavior.violationRubrics.map((v) => `  * ${v}`).join('\n');
}
