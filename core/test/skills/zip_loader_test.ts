/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {loadSkillFromZipBytes} from '@google/adk';
import JSZip from 'jszip';
import {describe, expect, it, vi} from 'vitest';

async function createMockZip(
  files: Record<string, string | Buffer>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [filename, content] of Object.entries(files)) {
    zip.file(filename, content);
  }
  return zip.generateAsync({type: 'nodebuffer'});
}

describe('Zip Loader', () => {
  it('loads valid skill correctly', async () => {
    const zipBytes = await createMockZip({
      'SKILL.md':
        '---\nname: my-skill\ndescription: A test skill\n---\nHello Instructions',
      'references/ref1.md': 'Ref 1 content',
      'assets/asset1.png': Buffer.from([0xff, 0xff, 0xff, 0xff]),
      'scripts/script1.sh': 'echo hello',
    });

    const skill = await loadSkillFromZipBytes(zipBytes);
    expect(skill.frontmatter.name).toBe('my-skill');
    expect(skill.frontmatter.description).toBe('A test skill');
    expect(skill.instructions).toBe('Hello Instructions');
    expect(skill.resources?.references?.['ref1.md']).toBe('Ref 1 content');
    expect(skill.resources?.assets?.['asset1.png']).toBeInstanceOf(Buffer);
    expect(skill.resources?.scripts?.['script1.sh']?.src).toBe('echo hello');
  });

  it('handles fallback when files are nested under a single subfolder', async () => {
    const zipBytes = await createMockZip({
      'some-subfolder/SKILL.md':
        '---\nname: my-skill\ndescription: A test skill\n---\nHello Instructions',
      'some-subfolder/references/ref1.md': 'Ref 1 content',
      'some-subfolder/assets/asset1.png': Buffer.from([0xff, 0xff, 0xff, 0xff]),
      'some-subfolder/scripts/script1.sh': 'echo hello',
    });

    const skill = await loadSkillFromZipBytes(zipBytes);
    expect(skill.frontmatter.name).toBe('my-skill');
    expect(skill.frontmatter.description).toBe('A test skill');
    expect(skill.instructions).toBe('Hello Instructions');
    expect(skill.resources?.references?.['ref1.md']).toBe('Ref 1 content');
    expect(skill.resources?.assets?.['asset1.png']).toBeInstanceOf(Buffer);
    expect(skill.resources?.scripts?.['script1.sh']?.src).toBe('echo hello');
  });

  it('throws error on zip slip path traversal (../)', async () => {
    const zipBytes = await createMockZip({
      'SKILL.md':
        '---\nname: my-skill\ndescription: A test skill\n---\nHello Instructions',
      '../references/ref1.md': 'Ref 1 content',
    });

    await expect(loadSkillFromZipBytes(zipBytes)).rejects.toThrow(
      'Dangerous zip entry ignored',
    );
  });

  it('throws error on zip slip absolute path (/)', async () => {
    const zipBytes = await createMockZip({
      'SKILL.md':
        '---\nname: my-skill\ndescription: A test skill\n---\nHello Instructions',
      '/references/ref1.md': 'Ref 1 content',
    });

    await expect(loadSkillFromZipBytes(zipBytes)).rejects.toThrow(
      'Dangerous zip entry ignored',
    );
  });

  it('throws error when SKILL.md is missing', async () => {
    const zipBytes = await createMockZip({
      'references/ref1.md': 'Ref 1 content',
    });

    await expect(loadSkillFromZipBytes(zipBytes)).rejects.toThrow(
      'SKILL.md not found in zipped filesystem.',
    );
  });

  it('throws validation error when frontmatter is malformed', async () => {
    const zipBytes = await createMockZip({
      'SKILL.md':
        '---\nname: Invalid Name with Spaces\ndescription: A test skill\n---\nHello Instructions',
    });

    await expect(loadSkillFromZipBytes(zipBytes)).rejects.toThrow();
  });

  it('skips __pycache__ and empty relative path entries', async () => {
    const mockZip = {
      files: {
        'SKILL.md': {
          dir: false,
          async: async () =>
            '---\nname: my-skill\ndescription: A test skill\n---\nHello Instructions',
        },
        'references/': {
          dir: false,
          async: async () => Buffer.from([]),
        },
        'references/valid.md': {
          dir: false,
          async: async () => Buffer.from('valid reference'),
        },
        'references/__pycache__/some_file.pyc': {
          dir: false,
          async: async () => Buffer.from('pyc'),
        },
      },
      file: function (name: string) {
        return this.files[name as keyof typeof this.files] || null;
      },
    };
    const spy = vi
      .spyOn(JSZip, 'loadAsync')
      .mockResolvedValue(mockZip as unknown as JSZip);

    const skill = await loadSkillFromZipBytes(Buffer.from([]));
    expect(skill.resources?.references?.['valid.md']).toBe('valid reference');
    expect(
      skill.resources?.references?.['__pycache__/some_file.pyc'],
    ).toBeUndefined();
    expect(skill.resources?.references?.['']).toBeUndefined();

    spy.mockRestore();
  });

  it('throws error when zip is completely empty', async () => {
    const zipBytes = await createMockZip({});
    await expect(loadSkillFromZipBytes(zipBytes)).rejects.toThrow(
      'SKILL.md not found in zipped filesystem.',
    );
  });
});
