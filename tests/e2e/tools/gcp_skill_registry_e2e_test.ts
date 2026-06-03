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

describe('GCPSkillRegistry E2E', () => {
  const envPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
  }

  const hasLiveCredentials =
    !!process.env.GOOGLE_CLOUD_PROJECT &&
    !!process.env.GOOGLE_CLOUD_LOCATION &&
    process.env.GCP_LIVE_SKILLS_ENABLED === 'true';

  it.skipIf(!hasLiveCredentials)(
    'performs live search for skills in GCP Skill Registry',
    async () => {
      const registry = new GCPSkillRegistry({
        projectId: process.env.GOOGLE_CLOUD_PROJECT!,
        location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
      });

      // Performs completely unmocked network request to live GCP Vertex AI Skill Registry
      const results = await registry.searchSkills({query: 'test'});
      expect(results).toBeInstanceOf(Array);

      if (results.length > 0) {
        expect(results[0].name).toBeDefined();
        expect(results[0].description).toBeDefined();
      }
    },
    30000,
  );
});
