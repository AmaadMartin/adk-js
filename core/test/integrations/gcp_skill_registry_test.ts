/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GCPSkillRegistry} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import JSZip from 'jszip';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library');

async function createMockZip(
  files: Record<string, string | Buffer>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [filename, content] of Object.entries(files)) {
    zip.file(filename, content);
  }
  return zip.generateAsync({type: 'nodebuffer'});
}

describe('GCPSkillRegistry', () => {
  let mockAuthClient: {
    getRequestHeaders: () => Promise<Record<string, string>>;
  };
  let mockAuth: {
    getProjectId: () => Promise<string>;
    getClient: () => Promise<{
      getRequestHeaders: () => Promise<Record<string, string>>;
    }>;
  };

  beforeEach(() => {
    mockAuthClient = {
      getRequestHeaders: vi.fn().mockResolvedValue({
        Authorization: 'Bearer mock-token',
      }),
    };

    mockAuth = {
      getProjectId: vi.fn().mockResolvedValue('test-project'),
      getClient: vi.fn().mockResolvedValue(mockAuthClient),
    };

    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(GoogleAuth).mockImplementation(
      () => mockAuth as unknown as GoogleAuth,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('constructor', () => {
    it('uses provided projectId and location', async () => {
      const registry = new GCPSkillRegistry({
        projectId: 'custom-project',
        location: 'europe-west1',
      });
      // We can check location by calling a method and verifying the fetched URL
      const mockZip = await createMockZip({
        'SKILL.md': '---\nname: my-skill\ndescription: Test\n---\nbody',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({zippedFilesystem: mockZip.toString('base64')}),
      } as Response);

      await registry.getSkill('my-skill');

      expect(fetch).toHaveBeenCalledWith(
        'https://europe-west1-aiplatform.googleapis.com/v1beta1/projects/custom-project/locations/europe-west1/skills/my-skill',
        expect.any(Object),
      );
    });

    it('falls back to environment variables', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');

      const registry = new GCPSkillRegistry();
      const mockZip = await createMockZip({
        'SKILL.md': '---\nname: my-skill\ndescription: Test\n---\nbody',
      });
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({zippedFilesystem: mockZip.toString('base64')}),
      } as Response);

      await registry.getSkill('my-skill');

      expect(fetch).toHaveBeenCalledWith(
        'https://env-location-aiplatform.googleapis.com/v1beta1/projects/env-project/locations/env-location/skills/my-skill',
        expect.any(Object),
      );
    });
  });

  describe('getSkill', () => {
    it('successfully fetches and parses a skill', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      const mockZip = await createMockZip({
        'SKILL.md':
          '---\nname: test-skill\ndescription: A test skill\n---\nHello Instructions',
        'references/ref1.md': 'Ref 1 content',
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({zippedFilesystem: mockZip.toString('base64')}),
      } as Response);

      const skill = await registry.getSkill('test-skill');

      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.frontmatter.description).toBe('A test skill');
      expect(skill.instructions).toBe('Hello Instructions');
      expect(skill.resources?.references?.['ref1.md']).toBe('Ref 1 content');

      expect(fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills/test-skill',
        {
          headers: {Authorization: 'Bearer mock-token'},
        },
      );
    });

    it('throws error when API response is not ok', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'Skill not found',
      } as Response);

      await expect(registry.getSkill('test-skill')).rejects.toThrow(
        "Failed to fetch skill 'test-skill' from GCP Skill Registry: HTTP 404 - Skill not found",
      );
    });

    it('throws error when zippedFilesystem is missing', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      await expect(registry.getSkill('test-skill')).rejects.toThrow(
        "Skill 'test-skill' does not contain zipped filesystem.",
      );
    });

    it('throws error when skill name in frontmatter does not match requested name', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      const mockZip = await createMockZip({
        'SKILL.md':
          '---\nname: mismatched-name\ndescription: A test skill\n---\nHello Instructions',
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({zippedFilesystem: mockZip.toString('base64')}),
      } as Response);

      await expect(registry.getSkill('test-skill')).rejects.toThrow(
        "Skill name 'mismatched-name' does not match requested name 'test-skill'.",
      );
    });

    it('throws error when project ID could not be determined', async () => {
      mockAuth.getProjectId = vi.fn().mockResolvedValue(undefined);
      const registry = new GCPSkillRegistry();
      await expect(registry.getSkill('test-skill')).rejects.toThrow(
        'GCP Project ID could not be determined.',
      );
    });
  });

  describe('searchSkills', () => {
    it('successfully retrieves and maps list of skills', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          retrievedSkills: [
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-a',
              description: 'Description A',
            },
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-b',
              description: 'Description B',
            },
            {
              description: 'Description C',
            },
            {
              skillName:
                'projects/test-project/locations/us-central1/skills/skill-d',
            },
          ],
        }),
      } as Response);

      const results = await registry.searchSkills('query');

      expect(results).toHaveLength(4);
      expect(results[0]).toEqual({
        name: 'skill-a',
        description: 'Description A',
      });
      expect(results[1]).toEqual({
        name: 'skill-b',
        description: 'Description B',
      });
      expect(results[2]).toEqual({
        name: '',
        description: 'Description C',
      });
      expect(results[3]).toEqual({
        name: 'skill-d',
        description: '',
      });

      expect(fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills:retrieve?query=query',
        {
          headers: {Authorization: 'Bearer mock-token'},
        },
      );
    });

    it('handles empty results list', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);

      const results = await registry.searchSkills('query');
      expect(results).toEqual([]);
    });

    it('throws error when search API fails', async () => {
      const registry = new GCPSkillRegistry({projectId: 'test-project'});
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      } as Response);

      await expect(registry.searchSkills('query')).rejects.toThrow(
        'Failed to retrieve skills from GCP Skill Registry: HTTP 500 - Internal Server Error',
      );
    });

    it('throws error when project ID could not be determined', async () => {
      mockAuth.getProjectId = vi.fn().mockResolvedValue(undefined);
      const registry = new GCPSkillRegistry();
      await expect(registry.searchSkills('query')).rejects.toThrow(
        'GCP Project ID could not be determined.',
      );
    });
  });

  describe('searchToolDescription', () => {
    it('returns null', () => {
      const registry = new GCPSkillRegistry();
      expect(registry.searchToolDescription()).toBeNull();
    });
  });
});
