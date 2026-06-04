/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GCPSkillRegistry} from '@google/adk';
import * as fflate from 'fflate';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mockRequest = vi.fn();

vi.mock('@google-cloud/vertexai', () => {
  return {
    Client: vi.fn().mockImplementation(() => {
      return {
        apiClient: {
          request: mockRequest,
        },
      };
    }),
  };
});

describe('GCPSkillRegistry', () => {
  let registry: GCPSkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
    registry = new GCPSkillRegistry();
  });

  describe('constructor', () => {
    it('initializes with env variables', () => {
      expect(registry).toBeDefined();
    });

    it('initializes with explicit params', () => {
      const reg = new GCPSkillRegistry({projectId: 'p', location: 'l'});
      expect(reg).toBeDefined();
    });

    it('throws error if project or location is missing', () => {
      delete process.env['GOOGLE_CLOUD_PROJECT'];
      delete process.env['GOOGLE_CLOUD_LOCATION'];
      expect(() => new GCPSkillRegistry()).toThrow(
        'Project ID and Location must be provided or set in environment variables',
      );
    });
  });

  describe('getSkill', () => {
    it('successfully fetches and parses a skill (camelCase response)', async () => {
      const skillMd = `---
name: test-skill
description: A test skill
---
These are the instructions.
`;
      const zipData = fflate.zipSync({
        'SKILL.md': fflate.strToU8(skillMd),
        'references/ref1.txt': fflate.strToU8('some reference'),
        'assets/logo.png': new Uint8Array([0x80, 0x81]),
        'scripts/run.sh': fflate.strToU8('echo hello'),
      });

      const base64Zip = Buffer.from(zipData).toString('base64');

      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      const skill = await registry.getSkill({name: 'test-skill'});

      expect(mockRequest).toHaveBeenCalledWith({
        path: 'projects/test-project/locations/us-central1/skills/test-skill',
        httpMethod: 'GET',
      });

      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.frontmatter.description).toBe('A test skill');
      expect(skill.instructions).toBe('These are the instructions.');
      expect(skill.resources?.references?.['ref1.txt']).toBe('some reference');
      expect(skill.resources?.assets?.['logo.png']).toEqual(
        Buffer.from([0x80, 0x81]),
      );
      expect(skill.resources?.scripts?.['run.sh']).toEqual({src: 'echo hello'});
    });

    it('successfully fetches and parses a skill (snake_case response)', async () => {
      const skillMd = `---
name: test-skill
description: A test skill
---
These are the instructions.
`;
      const zipData = fflate.zipSync({
        'SKILL.md': fflate.strToU8(skillMd),
      });

      const base64Zip = Buffer.from(zipData).toString('base64');

      mockRequest.mockResolvedValue({
        json: async () => ({zipped_filesystem: base64Zip}),
      });

      const skill = await registry.getSkill({name: 'test-skill'});

      expect(skill.frontmatter.name).toBe('test-skill');
    });

    it('throws error if zippedFilesystem is missing', async () => {
      mockRequest.mockResolvedValue({
        json: async () => ({}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        "Skill 'test-skill' does not contain zipped filesystem.",
      );
    });

    it('throws error if zip is invalid', async () => {
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: 'not-a-base64-zip'}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        'Failed to unzip skill archive',
      );
    });

    it('throws error if SKILL.md is missing', async () => {
      const zipData = fflate.zipSync({
        'not-skill.md': fflate.strToU8('some content'),
      });
      const base64Zip = Buffer.from(zipData).toString('base64');
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        'SKILL.md not found in skill archive.',
      );
    });

    it('throws error if Zip Slip is detected (relative path)', async () => {
      const zipData = fflate.zipSync({
        'SKILL.md': fflate.strToU8(
          '---\nname: test-skill\ndescription: test\n---\n',
        ),
        '../evil.txt': fflate.strToU8('evil'),
      });
      const base64Zip = Buffer.from(zipData).toString('base64');
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        'Zip Slip detected in skill archive: ../evil.txt',
      );
    });

    it('throws error if Zip Slip is detected (absolute path)', async () => {
      const zipData = fflate.zipSync({
        'SKILL.md': fflate.strToU8(
          '---\nname: test-skill\ndescription: test\n---\n',
        ),
        '/evil.txt': fflate.strToU8('evil'),
      });
      const base64Zip = Buffer.from(zipData).toString('base64');
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        'Zip Slip detected in skill archive: /evil.txt',
      );
    });

    it('throws error if skill name in SKILL.md does not match requested name', async () => {
      const skillMd = `---
name: different-name
description: A test skill
---
`;
      const zipData = fflate.zipSync({
        'SKILL.md': fflate.strToU8(skillMd),
      });
      const base64Zip = Buffer.from(zipData).toString('base64');
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        "Skill name 'different-name' in SKILL.md does not match requested name 'test-skill'",
      );
    });

    it('throws error if SKILL.md is not a text file (binary)', async () => {
      const zipData = fflate.zipSync({
        'SKILL.md': new Uint8Array([0x80, 0x81]),
      });
      const base64Zip = Buffer.from(zipData).toString('base64');
      mockRequest.mockResolvedValue({
        json: async () => ({zippedFilesystem: base64Zip}),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        'SKILL.md must be a text file.',
      );
    });
  });

  describe('searchSkills', () => {
    it('successfully searches and returns frontmatters', async () => {
      mockRequest.mockResolvedValue({
        json: async () => ({
          retrievedSkills: [
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-1',
              description: 'Description 1',
            },
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-2',
              description: 'Description 2',
            },
          ],
        }),
      });

      const results = await registry.searchSkills({query: 'test'});

      expect(mockRequest).toHaveBeenCalledWith({
        path: 'projects/test-project/locations/us-central1/skills:retrieve',
        httpMethod: 'POST',
        body: JSON.stringify({query: 'test'}),
      });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        name: 'skill-1',
        description: 'Description 1',
      });
      expect(results[1]).toEqual({
        name: 'skill-2',
        description: 'Description 2',
      });
    });

    it('handles empty results', async () => {
      mockRequest.mockResolvedValue({
        json: async () => ({}),
      });

      const results = await registry.searchSkills({query: 'test'});

      expect(results).toEqual([]);
    });

    it('handles search results with missing fields', async () => {
      mockRequest.mockResolvedValue({
        json: async () => ({
          retrievedSkills: [
            {},
            {
              skillName: '',
              description: undefined,
            },
          ],
        }),
      });

      const results = await registry.searchSkills({query: 'test'});

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({name: '', description: ''});
      expect(results[1]).toEqual({name: '', description: ''});
    });
  });

  describe('searchToolDescription', () => {
    it('returns null by default', () => {
      expect(registry.searchToolDescription()).toBeNull();
    });
  });
});
