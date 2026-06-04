/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GCPSkillRegistry} from '../../src/integrations/skill_registry/gcp_skill_registry.js';

const mockRequest = vi.fn();

vi.mock('@google-cloud/vertexai/build/src/genai/client.js', () => {
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor Options', () => {
    it('uses constructor options if provided', () => {
      const registry = new GCPSkillRegistry({
        projectId: 'custom-proj',
        location: 'custom-loc',
      });
      expect((registry as unknown as Record<string, unknown>).projectId).toBe(
        'custom-proj',
      );
      expect((registry as unknown as Record<string, unknown>).location).toBe(
        'custom-loc',
      );
    });

    it('falls back to environment variables', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-proj';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-loc';

      const registry = new GCPSkillRegistry();
      expect((registry as unknown as Record<string, unknown>).projectId).toBe(
        'env-proj',
      );
      expect((registry as unknown as Record<string, unknown>).location).toBe(
        'env-loc',
      );

      delete process.env['GOOGLE_CLOUD_PROJECT'];
      delete process.env['GOOGLE_CLOUD_LOCATION'];
    });

    it('defaults location to us-central1 if not in environment', () => {
      const registry = new GCPSkillRegistry();
      expect((registry as unknown as Record<string, unknown>).location).toBe(
        'us-central1',
      );
    });
  });

  describe('getSkill', () => {
    it('successfully fetches and loads a skill', async () => {
      const registry = new GCPSkillRegistry({
        projectId: 'my-project',
        location: 'my-location',
      });

      const zip = new JSZip();
      zip.file(
        'SKILL.md',
        `---
name: test-skill
description: A test skill from GCP
---
Instructions from registry`,
      );
      const zipBytes = await zip.generateAsync({type: 'nodebuffer'});
      const base64Zip = zipBytes.toString('base64');

      mockRequest.mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          name: 'projects/my-project/locations/my-location/skills/test-skill',
          zippedFilesystem: base64Zip,
        }),
      });

      const skill = await registry.getSkill({name: 'test-skill'});

      expect(mockRequest).toHaveBeenCalledWith({
        path: 'projects/my-project/locations/my-location/skills/test-skill',
        httpMethod: 'GET',
      });
      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.instructions).toBe('Instructions from registry');
    });

    it('throws error if skill does not contain zipped filesystem', async () => {
      const registry = new GCPSkillRegistry({
        projectId: 'my-project',
        location: 'my-location',
      });

      mockRequest.mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          name: 'projects/my-project/locations/my-location/skills/test-skill',
        }),
      });

      await expect(registry.getSkill({name: 'test-skill'})).rejects.toThrow(
        "Skill 'test-skill' does not contain zipped filesystem.",
      );
    });
  });

  describe('searchSkills', () => {
    it('successfully searches and returns frontmatter list', async () => {
      const registry = new GCPSkillRegistry({
        projectId: 'my-project',
        location: 'my-location',
      });

      mockRequest.mockResolvedValue({
        json: vi.fn().mockResolvedValue({
          retrievedSkills: [
            {
              skillName:
                'projects/my-project/locations/my-location/skills/skill-a',
              description: 'Description A',
            },
            {
              skillName:
                'projects/my-project/locations/my-location/skills/skill-b',
              description: 'Description B',
            },
          ],
        }),
      });

      const results = await registry.searchSkills({query: 'test'});

      expect(mockRequest).toHaveBeenCalledWith({
        path: 'projects/my-project/locations/my-location/skills:retrieve',
        httpMethod: 'GET',
        queryParams: {query: 'test'},
      });

      expect(results).toEqual([
        {name: 'skill-a', description: 'Description A'},
        {name: 'skill-b', description: 'Description B'},
      ]);
    });

    it('handles empty search results gracefully', async () => {
      const registry = new GCPSkillRegistry({
        projectId: 'my-project',
        location: 'my-location',
      });

      mockRequest.mockResolvedValue({
        json: vi.fn().mockResolvedValue({}),
      });

      const results = await registry.searchSkills({query: 'empty'});
      expect(results).toEqual([]);
    });
  });

  describe('searchToolDescription', () => {
    it('returns null', () => {
      const registry = new GCPSkillRegistry();
      expect(registry.searchToolDescription()).toBeNull();
    });
  });
});
