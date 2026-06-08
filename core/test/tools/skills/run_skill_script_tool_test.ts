/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  CodeExecutionLanguage,
  CodeExecutionResult,
  Context,
  ExecuteCodeParams,
  File,
  InvocationContext,
  LlmAgent,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {materializeFiles} from '../../../src/utils/file_utils.js';

vi.mock('../../../src/utils/file_utils.js', () => ({
  materializeFiles: vi.fn(),
}));

class MockCodeExecutor extends BaseCodeExecutor {
  mockResult: CodeExecutionResult = {
    stdout: '',
    stderr: '',
    outputFiles: [],
  };
  executeCodeParams: ExecuteCodeParams | undefined;
  shouldThrow = false;

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    this.executeCodeParams = params;
    if (this.shouldThrow) {
      throw new Error('Mock execution failure');
    }
    return this.mockResult;
  }
}

interface ToolErrorResponse {
  error: string;
  errorCode: string;
}

describe('RunSkillScriptTool', () => {
  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
  ): Context {
    const agentObj: Record<string | symbol, unknown> = {name: agentName};
    if (agentExecutor) {
      agentObj['codeExecutor'] = agentExecutor;
      agentObj[Symbol.for('google.adk.llmAgent')] = true;
    }

    return new Context({
      invocationContext: {
        session: {state: {}},
        agent: agentObj as unknown as LlmAgent,
      } as unknown as InvocationContext,
    });
  }

  const mockSkill: Skill = {
    frontmatter: {
      name: 'test-skill',
      description: 'A test skill',
    },
    instructions: 'Test instructions',
    resources: {
      scripts: {
        'setup.js': {src: 'console.log("setup");'},
        'run.sh': {src: 'echo "run";'},
      },
      references: {
        'doc.txt': 'Doc content',
      },
      assets: {
        'binary.dat': Buffer.from('hello', 'utf8'),
      },
    },
  };

  it('returns declaration parameters matching schema', () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    expect(tool.name).toBe('run_skill_script');
    expect(tool.description).toBe(
      "Executes a script from a skill's scripts/ directory.",
    );
    const decl = tool._getDeclaration();
    expect(decl.name).toBe('run_skill_script');
    expect(decl.parameters?.required).toContain('skill_name');
    expect(decl.parameters?.required).toContain('script_path');
  });

  it('returns error if skill name is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Skill name is required.',
      errorCode: 'MISSING_SKILL_NAME',
    });
  });

  it('returns error if script path is missing', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'Script path is required.',
      errorCode: 'MISSING_SCRIPT_PATH',
    });
  });

  it('returns error if skill not found', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'invalid-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Skill 'invalid-skill' not found.",
      errorCode: 'SKILL_NOT_FOUND',
    });
  });

  it('returns error if script not found in skill', async () => {
    const toolset = new SkillToolset([mockSkill]);
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/invalid.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: "Script 'scripts/invalid.js' not found in skill 'test-skill'.",
      errorCode: 'SCRIPT_NOT_FOUND',
    });
  });

  it('returns error if no code executor configured', async () => {
    const toolset = new SkillToolset([mockSkill]); // no executor
    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error: 'No code executor configured.',
      errorCode: 'NO_CODE_EXECUTOR',
    });
  });

  it('executes script successfully via mock executor with JS wrapper', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('');
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "require('./scripts/setup.js');",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.JAVASCRIPT,
    );
  });

  it('extracts skill resource files correctly', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();

    // 1 script, 1 reference, 1 asset
    expect(inputFiles?.length).toBe(4); // setup.js, run.sh, doc.txt, binary.dat

    const fileNames = inputFiles?.map((f) => f.name);
    expect(fileNames).toContain('scripts/setup.js');
    expect(fileNames).toContain('scripts/run.sh');
    expect(fileNames).toContain('references/doc.txt');
    expect(fileNames).toContain('assets/binary.dat');

    const binaryFile = inputFiles?.find((f) => f.name === 'assets/binary.dat');
    expect(binaryFile?.contentEncoding).toBe('base64');
  });

  it('calls materializeFiles with output files from executor', async () => {
    const mockExecutor = new MockCodeExecutor();
    const testFile = {
      name: 'output.txt',
      content: 'hello',
      contentEncoding: 'utf8',
      mimeType: 'text/plain',
    } as File;
    mockExecutor.mockResult = {
      stdout: '',
      stderr: '',
      outputFiles: [testFile],
    };

    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    expect(materializeFiles).toHaveBeenCalledWith([testFile]);
  });

  it('skips undefined skill resources', async () => {
    const mockExecutor = new MockCodeExecutor();
    const skillWithUndefinedResource: Skill = {
      frontmatter: {
        name: 'undefined-resource-skill',
        description: 'A skill with undefined resource',
      },
      instructions: 'Test instructions',
      resources: {
        scripts: {
          'setup.js': {src: 'console.log("setup");'},
        },
        references: {
          'doc.txt': undefined as unknown as string,
        },
      },
    };
    const toolset = new SkillToolset([skillWithUndefinedResource], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {
        skill_name: 'undefined-resource-skill',
        script_path: 'scripts/setup.js',
      },
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();
    expect(inputFiles?.length).toBe(1);
    expect(inputFiles?.[0].name).toBe('scripts/setup.js');
  });

  it('returns error on registry fetch failure', async () => {
    const toolset = new SkillToolset([]);
    vi.spyOn(toolset, 'getOrFetchSkill').mockRejectedValue(
      new Error('Registry connection error'),
    );

    const tool = new RunSkillScriptTool(toolset);
    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result).toEqual({
      error:
        "Failed to fetch skill 'test-skill' from registry: Error: Registry connection error",
      errorCode: 'REGISTRY_ERROR',
    });
  });

  it('extracts skill resource files correctly when resources are partially empty', async () => {
    const mockSkillPartial: Skill = {
      frontmatter: {name: 'test-skill-partial', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.js': {src: 'console.log("setup");'},
        },
        // references and assets are missing
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkillPartial], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill-partial', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();
    expect(inputFiles?.length).toBe(1);
    expect(inputFiles?.[0].name).toBe('scripts/setup.js');
  });

  it('executes script successfully via mock executor with TS wrapper', async () => {
    const tsSkill: Skill = {
      frontmatter: {name: 'ts-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.ts': {src: 'console.log("ts setup");'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([tsSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'ts-skill', script_path: 'scripts/setup.ts'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "require('ts-node/register');\nrequire('./scripts/setup.ts');",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.TYPESCRIPT,
    );
  });

  it('ignores resource files with invalid or undefined content type', async () => {
    const invalidSkill: Skill = {
      frontmatter: {name: 'invalid-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.js': {src: 'console.log("setup");'},
          'invalid.js': {src: 123 as unknown as string}, // invalid content
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([invalidSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'invalid-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext(),
    });

    const inputFiles =
      mockExecutor.executeCodeParams?.codeExecutionInput.inputFiles;
    expect(inputFiles).toBeDefined();
    // Only setup.js should be materialized, invalid.js should be skipped because of undefined/invalid content.
    expect(inputFiles?.length).toBe(1);
    expect(inputFiles?.[0].name).toBe('scripts/setup.js');
  });

  it('resolves script path even if it does not start with scripts/', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'setup.js'}, // no scripts/ prefix
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "require('./setup.js');",
    );
  });

  it('falls back to agent code executor if not configured on toolset', async () => {
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([mockSkill]); // no executor on toolset
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
      toolContext: createMockContext('test-agent', mockExecutor), // executor on agent
    })) as CodeExecutionResult;

    expect(result.stdout).toBe('');
    expect(mockExecutor.executeCodeParams).toBeDefined();
  });

  it('executes python script successfully with python wrapper', async () => {
    const pySkill: Skill = {
      frontmatter: {name: 'py-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.py': {src: 'print("py setup")'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([pySkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'py-skill', script_path: 'scripts/setup.py'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      "import runpy\nrunpy.run_path('./scripts/setup.py', run_name='__main__')",
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.PYTHON,
    );
  });

  it('executes shell script successfully with shell wrapper', async () => {
    const shSkill: Skill = {
      frontmatter: {name: 'sh-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.sh': {src: 'echo hello'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([shSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'sh-skill', script_path: 'scripts/setup.sh'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      'source ./scripts/setup.sh "$@"',
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.SHELL,
    );
  });

  it('executes powershell script successfully with powershell wrapper', async () => {
    const psSkill: Skill = {
      frontmatter: {name: 'ps-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.ps1': {src: 'Write-Output "ps"'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([psSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'ps-skill', script_path: 'scripts/setup.ps1'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      '& .\\scripts\\setup.ps1 $args',
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.POWERSHELL,
    );
  });

  it('executes cmd script successfully with cmd wrapper', async () => {
    const cmdSkill: Skill = {
      frontmatter: {name: 'cmd-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.bat': {src: 'echo bat'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([cmdSkill], {codeExecutor: mockExecutor});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'cmd-skill', script_path: 'scripts/setup.bat'},
      toolContext: createMockContext(),
    });

    expect(mockExecutor.executeCodeParams?.codeExecutionInput.code).toBe(
      'call .\\scripts\\setup.bat %*',
    );
    expect(mockExecutor.executeCodeParams?.codeExecutionInput.language).toBe(
      CodeExecutionLanguage.WINDOWS_CMD,
    );
  });

  it('throws execution error for unsupported script language extension', async () => {
    const unknownSkill: Skill = {
      frontmatter: {name: 'unknown-skill', description: 'desc'},
      instructions: 'inst',
      resources: {
        scripts: {
          'setup.unknown': {src: 'unknown script'},
        },
      },
    };
    const mockExecutor = new MockCodeExecutor();
    const toolset = new SkillToolset([unknownSkill], {
      codeExecutor: mockExecutor,
    });
    const tool = new RunSkillScriptTool(toolset);

    const result = (await tool.runAsync({
      args: {skill_name: 'unknown-skill', script_path: 'scripts/setup.unknown'},
      toolContext: createMockContext(),
    })) as ToolErrorResponse;

    expect(result.error).toContain('Unsupported wrapper language');
    expect(result.errorCode).toBe('EXECUTION_ERROR');
  });
});
