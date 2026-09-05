/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the Vertex AI `v1beta1` transport that a `client` option selects.
 *
 * `core/test/tools/skills/skill_registry_test.ts` already pins the search path
 * and the zipped-filesystem path. These cases cover the rest: the listing path
 * a blank query takes, and the constructor rule that a client exempts a caller
 * from naming a project and a location.
 */

import {Client} from '@google-cloud/vertexai';
import {GCPSkillRegistry} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createSkillZip} from './gcp_skill_registry_test_utils.js';

/** Records every request path, and answers each with `payload`. */
function createMockClient(payload: unknown) {
  const request = vi
    .fn()
    .mockResolvedValue({json: vi.fn().mockResolvedValue(payload)});
  return {
    request,
    client: {apiClient: {request}} as unknown as Client,
  };
}

describe('GCPSkillRegistry with a Vertex AI client', () => {
  beforeEach(() => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_LOCATION;
  });

  it('constructs without a project or a location', async () => {
    const {client} = createMockClient({
      zippedFilesystem: createSkillZip().toString('base64'),
    });

    const skill = await new GCPSkillRegistry({client}).getSkill('my-skill');

    expect(skill.frontmatter.name).toBe('my-skill');
  });

  it('lists every skill when the query is blank', async () => {
    const {request, client} = createMockClient({
      skills: [
        {name: 'projects/p/locations/l/skills/first', description: 'one'},
        {skillName: 'second', description: 'two'},
      ],
    });

    const results = await new GCPSkillRegistry({client}).searchSkills('   ');

    expect(request).toHaveBeenCalledWith({
      path: 'skills',
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });
    expect(results).toEqual([
      {name: 'first', description: 'one'},
      {name: 'second', description: 'two'},
    ]);
  });

  it('returns nothing when the listing carries no skills', async () => {
    const {client} = createMockClient({});

    expect(await new GCPSkillRegistry({client}).searchSkills('')).toEqual([]);
  });

  it('escapes a query that carries URL punctuation', async () => {
    const {request, client} = createMockClient({retrievedSkills: []});

    await new GCPSkillRegistry({client}).searchSkills('a&b c?d');

    expect(request).toHaveBeenCalledWith({
      path: 'skills:retrieve?query=a%26b%20c%3Fd',
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });
  });
});
