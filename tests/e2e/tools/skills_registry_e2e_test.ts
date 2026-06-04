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

describe('E2E Live GCP Skill Registry', () => {
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasLiveCredentials = !!process.env.GOOGLE_CLOUD_PROJECT;

  it.skipIf(!hasLiveCredentials)(
    'performs a completely unmocked live search on GCP Skill Registry',
    async () => {
      const registry = new GCPSkillRegistry({
        projectId: process.env.GOOGLE_CLOUD_PROJECT!,
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      });

      const results = await registry.searchSkills('weather');
      expect(results).toBeDefined();
      expect(Array.isArray(results)).toBe(true);
    },
    30000,
  );

  const hasLiveSkill =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GCP_LIVE_SKILL_NAME;

  it.skipIf(!hasLiveSkill)(
    'performs a completely unmocked live fetch of a skill from GCP Skill Registry',
    async () => {
      const registry = new GCPSkillRegistry({
        projectId: process.env.GOOGLE_CLOUD_PROJECT!,
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      });

      const skill = await registry.getSkill(process.env.GCP_LIVE_SKILL_NAME!);
      expect(skill).toBeDefined();
      expect(skill.frontmatter.name).toBe(process.env.GCP_LIVE_SKILL_NAME);
    },
    30000,
  );
});
