/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  InvocationContext,
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
  Skill,
  SkillToolset,
  ToolConfirmation,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const IS_UNIX = os.platform() === 'linux' || os.platform() === 'darwin';

describe('RunSkillInlineScriptTool Integration with UnsafeLocalCodeExecutor', () => {
  // These integration tests exercise real code execution, which is gated behind
  // a human-in-the-loop confirmation. Supply an already-confirmed confirmation
  // so the tool proceeds to execute (see run_skill_inline_script_tool.ts).
  function createMockContext(agentName = 'test-agent') {
    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: {name: agentName},
      } as unknown as InvocationContext,
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });
  }

  const resourceSkill: Skill = {
    frontmatter: {
      name: 'resource-skill',
      description: 'A skill whose resources back inline snippets',
    },
    instructions: 'Use the bundled resources.',
    resources: {
      references: {
        'data.txt': 'hello from skill reference',
      },
      assets: {
        'config.json': '{"mode":"test"}',
      },
      scripts: {
        'helper.js': {
          src: 'module.exports.greet = () => "hello from skill helper";',
        },
      },
    },
  };

  it('successfully executes a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log("hello from real js");',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real js');
    expect(result.stderr).toBe('');
  });

  it('successfully executes a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'echo "hello from real sh"',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real sh');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.error("some js error"); process.exit(1);',
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some js error');
  });

  it('captures stderr and exit code from a real Shell inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: '>&2 echo "some sh error"; exit 2',
        language: CodeExecutionLanguage.SHELL,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some sh error');
  });

  it('successfully executes a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'print("hello from real python")',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('hello from real python');
    expect(result.stderr).toBe('');
  });

  it('captures stderr from a real Python inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content:
          'import sys; sys.stderr.write("some python error\\n"); sys.exit(1)',
        language: CodeExecutionLanguage.PYTHON,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stderr).toContain('some python error');
  });

  it('creates files in process.cwd returned from execution', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();
    expect(result.outputFiles?.length).toBeGreaterThan(0);

    const outputFile = result.outputFiles?.find((f) => f.name === testFileName);
    expect(outputFile).toBeDefined();

    // Verify file was created in process.cwd()
    const fullPath = path.join(process.cwd(), testFileName);
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // Clean up
    await fs.unlink(fullPath);
  });

  it('successfully passes array arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: ['arg1', 'arg2'],
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('arg1 arg2');
  });

  it('successfully passes object arguments to a JavaScript inline script', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {
        script_content: 'console.log(process.argv.slice(2).join(" "));',
        language: CodeExecutionLanguage.JAVASCRIPT,
        args: {flag1: 'val1', flag2: 'val2'},
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.stdout).toContain('--flag1 val1 --flag2 val2');
  });

  it('handles file collisions by appending a numeric suffix', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const toolset = new SkillToolset([], {codeExecutor: executor});
    const tool = new RunSkillInlineScriptTool(toolset);

    const testFileName = `test_inline_output_${Date.now()}.txt`;
    const testFileContent = 'hello from output file';

    // Pre-create the target file to force a collision
    const targetFile = path.join(process.cwd(), testFileName);
    await fs.writeFile(targetFile, 'existing content');

    const result = (await tool.runAsync({
      args: {
        script_content: `const fs = require('fs'); fs.writeFileSync('${testFileName}', '${testFileContent}');`,
        language: CodeExecutionLanguage.JAVASCRIPT,
      },
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result).toBeDefined();
    expect(result.outputFiles).toBeDefined();

    const baseName = path.basename(testFileName, '.txt');
    const expectedName = `${baseName}_2.txt`;

    const outputFile = result.outputFiles?.find((f) => f.name === expectedName);
    expect(outputFile).toBeDefined();

    // Verify collision file was created in process.cwd()
    const fullPath = path.join(process.cwd(), expectedName);
    const exists = await fs
      .access(fullPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(fullPath, 'utf-8');
    expect(content).toBe(testFileContent);

    // Clean up both files
    await fs.unlink(targetFile);
    await fs.unlink(fullPath);
  });

  describe('skill_name', () => {
    // UnsafeLocalCodeExecutor skips input files from its output scan by
    // comparing `f.name` ('scripts/helper.js') to the path returned by a
    // recursive readdir, which uses '\' on Windows. The skill's own resources
    // would therefore come back as output files and be materialized into
    // process.cwd(), writing into the repo's real top-level directories. Gate
    // the cases that actually mount skill files to POSIX until that separator
    // mismatch is fixed.
    it.skipIf(!IS_UNIX)(
      'reads a skill reference file from the script working directory',
      async () => {
        const executor = new UnsafeLocalCodeExecutor();
        const toolset = new SkillToolset([resourceSkill], {
          codeExecutor: executor,
        });
        const tool = new RunSkillInlineScriptTool(toolset);

        const result = (await tool.runAsync({
          args: {
            script_content:
              "console.log(require('node:fs').readFileSync('references/data.txt','utf8'));",
            language: CodeExecutionLanguage.JAVASCRIPT,
            skill_name: 'resource-skill',
          },
          toolContext: createMockContext(),
        })) as CodeExecutionResult;

        expect(result.stdout).toContain('hello from skill reference');
      },
    );

    it('fails to read skill files when skill_name is omitted', async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([resourceSkill], {
        codeExecutor: executor,
      });
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = (await tool.runAsync({
        args: {
          script_content:
            "console.log(require('node:fs').readFileSync('references/data.txt','utf8'));",
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createMockContext(),
      })) as CodeExecutionResult;

      expect(result.stderr).toContain('ENOENT');
    });

    it.skipIf(!IS_UNIX)(
      'requires a skill script from an inline snippet',
      async () => {
        const executor = new UnsafeLocalCodeExecutor();
        const toolset = new SkillToolset([resourceSkill], {
          codeExecutor: executor,
        });
        const tool = new RunSkillInlineScriptTool(toolset);

        const result = (await tool.runAsync({
          args: {
            script_content:
              "console.log(require('./scripts/helper.js').greet());",
            language: CodeExecutionLanguage.JAVASCRIPT,
            skill_name: 'resource-skill',
          },
          toolContext: createMockContext(),
        })) as CodeExecutionResult;

        expect(result.stdout).toContain('hello from skill helper');
      },
    );

    it.skipIf(!IS_UNIX)(
      'reads a skill asset from a Python inline script',
      async () => {
        const executor = new UnsafeLocalCodeExecutor();
        const toolset = new SkillToolset([resourceSkill], {
          codeExecutor: executor,
        });
        const tool = new RunSkillInlineScriptTool(toolset);

        const result = (await tool.runAsync({
          args: {
            script_content: "print(open('assets/config.json').read())",
            language: CodeExecutionLanguage.PYTHON,
            skill_name: 'resource-skill',
          },
          toolContext: createMockContext(),
        })) as CodeExecutionResult;

        expect(result.stdout).toContain('"mode"');
      },
    );

    it('returns SKILL_NOT_FOUND for an unknown skill with a real executor', async () => {
      const executor = new UnsafeLocalCodeExecutor();
      const toolset = new SkillToolset([resourceSkill], {
        codeExecutor: executor,
      });
      const tool = new RunSkillInlineScriptTool(toolset);

      const result = await tool.runAsync({
        args: {
          script_content: 'console.log("never runs");',
          language: CodeExecutionLanguage.JAVASCRIPT,
          skill_name: 'no-such-skill',
        },
        toolContext: createMockContext(),
      });

      expect(result).toEqual({
        error: "Skill 'no-such-skill' not found.",
        errorCode: RunSkillInlineScriptErrorCode.SKILL_NOT_FOUND,
      });
    });
  });
});
