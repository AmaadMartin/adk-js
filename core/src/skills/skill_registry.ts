/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Frontmatter, Skill} from './skill.js';

/**
 * Abstract class for a skill registry.
 */
export abstract class SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param params - Parameters containing the name of the skill.
   * @returns A promise that resolves to the fully loaded Skill object.
   */
  abstract getSkill(params: {name: string}): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   *
   * @param params - Parameters containing the search query.
   * @returns A promise that resolves to a list of skill frontmatters matching the query.
   */
  abstract searchSkills(params: {query: string}): Promise<Frontmatter[]>;

  /**
   * Custom description for the search_skills tool.
   *
   * Registries can define this to provide specialized instructions to the model
   * on how to use their specific search capabilities.
   *
   * @returns The custom description, or null if default description should be used.
   */
  searchToolDescription(): string | null {
    return null;
  }
}
