/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GCPSkillRegistry} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('E2E Live Skill Registry', () => {
  // A true live, unmocked run requires an actual GCP project and active Skill
  const hasLiveCredentials =
    !!process.env['GOOGLE_CLOUD_PROJECT'] &&
    !!process.env['GCP_LIVE_SKILL_NAME'];

  it.skipIf(!hasLiveCredentials)(
    'performs a completely unmocked live connection to GCP Skill Registry to retrieve and search skills',
    async () => {
      const registry = new GCPSkillRegistry({
        projectId: process.env['GOOGLE_CLOUD_PROJECT']!,
        location: process.env['GOOGLE_CLOUD_LOCATION'] || 'us-central1',
      });

      // Test search
      const query = process.env['GCP_LIVE_SKILL_NAME']!;
      const results = await registry.searchSkills({query});
      console.log('Search results:', results);
      expect(results).toBeDefined();

      // Test getSkill
      const skillName = process.env['GCP_LIVE_SKILL_NAME']!;
      const skill = await registry.getSkill({name: skillName});
      console.log('Skill instructions:', skill.instructions);
      expect(skill).toBeDefined();
      expect(skill.frontmatter.name).toBeDefined();
    },
  );
});
