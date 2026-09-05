/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  CodeExecutionResult,
  Context,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeEnvironment} from './fake_environment.js';

const SKILL: Skill = {
  frontmatter: {name: 'skill1', description: 'A test skill'},
  instructions: 'Test instructions',
  resources: {
    references: {'ref1.md': 'reference one'},
    scripts: {'run.sh': {src: 'echo hello'}},
  },
};

/** The command the tests ask the environment to run. */
const COMMAND = 'sh skills/skill1/scripts/run.sh';

/** An error envelope the skill tools return instead of throwing. */
interface ErrorResponse {
  error: string;
  errorCode: string;
}

class StubCodeExecutor extends BaseCodeExecutor {
  calls = 0;

  override async executeCode(): Promise<CodeExecutionResult> {
    this.calls++;
    return {stdout: 'executor out', stderr: '', outputFiles: []};
  }
}

function createContext(options: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
  agent?: LlmAgent;
}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test_invocation',
      agent:
        options.agent ??
        new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
      session: createSession({id: 's', appName: 'app', userId: 'u'}),
      sessionService: new InMemorySessionService(),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: options.functionCallId,
    toolConfirmation: options.toolConfirmation,
  });
}

/** A skill whose only reference escapes the skill directory. */
function skillWithResourceNamed(name: string): Skill {
  return {
    frontmatter: {name: 'skill1', description: 'A test skill'},
    instructions: 'Test instructions',
    resources: {
      references: {[name]: 'reference one'},
      scripts: {'run.sh': {src: 'echo hello'}},
    },
  };
}

describe('environment command confirmation gate', () => {
  it('requests confirmation and runs nothing on the first call', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {environment: env}),
    );
    const toolContext = createContext({functionCallId: 'fc-1'});

    const result = await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: COMMAND},
      toolContext,
    });

    expect(result).toEqual({
      partial: 'This tool call needs external confirmation before completion.',
    });
    expect(env.executeCalls).toEqual([]);
    expect(env.writeCalls).toEqual([]);

    const requested = toolContext.actions.requestedToolConfirmations['fc-1'];
    expect(requested).toBeDefined();
    expect(requested.confirmed).toBe(false);
    expect(requested.hint).toContain(COMMAND);
    expect(requested.payload).toEqual({skillName: 'skill1', command: COMMAND});
  });

  it('refuses the command when the client rejects it', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {environment: env}),
    );

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: COMMAND},
      toolContext: createContext({
        functionCallId: 'fc-1',
        toolConfirmation: new ToolConfirmation({confirmed: false}),
      }),
    })) as ErrorResponse;

    expect(result.errorCode).toBe('CONFIRMATION_REJECTED');
    expect(result.error).toBe(
      'Skill script command was not confirmed and was rejected.',
    );
    expect(env.executeCalls).toEqual([]);
    expect(env.writeCalls).toEqual([]);
  });

  it('runs the command once confirmed and asks for nothing more', async () => {
    const env = new FakeEnvironment({
      workingDir: '/workspace',
      result: {exitCode: 0, stdout: 'hello', stderr: '', timedOut: false},
    });
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {environment: env}),
    );
    const toolContext = createContext({
      functionCallId: 'fc-1',
      toolConfirmation: new ToolConfirmation({confirmed: true}),
    });

    const result = await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: COMMAND},
      toolContext,
    });

    expect(result).toEqual({
      stdout: 'hello',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    });
    expect(env.executeCalls).toHaveLength(1);
    expect(toolContext.actions.requestedToolConfirmations).toEqual({});
  });

  it('rejects a missing command before it asks for confirmation', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {
        environment: new FakeEnvironment({workingDir: '/workspace'}),
      }),
    );
    const toolContext = createContext({functionCallId: 'fc-1'});

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh'},
      toolContext,
    })) as ErrorResponse;

    expect(result.errorCode).toBe('INVALID_ARGUMENTS');
    expect(toolContext.actions.requestedToolConfirmations).toEqual({});
  });

  it('reports an unknown script before it asks for confirmation', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {
        environment: new FakeEnvironment({workingDir: '/workspace'}),
      }),
    );
    const toolContext = createContext({functionCallId: 'fc-1'});

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'absent.sh', command: COMMAND},
      toolContext,
    })) as ErrorResponse;

    expect(result.errorCode).toBe('SCRIPT_NOT_FOUND');
    expect(toolContext.actions.requestedToolConfirmations).toEqual({});
  });

  it('leaves the code executor path ungated', async () => {
    const executor = new StubCodeExecutor();
    const toolset = new SkillToolset([SKILL], {codeExecutor: executor});
    const toolContext = createContext({functionCallId: 'fc-1'});

    const result = (await new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh'},
      toolContext,
    })) as {stdout: string};

    expect(result.stdout).toBe('executor out');
    expect(executor.calls).toBe(1);
    expect(toolContext.actions.requestedToolConfirmations).toEqual({});
  });
});

