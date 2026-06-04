/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './skill.js';

/**
 * Interface for a skill registry.
 */
export interface SkillRegistry {
  /**
   * Fetches a skill from the registry.
   * @param params.name The name of the skill.
   * @throws {Error} If the skill does not exist or fails to load.
   */
  getSkill(params: {name: string}): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   * @param params.query The search query.
   */
  searchSkills(params: {query: string}): Promise<Frontmatter[]>;

  /**
   * Returns the description for the search_skills tool.
   */
  searchToolDescription(): string | null;
}
