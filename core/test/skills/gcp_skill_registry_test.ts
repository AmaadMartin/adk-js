/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import AdmZip from 'adm-zip';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  GCPSkillRegistry,
  MAX_ENCODED_FILESYSTEM_LENGTH,
} from '../../src/skills/gcp_skill_registry.js';
import {Skill} from '../../src/skills/skill.js';

// Only `loadSkillFromZipBuffer` is mocked; it defaults to the real
// implementation (see `beforeEach`) so a valid archive still loads.
const loader = vi.hoisted(() => vi.fn<(zipBuffer: Buffer) => Skill>());
vi.mock('../../src/skills/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/skills/loader.js')>()),
  loadSkillFromZipBuffer: loader,
}));

const {loadSkillFromZipBuffer: realLoadSkillFromZipBuffer} =
  await vi.importActual<typeof import('../../src/skills/loader.js')>(
    '../../src/skills/loader.js',
  );

const SKILL_MD = `---
name: test-remote-skill
description: A test remote skill
---
Instruction body`;

function createValidZipBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(SKILL_MD, 'utf-8'));
  return zip.toBuffer();
}

function createRegistry(response: Record<string, unknown>): GCPSkillRegistry {
  const client = {
    apiClient: {
      request: vi.fn().mockResolvedValue({
        json: vi.fn().mockResolvedValue(response),
      }),
    },
  };
  return new GCPSkillRegistry({client: client as unknown as Client});
}

describe('GCPSkillRegistry payload cap', () => {
  beforeEach(() => {
    loader.mockReset();
    loader.mockImplementation(realLoadSkillFromZipBuffer);
  });

  it('rejects an over-cap payload without decoding it', async () => {
    const oversized = 'A'.repeat(MAX_ENCODED_FILESYSTEM_LENGTH + 1);
    const registry = createRegistry({zippedFilesystem: oversized});

    await expect(registry.getSkill('huge-skill')).rejects.toThrow(
      `Skill 'huge-skill' zipped filesystem is too large: ` +
        `${MAX_ENCODED_FILESYSTEM_LENGTH + 1} base64 characters exceeds ` +
        `the limit of ${MAX_ENCODED_FILESYSTEM_LENGTH}.`,
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects an over-cap payload under the snake_case spelling', async () => {
    const oversized = 'A'.repeat(MAX_ENCODED_FILESYSTEM_LENGTH + 1);
    const registry = createRegistry({zipped_filesystem: oversized});

    await expect(registry.getSkill('huge-skill')).rejects.toThrow(
      `Skill 'huge-skill' zipped filesystem is too large: ` +
        `${MAX_ENCODED_FILESYSTEM_LENGTH + 1} base64 characters exceeds ` +
        `the limit of ${MAX_ENCODED_FILESYSTEM_LENGTH}.`,
    );
    expect(loader).not.toHaveBeenCalled();
  });

  it('accepts a payload exactly at the cap', async () => {
    const atCap = 'A'.repeat(MAX_ENCODED_FILESYSTEM_LENGTH);
    const fixture: Skill = {
      frontmatter: {name: 'at-cap-skill', description: 'At the cap'},
      instructions: 'Instruction body',
    };
    loader.mockReturnValueOnce(fixture);
    const registry = createRegistry({zippedFilesystem: atCap});

    await expect(registry.getSkill('at-cap-skill')).resolves.toBe(fixture);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('loads a normal-sized payload', async () => {
    const registry = createRegistry({
      zippedFilesystem: createValidZipBuffer().toString('base64'),
    });

    const skill = await registry.getSkill('test-remote-skill');

    expect(skill.frontmatter.name).toBe('test-remote-skill');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
