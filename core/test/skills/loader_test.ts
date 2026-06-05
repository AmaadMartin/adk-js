/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import AdmZip from 'adm-zip';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  loadAllSkillsInDir,
  loadSkillFromDir,
  loadSkillFromZipBytes,
  parseSkillMdContent,
  validateSkillDir,
} from '../../src/skills/loader.js';

describe('loader', () => {
  describe('parseSkillMdContent', () => {
    it('parses valid skill content', () => {
      const content = `---
name: test-skill
description: A test skill
---
Body content goes here.
Lines can continue.`;

      const result = parseSkillMdContent(content);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        description: 'A test skill',
        metadata: {},
      });
      expect(result.body).toBe('Body content goes here.\nLines can continue.');
    });

    it('throws error if content does not start with ---', () => {
      const content = `name: test-skill
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'SKILL.md must start with YAML frontmatter (---)',
      );
    });

    it('throws error if frontmatter is not properly closed', () => {
      const content = `---
name: test-skill
description: A test skill`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'SKILL.md frontmatter not properly closed with ---',
      );
    });

    it('throws error if frontmatter is not a YAML mapping', () => {
      const content = `---
- item1
- item2
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'Invalid YAML in frontmatter:',
      );
    });

    it('throws error if frontmatter is a YAML scalar/string', () => {
      const content = `---
just a string
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'Invalid YAML in frontmatter: SKILL.md frontmatter must be a YAML mapping',
      );
    });

    it('throws error on invalid YAML', () => {
      const content = `---
name: test-skill
description: A test skill
invalid: [
---
Body`;
      expect(() => parseSkillMdContent(content)).toThrow(
        'Invalid YAML in frontmatter:',
      );
    });

    it('handles empty body', () => {
      const content = `---
name: test-skill
description: A test skill
---`;
      const result = parseSkillMdContent(content);
      expect(result.frontmatter).toEqual({
        name: 'test-skill',
        description: 'A test skill',
        metadata: {},
      });
      expect(result.body).toBe('');
    });

    it('handles extra newlines in body', () => {
      const content = `---
name: test-skill
description: A test skill
---


Body with newlines
`;
      const result = parseSkillMdContent(content);
      expect(result.body).toBe('Body with newlines');
    });
  });

  describe('loadSkillFromDir', () => {
    let tempDir: string;

    it('loads a valid skill from a directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions content`,
      );

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.frontmatter.name).toBe('test-skill');
      expect(skill.instructions).toBe('Instructions content');
      expect(skill.resources?.references).toEqual({});
      expect(skill.resources?.assets).toEqual({});
      expect(skill.resources?.scripts).toEqual({});

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['SKILL.md', 'skill.md', 'Skill.md', 'sKiLl.Md'])(
      'loads a valid skill with %s file name',
      async (fileName) => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        await fs.writeFile(
          path.join(skillDir, fileName),
          `---
name: test-skill
description: A test skill
---
Instructions content`,
        );

        const skill = await loadSkillFromDir(skillDir);
        expect(skill.frontmatter.name).toBe('test-skill');
        expect(skill.instructions).toBe('Instructions content');

        await fs.rm(tempDir, {recursive: true, force: true});
      },
    );

    it('throws error if SKILL.md not found', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await expect(loadSkillFromDir(skillDir)).rejects.toThrow(
        /SKILL\.md \(or any case variation like skill\.md\) not found/,
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('throws error if skill name does not match directory name', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'wrong-name');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      await expect(loadSkillFromDir(skillDir)).rejects.toThrow(
        /does not match directory name/,
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('loads resources if they exist', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      await fs.mkdir(path.join(skillDir, 'references'));
      await fs.mkdir(path.join(skillDir, 'references', '__pycache__'));
      await fs.mkdir(path.join(skillDir, 'references', 'subdir'));
      await fs.mkdir(path.join(skillDir, 'assets'));
      await fs.mkdir(path.join(skillDir, 'scripts'));

      await fs.writeFile(
        path.join(skillDir, 'references', 'ref.txt'),
        'reference content',
      );
      await fs.writeFile(
        path.join(skillDir, 'references', 'subdir', 'nested-ref.txt'),
        'nested reference content',
      );
      await fs.writeFile(
        path.join(skillDir, 'references', 'ignored.pyc'),
        'ignored binary extension',
      );
      await fs.writeFile(
        path.join(skillDir, 'references', '__pycache__', 'ignored.txt'),
        'ignored directory content',
      );
      await fs.writeFile(
        path.join(skillDir, 'assets', 'logo.png'),
        Buffer.from([0, 1, 2, 3]),
      );
      await fs.writeFile(
        path.join(skillDir, 'scripts', 'run.sh'),
        'echo hello',
      );

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.resources?.references?.['ref.txt']).toBe(
        'reference content',
      );
      expect(
        skill.resources?.references?.[path.join('subdir', 'nested-ref.txt')],
      ).toBe('nested reference content');
      expect(skill.resources?.references?.['ignored.pyc']).toBeUndefined();
      expect(
        skill.resources?.references?.['__pycache__/ignored.txt'],
      ).toBeUndefined();
      expect(skill.resources?.assets?.['logo.png']).toEqual(
        Buffer.from([0, 1, 2, 3]),
      );
      expect(skill.resources?.scripts?.['run.sh']).toEqual({src: 'echo hello'});
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('handles references, assets, or scripts being files instead of directories', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      // Create references as a file, not a directory
      await fs.writeFile(path.join(skillDir, 'references'), 'not a directory');

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.resources?.references).toEqual({});
      expect(skill.resources?.assets).toEqual({});
      expect(skill.resources?.scripts).toEqual({});
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.skipIf(process.platform === 'win32')(
      'handles unreadable SKILL.md gracefully',
      async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        const skillMdPath = path.join(skillDir, 'SKILL.md');
        await fs.writeFile(
          skillMdPath,
          `---
name: test-skill
description: A test skill
---
Instructions`,
        );
        await fs.chmod(skillMdPath, 0o000);

        try {
          await expect(loadSkillFromDir(skillDir)).rejects.toThrow(
            /SKILL\.md \(or any case variation like skill\.md\) not found/,
          );
        } finally {
          await fs.chmod(skillMdPath, 0o644);
          await fs.rm(tempDir, {recursive: true, force: true});
        }
      },
    );
  });

  describe('validateSkillDir', () => {
    let tempDir: string;

    it('returns no problems for a valid skill directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems).toEqual([]);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['SKILL.md', 'skill.md', 'Skill.md', 'sKiLl.Md'])(
      'returns no problems for a valid skill directory with %s file name',
      async (fileName) => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const skillDir = path.join(tempDir, 'test-skill');
        await fs.mkdir(skillDir);

        await fs.writeFile(
          path.join(skillDir, fileName),
          `---
name: test-skill
description: A test skill
---
Instructions`,
        );

        const problems = await validateSkillDir(skillDir);
        expect(problems).toEqual([]);

        await fs.rm(tempDir, {recursive: true, force: true});
      },
    );

    it('returns problem if directory does not exist', async () => {
      const testPath = '/non/existent/path';
      const problems = await validateSkillDir(testPath);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain(
        `SKILL.md (or any case variation like skill.md) not found in '${path.resolve(testPath)}'.`,
      );
    });

    it('returns problem if SKILL.md missing', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain(
        'SKILL.md (or any case variation like skill.md) not found',
      );

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem for unknown frontmatter fields', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
unknown_field: value
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBeGreaterThan(0);
      expect(
        problems.some((p) => p.includes('Unknown frontmatter fields')),
      ).toBe(true);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem for invalid frontmatter', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'test-skill');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBeGreaterThan(0);
      expect(
        problems.some((p) => p.includes('Invalid YAML in frontmatter:')),
      ).toBe(true);

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('returns problem if name does not match directory name', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
      const skillDir = path.join(tempDir, 'wrong-name');
      await fs.mkdir(skillDir);

      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---
name: test-skill
description: A test skill
---
Instructions`,
      );

      const problems = await validateSkillDir(skillDir);
      expect(problems.length).toBe(1);
      expect(problems[0]).toContain('does not match directory name');

      await fs.rm(tempDir, {recursive: true, force: true});
    });
  });

  describe('loadAllSkillsInDir', () => {
    let tempDir: string;

    it('lists valid skills in a directory', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const skill1Dir = path.join(tempDir, 'skill-1');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill-1
description: Skill 1
---
Instructions`,
      );

      const skill2Dir = path.join(tempDir, 'skill-2');
      await fs.mkdir(skill2Dir);
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill-2
description: Skill 2
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(2);
      expect(skills['skill-1']).toBeDefined();
      expect(skills['skill-2']).toBeDefined();
      expect(skills['skill-1'].frontmatter.name).toBe('skill-1');

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('skips invalid skills and continues', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const validSkillDir = path.join(tempDir, 'valid-skill');
      await fs.mkdir(validSkillDir);
      await fs.writeFile(
        path.join(validSkillDir, 'SKILL.md'),
        `---
name: valid-skill
description: Valid Skill
---
Instructions`,
      );

      const invalidSkillDir = path.join(tempDir, 'invalid-skill');
      await fs.mkdir(invalidSkillDir);
      await fs.writeFile(
        path.join(invalidSkillDir, 'SKILL.md'),
        `---
name: wrong-name
description: Invalid Skill
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(1);
      expect(skills['valid-skill']).toBeDefined();
      expect(skills['wrong-name']).toBeUndefined();

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('handles non-existent directory gracefully', async () => {
      const skills = await loadAllSkillsInDir('/non/existent/path');
      expect(skills).toEqual({});
    });

    it('loads skills from nested subdirectories', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const subdir1 = path.join(tempDir, 'subdir1');
      await fs.mkdir(subdir1);

      const skill1Dir = path.join(subdir1, 'skill-1');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill-1
description: Skill 1
---
Instructions`,
      );

      const skill2Dir = path.join(subdir1, 'skill-2');
      await fs.mkdir(skill2Dir);
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        `---
name: skill-2
description: Skill 2
---
Instructions`,
      );

      const subdir2 = path.join(tempDir, 'subdir2');
      await fs.mkdir(subdir2);

      const skill3Dir = path.join(subdir2, 'skill-3');
      await fs.mkdir(skill3Dir);
      await fs.writeFile(
        path.join(skill3Dir, 'SKILL.md'),
        `---
name: skill-3
description: Skill 3
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(3);
      expect(skills['skill-1']).toBeDefined();
      expect(skills['skill-2']).toBeDefined();
      expect(skills['skill-3']).toBeDefined();

      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it('ignores IGNORED_DIRECTORIES like node_modules', async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));

      const skill1Dir = path.join(tempDir, 'skill-1');
      await fs.mkdir(skill1Dir);
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        `---
name: skill-1
description: Skill 1
---
Instructions`,
      );

      // Create node_modules containing a skill.md
      const nodeModulesDir = path.join(tempDir, 'node_modules');
      await fs.mkdir(nodeModulesDir);
      const nestedSkillDir = path.join(nodeModulesDir, 'skill-2');
      await fs.mkdir(nestedSkillDir);
      await fs.writeFile(
        path.join(nestedSkillDir, 'SKILL.md'),
        `---
name: skill-2
description: Skill 2
---
Instructions`,
      );

      const skills = await loadAllSkillsInDir(tempDir);
      expect(Object.keys(skills).length).toBe(1);
      expect(skills['skill-1']).toBeDefined();
      expect(skills['skill-2']).toBeUndefined();
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.skipIf(process.platform === 'win32')(
      'handles unreadable subdirectory inside base directory gracefully',
      async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
        const subDir = path.join(tempDir, 'unreadable-sub');
        await fs.mkdir(subDir);
        await fs.chmod(subDir, 0o000);

        try {
          const skills = await loadAllSkillsInDir(tempDir);
          expect(skills).toEqual({});
        } finally {
          await fs.chmod(subDir, 0o755);
          await fs.rm(tempDir, {recursive: true, force: true});
        }
      },
    );
  });

  describe('loadSkillFromZipBytes', () => {
    it('successfully loads a skill from valid zip bytes', () => {
      const zip = new AdmZip();
      const skillMd = `---
name: test-skill
description: A test skill loaded from zip
---
Instructions here.`;
      zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
      zip.addFile('references/doc.md', Buffer.from('Doc content', 'utf-8'));
      zip.addFile(
        'references/doc.pyc',
        Buffer.from('ignored content', 'utf-8'),
      );
      zip.addFile(
        'references/__pycache__/foo.py',
        Buffer.from('ignored pycache', 'utf-8'),
      );
      zip.addFile('references/subdir/', Buffer.alloc(0));
      zip.addFile('assets/image.png', Buffer.from([0, 1, 2]));
      zip.addFile('scripts/run.sh', Buffer.from('echo hello', 'utf-8'));

      const zipBytes = zip.toBuffer();
      const skill = loadSkillFromZipBytes(zipBytes);

      expect(skill.frontmatter).toEqual({
        name: 'test-skill',
        description: 'A test skill loaded from zip',
        metadata: {},
      });
      expect(skill.instructions).toBe('Instructions here.');
      expect(skill.resources).toBeDefined();
      expect(skill.resources?.references?.['doc.md']).toBe('Doc content');
      expect(skill.resources?.references?.['doc.pyc']).toBeUndefined();
      expect(
        skill.resources?.references?.['__pycache__/foo.py'],
      ).toBeUndefined();
      expect(skill.resources?.assets?.['image.png']).toEqual(
        Buffer.from([0, 1, 2]),
      );
      expect(skill.resources?.scripts?.['run.sh']).toEqual({src: 'echo hello'});
    });

    it('rejects zip files containing dangerous paths (Zip-Slip)', () => {
      const createDangerousZip = (pathName: string) => {
        const zip = new AdmZip();
        zip.addFile('temp.txt', Buffer.from('content'));
        const entry = zip.getEntries()[0];
        entry.entryName = pathName;
        return zip.toBuffer();
      };

      expect(() =>
        loadSkillFromZipBytes(createDangerousZip('../outside.txt')),
      ).toThrow('Dangerous zip entry ignored: ../outside.txt');
      expect(() =>
        loadSkillFromZipBytes(createDangerousZip('/absolute.txt')),
      ).toThrow('Dangerous zip entry ignored: /absolute.txt');
      expect(() =>
        loadSkillFromZipBytes(createDangerousZip('foo/../../bar.txt')),
      ).toThrow('Dangerous zip entry ignored: foo/../../bar.txt');
    });

    it('rejects zip files with missing SKILL.md', () => {
      const zip = new AdmZip();
      zip.addFile('references/doc.md', Buffer.from('Doc content'));
      const zipBytes = zip.toBuffer();

      expect(() => loadSkillFromZipBytes(zipBytes)).toThrow(
        'SKILL.md not found in zipped filesystem.',
      );
    });

    it('rejects if name inside SKILL.md is invalid or missing', () => {
      const createZipWithSkillMd = (content: string) => {
        const zip = new AdmZip();
        zip.addFile('SKILL.md', Buffer.from(content, 'utf-8'));
        return zip.toBuffer();
      };

      // Missing name
      expect(() =>
        loadSkillFromZipBytes(
          createZipWithSkillMd(`---
description: Missing name
---
Instructions`),
        ),
      ).toThrow();

      // Invalid name (capital letters)
      expect(() =>
        loadSkillFromZipBytes(
          createZipWithSkillMd(`---
name: Invalid-Name
description: Invalid name
---
Instructions`),
        ),
      ).toThrow();
    });
  });
});
