/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './skill.js';

export interface SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param name The name of the skill.
   * @returns A promise that resolves to the Skill object.
   * @throws {Error} If the skill with the specified name does not exist or fails validation.
   */
  getSkill(name: string): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   *
   * @param query The search query.
   * @returns A promise that resolves to a list of Frontmatter objects for discovery.
   */
  searchSkills(query: string): Promise<Frontmatter[]>;

  /**
   * Returns the description for the search_skills tool.
   *
   * Registries can define this to provide specialized instructions to the model
   * on how to use their specific search capabilities.
   */
  searchToolDescription?(): string | null;
}
