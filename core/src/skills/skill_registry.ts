/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {type Frontmatter, type Skill} from './skill.js';

export abstract class SkillRegistry {
  /**
   * Fetches a skill from the registry.
   *
   * @param params.name The name of the skill.
   * @returns A Promise resolving to a Skill object.
   * @throws Error If the skill with the specified name does not exist or is invalid.
   */
  abstract getSkill(params: {name: string}): Promise<Skill>;

  /**
   * Searches for skills in the registry.
   *
   * @param params.query The search query.
   * @returns A Promise resolving to a list of Frontmatter objects for discovery.
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
