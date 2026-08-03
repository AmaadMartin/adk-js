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
  FileContentEncoding,
  InvocationContext,
  LlmAgent,
  RunSkillScriptTool,
  SessionArtifactService,
  Skill,
  SkillToolset,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {InMemoryArtifactService} from '../../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import {materializeFiles} from '../../../src/utils/file_utils.js';
import {logger} from '../../../src/utils/logger.js';

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

/** The tool result once artifact persistence has augmented it. */
type ArtifactAugmentedResult = CodeExecutionResult & {
  savedArtifacts: Record<string, number>;
};

describe('RunSkillScriptTool', () => {
  function createMockContext(
    agentName = 'test-agent',
    agentExecutor?: BaseCodeExecutor,
    artifactService?: SessionArtifactService,
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
        artifactService,
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

  describe('artifact persistence', () => {
    const outputFile: File = {
      name: 'chart.png',
      content: Buffer.from('chart bytes', 'utf-8').toString('base64'),
      contentEncoding: FileContentEncoding.BASE64,
      mimeType: 'image/png',
    };

    function createExecutor(): MockCodeExecutor {
      const executor = new MockCodeExecutor();
      executor.mockResult = {
        stdout: 'script ran',
        stderr: '',
        outputFiles: [{...outputFile}],
      };
      return executor;
    }

    function createArtifactService(): ScopedArtifactService {
      return new ScopedArtifactService(
        new InMemoryArtifactService(),
        'test-app',
        'test-user',
        'test-session',
      );
    }

    function runScript(
      executor: MockCodeExecutor,
      artifactService?: SessionArtifactService,
    ): Promise<unknown> {
      const toolset = new SkillToolset([mockSkill], {codeExecutor: executor});
      return new RunSkillScriptTool(toolset).runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
        toolContext: createMockContext('test-agent', executor, artifactService),
      });
    }

    beforeEach(() => {
      vi.mocked(materializeFiles).mockImplementation(async (files) => files);
    });

    afterEach(() => {
      vi.mocked(materializeFiles).mockReset();
      vi.restoreAllMocks();
    });

    it('reports saved artifacts when an artifact service is configured', async () => {
      const artifactService = createArtifactService();

      const result = (await runScript(
        createExecutor(),
        artifactService,
      )) as ArtifactAugmentedResult;

      expect(result.savedArtifacts).toEqual({'chart.png': 0});
      expect(result.outputFiles).toEqual([outputFile]);
      expect(
        (await artifactService.loadArtifact({filename: 'chart.png'}))
          ?.inlineData?.data,
      ).toBe(outputFile.content);
    });

    it('saves under the executor-reported name, not the materialized one', async () => {
      const artifactService = createArtifactService();
      const saveSpy = vi.spyOn(artifactService, 'saveArtifact');
      vi.mocked(materializeFiles).mockImplementation(async (files) => {
        files.forEach((file) => {
          file.name = `renamed_${file.name}`;
        });
        return files;
      });

      const result = (await runScript(
        createExecutor(),
        artifactService,
      )) as ArtifactAugmentedResult;

      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({filename: 'chart.png'}),
      );
      expect(result.savedArtifacts).toEqual({'chart.png': 0});
      expect(result.outputFiles[0].name).toBe('renamed_chart.png');
    });

    it('saves artifacts before materializing the files', async () => {
      const calls: string[] = [];
      const artifactService = createArtifactService();
      vi.spyOn(artifactService, 'saveArtifact').mockImplementation(async () => {
        calls.push('saveArtifact');
        return 0;
      });
      vi.mocked(materializeFiles).mockImplementation(async (files) => {
        calls.push('materializeFiles');
        return files;
      });

      await runScript(createExecutor(), artifactService);

      expect(calls).toEqual(['saveArtifact', 'materializeFiles']);
    });

    it('returns the plain result when no artifact service is configured', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const result = (await runScript(createExecutor())) as CodeExecutionResult;

      expect(result).not.toHaveProperty('savedArtifacts');
      expect(result.stdout).toBe('script ran');
      expect(result.outputFiles).toEqual([outputFile]);
      // The pre-existing no-artifact-service setup must stay quiet.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('omits savedArtifacts and still succeeds when every save fails', async () => {
      const artifactService = createArtifactService();
      vi.spyOn(artifactService, 'saveArtifact').mockRejectedValue(
        new Error('artifact backend unavailable'),
      );

      const result = (await runScript(
        createExecutor(),
        artifactService,
      )) as CodeExecutionResult;

      expect(result).not.toHaveProperty('savedArtifacts');
      expect(result).not.toHaveProperty('error');
      expect(result.stdout).toBe('script ran');
      expect(result.outputFiles).toEqual([outputFile]);
    });
  });
});
