/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './skill.js';

/**
 * Interface for a skill registry.
 */
export abstract class SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param params.name - The name of the skill.
   * @returns A promise resolving to the Skill.
   */
  abstract getSkill(params: {name: string}): Promise<Skill>;

  /**
   * Searches for matching skills in the registry.
   *
   * @param params.query - The search query.
   * @returns A promise resolving to an array of skill Frontmatter.
   */
  abstract searchSkills(params: {query: string}): Promise<Frontmatter[]>;

  /**
   * Returns the description for the search_skills tool.
   *
   * Registries can define this to provide specialized instructions to the model
   * on how to use their specific search capabilities.
   */
  searchToolDescription(): string | null {
    return null;
  }
}
