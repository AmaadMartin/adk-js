/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {getBigQuerySkill} from '../../../src/tools/bigquery/bigquery_skill.js';

describe('BigQuery Skill', () => {
  it('should load the bigquery-ai-ml skill', async () => {
    const skill = await getBigQuerySkill();
    expect(skill).toBeDefined();
    expect(skill.frontmatter.name).toBe('bigquery-ai-ml');
    expect(skill.instructions).toBeDefined();
    expect(skill.resources).toBeDefined();
    expect(skill.resources?.references).toBeDefined();
    expect(
      Object.keys(skill.resources?.references || {}).length,
    ).toBeGreaterThan(0);

    // Verify some specific references exist
    const refs = skill.resources?.references || {};
    expect(refs['bigquery_ai_forecast.md']).toBeDefined();
    expect(refs['bigquery_ai_detect_anomalies.md']).toBeDefined();
  });
});
