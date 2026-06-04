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
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'tests/e2e/.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({path: envPath});
    }
  }

  const hasRequiredEnv =
    !!process.env.GOOGLE_CLOUD_PROJECT && !!process.env.GOOGLE_CLOUD_LOCATION;

  it.skipIf(!hasRequiredEnv)(
    'should try to fetch a non-existent skill and fail with 404/403 from GCP',
    async () => {
      const registry = new GCPSkillRegistry();

      try {
        await registry.getSkill({name: 'non-existent-skill-12345'});
        expect.fail('Should have thrown an error');
      } catch (error: unknown) {
        const err = error as {status?: number};
        expect(err.status).toBeDefined();
        expect([403, 404]).toContain(err.status);
      }
    },
    20000,
  );
});
