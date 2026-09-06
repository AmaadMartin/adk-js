/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the Vertex AI `v1beta1` transport that a `client` option selects.
 *
 * `core/test/tools/skills/skill_registry_test.ts` drives it through the public
 * `GCPSkillRegistry({client})` and pins the search path and the
 * zipped-filesystem path. These cases cover the rest: the listing path a blank
 * query takes, and the name spelling only that path produces.
 */

import {describe, expect, it, vi} from 'vitest';
import {
  VertexApiTransport,
  VertexSkillRegistry,
} from '../../src/skills/vertex_skill_registry.js';
import {createSkillZip} from './gcp_skill_registry_test_utils.js';

/** A transport that records every request and answers each with `payload`. */
function createTransport(payload: unknown) {
  const request = vi
    .fn<VertexApiTransport['request']>()
    .mockResolvedValue({json: vi.fn().mockResolvedValue(payload)});
  return {request, registry: new VertexSkillRegistry({request})};
}

describe('VertexSkillRegistry', () => {
  it('downloads the zipped filesystem of a skill', async () => {
    const {request, registry} = createTransport({
      zippedFilesystem: createSkillZip().toString('base64'),
    });

    const skill = await registry.getSkill('my-skill');

    expect(request).toHaveBeenCalledWith({
      path: 'skills/my-skill',
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });
    expect(skill.frontmatter.name).toBe('my-skill');
  });

  it('lists every skill when the query is blank', async () => {
    const {request, registry} = createTransport({
      skills: [
        {name: 'projects/p/locations/l/skills/first', description: 'one'},
        {skillName: 'second', description: 'two'},
      ],
    });

    const results = await registry.searchSkills('   ');

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
    const {registry} = createTransport({});

    expect(await registry.searchSkills('')).toEqual([]);
  });

  it('escapes a query that carries URL punctuation', async () => {
    const {request, registry} = createTransport({retrievedSkills: []});

    await registry.searchSkills('a&b c?d');

    expect(request).toHaveBeenCalledWith({
      path: 'skills:retrieve?query=a%26b%20c%3Fd',
      httpMethod: 'GET',
      httpOptions: {apiVersion: 'v1beta1'},
    });
  });

  it.each([[7], [null], [['a']], [{}]])(
    'names a hit the empty string when the catalogue reports %s',
    async (name) => {
      const {registry} = createTransport({
        retrievedSkills: [{skillName: name, description: 4}],
      });

      expect(await registry.searchSkills('anything')).toEqual([
        {name: '', description: ''},
      ]);
    },
  );

  it('rejects a hit whose zipped filesystem is not a string', async () => {
    const {registry} = createTransport({zippedFilesystem: 7});

    await expect(registry.getSkill('my-skill')).rejects.toThrow(
      "Skill 'my-skill' does not contain zipped filesystem.",
    );
  });

  it('reads no field off a response that is not an object', async () => {
    const {registry} = createTransport('not an object');

    await expect(registry.getSkill('my-skill')).rejects.toThrow(
      "Skill 'my-skill' does not contain zipped filesystem.",
    );
    expect(await registry.searchSkills('anything')).toEqual([]);
  });
});
