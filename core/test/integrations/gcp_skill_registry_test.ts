/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GCPSkillRegistry} from '../../src/index.js';

let shouldAuthThrow = false;

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => {
      return {
        getClient: vi.fn().mockImplementation(() => {
          if (shouldAuthThrow) {
            return Promise.reject(new Error('Auth error'));
          }
          return Promise.resolve({
            getRequestHeaders: vi.fn().mockResolvedValue({
              'Authorization': 'Bearer fake-token',
            }),
          });
        }),
      };
    }),
  };
});

describe('GCPSkillRegistry', () => {
  let registry: GCPSkillRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    shouldAuthThrow = false;
    global.fetch = vi.fn();
    process.env['GOOGLE_CLOUD_PROJECT'] = 'env-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'env-location';
  });

  describe('constructor', () => {
    it('initializes with options', () => {
      registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'test-location',
      });
      expect(registry).toBeDefined();
    });

    it('initializes from environment variables if options omitted', () => {
      registry = new GCPSkillRegistry();
      expect(registry).toBeDefined();
    });

    it('throws if project ID is missing', () => {
      delete process.env['GOOGLE_CLOUD_PROJECT'];
      expect(() => new GCPSkillRegistry()).toThrow(
        'Project ID must be specified or set via GOOGLE_CLOUD_PROJECT environment variable.',
      );
    });

    it('defaults location to us-central1 if location options and env are missing', async () => {
      delete process.env['GOOGLE_CLOUD_LOCATION'];
      registry = new GCPSkillRegistry();
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          retrievedSkills: [],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );
      await registry.searchSkills({query: 'test'});
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          'https://us-central1-aiplatform.googleapis.com',
        ),
        expect.anything(),
      );
    });

    it('returns null for searchToolDescription', () => {
      registry = new GCPSkillRegistry();
      expect(registry.searchToolDescription()).toBeNull();
    });
  });

  describe('getSkill', () => {
    beforeEach(() => {
      registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
    });

    it('successfully fetches and parses a skill', async () => {
      const zip = new AdmZip();
      const skillMd = `---
name: my-skill
description: test
---
Instructions`;
      zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
      const zipBytesBase64 = zip.toBuffer().toString('base64');

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBytesBase64,
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const skill = await registry.getSkill({name: 'my-skill'});

      expect(skill.frontmatter.name).toBe('my-skill');
      expect(skill.frontmatter.description).toBe('test');
      expect(skill.instructions).toBe('Instructions');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills/my-skill',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer fake-token',
          }),
        }),
      );
    });

    it('throws error if skill has no zipped filesystem', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          // no zippedFilesystem
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      await expect(registry.getSkill({name: 'my-skill'})).rejects.toThrow(
        "Skill 'my-skill' does not contain zipped filesystem.",
      );
    });

    it('throws error if response is not ok', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('Skill not found'),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      await expect(registry.getSkill({name: 'my-skill'})).rejects.toThrow(
        "Failed to fetch skill 'my-skill' (HTTP 404): Skill not found",
      );
    });
  });

  describe('searchSkills', () => {
    beforeEach(() => {
      registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
    });

    it('successfully searches skills and returns Frontmatter list', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          retrievedSkills: [
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-1',
              description: 'Skill 1 description',
            },
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-2',
              description: 'Skill 2 description',
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const results = await registry.searchSkills({query: 'test query'});

      expect(results).toEqual([
        {name: 'skill-1', description: 'Skill 1 description'},
        {name: 'skill-2', description: 'Skill 2 description'},
      ]);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills:retrieve?query=test%20query',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer fake-token',
          }),
        }),
      );
    });

    it('handles retrievedSkills with missing skillName or description', async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          retrievedSkills: [
            {
              // missing skillName
              description: 'Skill without name',
            },
            {
              skillName: 'just-name', // no / in name
              // missing description
            },
            {
              skillName: 'skills/', // ends with slash, pop() is empty
              description: 'Ends with slash',
            },
          ],
        }),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      const results = await registry.searchSkills({query: 'test query'});

      expect(results).toEqual([
        {name: '', description: 'Skill without name'},
        {name: 'just-name', description: ''},
        {name: '', description: 'Ends with slash'},
      ]);
    });

    it('throws error if fetch fails', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal error'),
      };
      vi.mocked(global.fetch).mockResolvedValue(
        mockResponse as unknown as Response,
      );

      await expect(registry.searchSkills({query: 'query'})).rejects.toThrow(
        'Failed to retrieve skills (HTTP 500): Internal error',
      );
    });
  });
});