describe('environment materialization path guard', () => {
  function runWithSkill(skill: Skill, env: FakeEnvironment) {
    return new RunSkillScriptTool(
      new SkillToolset([skill], {environment: env}),
    ).runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: COMMAND},
      toolContext: createContext({
        toolConfirmation: new ToolConfirmation({confirmed: true}),
      }),
    });
  }

  it('refuses a resource name that climbs out of the skill directory', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});

    const result = (await runWithSkill(
      skillWithResourceNamed('../../../etc/passwd'),
      env,
    )) as ErrorResponse;

    expect(result.errorCode).toBe('EXECUTION_ERROR');
    expect(result.error).toContain('Path traversal detected');
    expect(result.error).toContain('references/../../../etc/passwd');
    expect(env.writeCalls).toEqual([]);
    expect(env.executeCalls).toEqual([]);
  });

  it('contains an absolute resource name inside the skill directory', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});

    await runWithSkill(skillWithResourceNamed('/etc/cron.d/evil'), env);

    expect(env.writeCalls.map((w) => w.filePath)).toEqual([
      '/workspace/skills/skill1/references/etc/cron.d/evil',
      '/workspace/skills/skill1/scripts/run.sh',
    ]);
  });

  it('refuses a resource name that climbs out with backslashes', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});

    const result = (await runWithSkill(
      skillWithResourceNamed('..\\..\\..\\Windows\\System32\\evil.dll'),
      env,
    )) as ErrorResponse;

    expect(result.errorCode).toBe('EXECUTION_ERROR');
    expect(result.error).toContain('Path traversal detected');
    expect(env.writeCalls).toEqual([]);
  });

  it('keeps a drive-letter working directory out of the host cwd', async () => {
    const env = new FakeEnvironment({workingDir: 'C:\\workspace'});

    await runWithSkill(skillWithResourceNamed('ref1.md'), env);

    expect(env.writeCalls.map((w) => w.filePath)).toEqual([
      'C:/workspace/skills/skill1/references/ref1.md',
      'C:/workspace/skills/skill1/scripts/run.sh',
    ]);
  });

  it('refuses a script name that climbs out of the skill directory', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    const skill: Skill = {
      frontmatter: {name: 'skill1', description: 'A test skill'},
      instructions: 'Test instructions',
      resources: {
        scripts: {
          'run.sh': {src: 'echo hello'},
          '../../escape.sh': {src: 'echo escaped'},
        },
      },
    };

    const result = (await runWithSkill(skill, env)) as ErrorResponse;

    expect(result.errorCode).toBe('EXECUTION_ERROR');
    expect(result.error).toContain('Path traversal detected');
    expect(env.writeCalls).toEqual([]);
  });

  it('writes a nested resource name that stays inside', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});

    const result = await runWithSkill(
      skillWithResourceNamed('nested/dir/ref1.md'),
      env,
    );

    expect(result).toEqual({
      stdout: '',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    });
    expect(env.writeCalls.map((w) => w.filePath)).toEqual([
      '/workspace/skills/skill1/references/nested/dir/ref1.md',
      '/workspace/skills/skill1/scripts/run.sh',
    ]);
  });
});
