/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GCPSkillRegistry} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E Live Skill Registry', () => {
  const envPath = path.resolve(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasLiveCredentials =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GCP_LIVE_SKILL_NAME;

  it.skipIf(!hasLiveCredentials)(
    'performs a completely unmocked live connection to GCP Skill Registry and retrieves a skill',
    async () => {
      const registry = new GCPSkillRegistry({
        projectId: process.env.GOOGLE_CLOUD_PROJECT!,
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      });

      // 1. Get the live skill
      const skill = await registry.getSkill({
        name: process.env.GCP_LIVE_SKILL_NAME!,
      });

      expect(skill).toBeDefined();
      expect(skill.frontmatter.name).toBe(process.env.GCP_LIVE_SKILL_NAME);
      expect(skill.instructions).toBeDefined();

      // 2. Search for skills
      const results = await registry.searchSkills({
        query: process.env.GCP_LIVE_SKILL_NAME!,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(
        results.some((s) => s.name === process.env.GCP_LIVE_SKILL_NAME),
      ).toBe(true);
    },
    60000,
  );
});
