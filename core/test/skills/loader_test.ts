/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  loadAllSkillsInDir,
  loadSkillFromDir,
  parseSkillMdContent,
  validateSkillDir,
} from '../../src/skills/loader.js';

/**
 * Writes a throwaway skill directory whose name matches the `test-skill`
 * frontmatter name, validates it, and removes it again.
 */
async function validateFrontmatter(frontmatter: string): Promise<string[]> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-test-'));
  try {
    const skillDir = path.join(tempDir, 'test-skill');
    await fs.mkdir(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\n${frontmatter}\n---\nInstructions`,
    );
    return await validateSkillDir(skillDir);
  } finally {
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

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

    it('handles tables in body', () => {
      const body = `Body with table

| Column 1 | Column 2 |
|---|---|
| Cell 1 | Cell 2 |`;
      const content = `---
name: test-skill
description: A test skill
---
${body}
`;
      const result = parseSkillMdContent(content);
      expect(result.body).toBe(body);
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
      await fs.mkdir(path.join(skillDir, 'assets'));
      await fs.mkdir(path.join(skillDir, 'scripts'));

      await fs.writeFile(
        path.join(skillDir, 'references', 'ref.txt'),
        'reference content',
      );
      await fs.writeFile(
        path.join(skillDir, 'assets', 'logo.png'),
        'binary content',
      );
      await fs.writeFile(
        path.join(skillDir, 'scripts', 'run.sh'),
        'echo hello',
      );

      const skill = await loadSkillFromDir(skillDir);
      expect(skill.resources?.references?.['ref.txt']).toBe(
        'reference content',
      );
      expect(skill.resources?.assets?.['logo.png']).toBe('binary content');
      expect(skill.resources?.scripts?.['run.sh']).toEqual({src: 'echo hello'});

      await fs.rm(tempDir, {recursive: true, force: true});
    });
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

    it.each([
      ['agent', 'Explore'],
      ['argument-hint', "'[issue-number]'"],
      ['arguments', 'issue branch'],
      ['background', 'false'],
      ['context', 'fork'],
      ['disable-model-invocation', 'true'],
      ['disallowed-tools', 'AskUserQuestion'],
      ['effort', 'high'],
      ['hooks', '{}'],
      ['model', 'inherit'],
      ['paths', "'src/**/*.ts'"],
      ['shell', 'bash'],
      ['user-invocable', 'false'],
      ['when_to_use', 'When the user asks to deploy'],
    ])('accepts the %s client directive', async (key, value) => {
      const problems = await validateFrontmatter(
        `name: test-skill\ndescription: A test skill\n${key}: ${value}`,
      );
      expect(problems).toEqual([]);
    });

    it('accepts a skill combining client directives with allowed-tools', async () => {
      const problems = await validateFrontmatter(
        [
          'name: test-skill',
          'description: Deploy the application to production.',
          'disable-model-invocation: true',
          'context: fork',
          'allowed-tools: Bash(git:*) Read',
        ].join('\n'),
      );
      expect(problems).toEqual([]);
    });

    it('still reports near-miss typos of known frontmatter fields', async () => {
      const problems = await validateFrontmatter(
        [
          'name: test-skill',
          'description: A test skill',
          'disable_model_invocation: true',
          'descriptoin: oops',
        ].join('\n'),
      );
      expect(problems).toEqual([
        'Unknown frontmatter fields: [descriptoin, disable_model_invocation]',
      ]);
    });

    it('accepts the spec allowed-tools key despite its allowedTools alias', async () => {
      const problems = await validateFrontmatter(
        'name: test-skill\ndescription: A test skill\nallowed-tools: Read Grep',
      );
      expect(problems).toEqual([]);
    });

    it('accepts the snake_case allowed_tools spelling', async () => {
      const problems = await validateFrontmatter(
        'name: test-skill\ndescription: A test skill\nallowed_tools: Read Grep',
      );
      expect(problems).toEqual([]);
    });

    it('accepts every Agent Skills specification key', async () => {
      const problems = await validateFrontmatter(
        [
          'name: test-skill',
          'description: A test skill',
          'license: Apache-2.0',
          'compatibility: Requires git',
          'metadata:',
          '  author: example-org',
        ].join('\n'),
      );
      expect(problems).toEqual([]);
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
  });
});
