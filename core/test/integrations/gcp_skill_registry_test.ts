/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import JSZip from 'jszip';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GCPSkillRegistry} from '../../src/integrations/skill_registry/gcp_skill_registry.js';

// Mock google-auth-library
let shouldAuthThrow = false;
let mockQuotaProjectId: string | undefined = 'quota-project-123';
let mockClientQuotaProjectId: string | undefined = 'quota-project-123';

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
            quotaProjectId: mockClientQuotaProjectId,
          });
        }),
        get quotaProjectId() {
          return mockQuotaProjectId;
        },
      };
    }),
  };
});

const createMockZip = async (options?: {
  skillMd?: string;
  files?: Record<string, string | Buffer>;
}): Promise<string> => {
  const zip = new JSZip();
  const skillMd =
    options?.skillMd ??
    `---
name: mock-skill
description: A mock skill
---
# Instructions
Do something.
`;
  zip.file('SKILL.md', skillMd);

  if (options?.files) {
    for (const [path, content] of Object.entries(options.files)) {
      zip.file(path, content);
    }
  }

  const content = await zip.generateAsync({type: 'nodebuffer'});
  return content.toString('base64');
};

describe('GCPSkillRegistry', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
    shouldAuthThrow = false;
    mockQuotaProjectId = 'quota-project-123';
    mockClientQuotaProjectId = 'quota-project-123';
    originalEnv = {...process.env};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Initialization', () => {
    it('should initialize correctly with options', () => {
      const registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
      expect(registry.projectId).toBe('test-project');
      expect(registry.location).toBe('us-central1');
    });

    it('should initialize correctly with env variables', () => {
      process.env.GOOGLE_CLOUD_PROJECT = 'env-project';
      process.env.GOOGLE_CLOUD_LOCATION = 'env-location';

      const registry = new GCPSkillRegistry();
      expect(registry.projectId).toBe('env-project');
      expect(registry.location).toBe('env-location');
    });

    it('should throw error if projectId or location is missing', () => {
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.GOOGLE_CLOUD_LOCATION;

      expect(() => new GCPSkillRegistry()).toThrow(
        'projectId and location must be provided or set in environment variables',
      );
      expect(
        () => new GCPSkillRegistry({projectId: 'test', location: null}),
      ).toThrow();
      expect(
        () => new GCPSkillRegistry({projectId: null, location: 'test'}),
      ).toThrow();
    });
  });

  describe('getSkill', () => {
    let registry: GCPSkillRegistry;

    beforeEach(() => {
      registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
    });

    it('should fetch and load a skill successfully', async () => {
      const zipBase64 = await createMockZip({
        files: {
          'references/ref1.txt': 'ref1 content',
          'references/ref2.bin': Buffer.from([0, 1, 2, 3, 0, 4]), // binary reference
          'assets/img.png': Buffer.from([0, 1, 2, 3, 0, 4]), // binary asset
          'assets/text_asset.txt': 'text asset content', // text asset
          'scripts/run.sh': 'echo hello',
        },
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      const skill = await registry.getSkill({name: 'mock-skill'});

      expect(global.fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills/mock-skill',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer fake-token',
            'x-goog-user-project': 'quota-project-123',
          }),
        }),
      );

      expect(skill.frontmatter.name).toBe('mock-skill');
      expect(skill.frontmatter.description).toBe('A mock skill');
      expect(skill.instructions).toContain('# Instructions');
      expect(skill.resources?.references?.['ref1.txt']).toBe('ref1 content');
      expect(skill.resources?.references?.['ref2.bin']).toEqual(
        Buffer.from([0, 1, 2, 3, 0, 4]),
      );
      expect(skill.resources?.assets?.['img.png']).toEqual(
        Buffer.from([0, 1, 2, 3, 0, 4]),
      );
      expect(skill.resources?.assets?.['text_asset.txt']).toBe(
        'text asset content',
      );
      expect(skill.resources?.scripts?.['run.sh']).toEqual({
        src: 'echo hello',
      });
    });

    it('should throw error on auth token refresh failure', async () => {
      shouldAuthThrow = true;
      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'Failed to refresh Google Cloud credentials: Auth error',
      );
    });

    it('should throw error on fetch request failure', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network Failure'));
      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'API request failed: Network Failure',
      );
    });

    it('should throw error on non-2xx status code response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('Skill not found'),
      });
      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'API request failed with status 404: Skill not found',
      );
    });

    it('should throw error if zippedFilesystem is missing from response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });
      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        "Skill 'mock-skill' does not contain zipped filesystem.",
      );
    });

    it('should throw error on corrupt zip content', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: Buffer.from('invalid-zip-bytes').toString('base64'),
        }),
      });
      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'Failed to load zip file',
      );
    });

    it('should throw error if name in SKILL.md does not match requested name', async () => {
      const zipBase64 = await createMockZip({
        skillMd: `---
name: different-name
description: different
---
`,
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        "Skill name 'different-name' does not match requested name 'mock-skill'.",
      );
    });

    it('should throw error if SKILL.md is missing from zip archive', async () => {
      const zip = new JSZip();
      zip.file('README.md', 'hello');
      const zipBase64 = (
        await zip.generateAsync({type: 'nodebuffer'})
      ).toString('base64');

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'SKILL.md not found in zipped filesystem.',
      );
    });

    it('should throw error on Zip Slip attempt with leading slash', async () => {
      const zipBase64 = await createMockZip({
        files: {
          '/absolute/path/file.txt': 'content',
        },
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'Dangerous zip entry ignored: /absolute/',
      );
    });

    it('should throw error on Zip Slip attempt with relative path', async () => {
      const zipBase64 = await createMockZip({
        files: {
          '../outside.txt': 'content',
        },
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'Dangerous zip entry ignored: /',
      );
    });

    it('should throw error on Zip Slip attempt with inner directory traversal', async () => {
      const zipBase64 = await createMockZip({
        files: {
          'some/dir/../../outside.txt': 'content',
        },
      });

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await expect(registry.getSkill({name: 'mock-skill'})).rejects.toThrow(
        'Dangerous zip entry ignored: /',
      );
    });

    it('should use auth.quotaProjectId if client.quotaProjectId is missing', async () => {
      mockClientQuotaProjectId = undefined;
      mockQuotaProjectId = 'quota-project-from-auth';

      const zipBase64 = await createMockZip();
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await registry.getSkill({name: 'mock-skill'});

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-goog-user-project': 'quota-project-from-auth',
          }),
        }),
      );
    });

    it('should not set x-goog-user-project header if quotaProjectId is missing', async () => {
      mockClientQuotaProjectId = undefined;
      mockQuotaProjectId = undefined;

      const zipBase64 = await createMockZip();
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          zippedFilesystem: zipBase64,
        }),
      });

      await registry.getSkill({name: 'mock-skill'});

      const callArgs = (global.fetch as any).mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers['x-goog-user-project']).toBeUndefined();
    });
  });

  describe('searchSkills', () => {
    let registry: GCPSkillRegistry;

    beforeEach(() => {
      registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
    });

    it('should search skills and return frontmatter list', async () => {
      const mockResponse = {
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
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockResponse),
      });

      const results = await registry.searchSkills({query: 'my query'});

      expect(global.fetch).toHaveBeenCalledWith(
        'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/skills:retrieve?query=my+query',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer fake-token',
          }),
        }),
      );

      expect(results).toEqual([
        {name: 'skill-1', description: 'Skill 1 description'},
        {name: 'skill-2', description: 'Skill 2 description'},
      ]);
    });

    it('should return empty list if retrievedSkills is missing or empty', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      const results = await registry.searchSkills({query: 'empty'});
      expect(results).toEqual([]);
    });

    it('should throw error on fetch request failure', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network Failure'));
      await expect(registry.searchSkills({query: 'test'})).rejects.toThrow(
        'API request failed: Network Failure',
      );
    });

    it('should throw error on non-2xx status code response', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal Server Error'),
      });
      await expect(registry.searchSkills({query: 'test'})).rejects.toThrow(
        'API request failed with status 500: Internal Server Error',
      );
    });
  });

  describe('searchToolDescription', () => {
    it('should return null by default', () => {
      const registry = new GCPSkillRegistry({
        projectId: 'test-project',
        location: 'us-central1',
      });
      expect(registry.searchToolDescription()).toBeNull();
    });
  });
});
