/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  ExecutionResult,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LocalEnvironment,
  PluginManager,
  RunSkillScriptTool,
  Skill,
  SkillToolset,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FakeEnvironment} from './fake_environment.js';

const SKILL: Skill = {
  frontmatter: {name: 'skill1', description: 'A test skill'},
  instructions: 'Test instructions',
  resources: {
    references: {'ref1.md': 'reference one'},
    assets: {'asset1.json': '{"a": 1}'},
    scripts: {'run.sh': {src: 'echo hello'}},
  },
};

function createContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test_invocation',
      agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
      session: createSession({id: 's', appName: 'app', userId: 'u'}),
      sessionService: new InMemorySessionService(),
      pluginManager: new PluginManager([]),
    }),
  });
}

/**
 * A context that has already approved the command, so the environment path
 * runs it instead of pausing on the confirmation gate.
 */
function createConfirmedContext(): Context {
  return new Context({
    invocationContext: createContext().invocationContext,
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

describe('SkillToolset with an environment', () => {
  it('rejects a relative skillsFolder', () => {
    expect(
      () =>
        new SkillToolset([SKILL], {
          environment: new FakeEnvironment(),
          skillsFolder: 'relative/skills',
        }),
    ).toThrow("`skillsFolder` must be an absolute path: 'relative/skills'");
  });

  it('accepts a Windows absolute skillsFolder', () => {
    const toolset = new SkillToolset([SKILL], {
      environment: new FakeEnvironment(),
      skillsFolder: 'C:\\workspace\\skills',
    });

    expect(toolset.skillsFolder).toBe('C:/workspace/skills');
  });

  it('defaults scriptTimeoutSeconds and passes it to execute', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    const toolset = new SkillToolset([SKILL], {environment: env});
    const tool = new RunSkillScriptTool(toolset);

    expect(toolset.scriptTimeoutSeconds).toBe(DEFAULT_SCRIPT_TIMEOUT_SECONDS);

    await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: 'echo hi'},
      toolContext: createConfirmedContext(),
    });

    expect(env.executeCalls).toEqual([
      {command: 'echo hi', timeoutSeconds: DEFAULT_SCRIPT_TIMEOUT_SECONDS},
    ]);
  });

  it('passes a configured scriptTimeoutSeconds to execute', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    const toolset = new SkillToolset([SKILL], {
      environment: env,
      scriptTimeoutSeconds: 7,
    });
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: 'echo hi'},
      toolContext: createConfirmedContext(),
    });

    expect(env.executeCalls).toEqual([{command: 'echo hi', timeoutSeconds: 7}]);
  });

  it('skips materialization when the script is already in the environment', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    env.files.set('/workspace/skills/skill1/scripts/run.sh', 'echo hello');
    const toolset = new SkillToolset([SKILL], {environment: env});
    const tool = new RunSkillScriptTool(toolset);

    await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: 'echo hi'},
      toolContext: createConfirmedContext(),
    });

    expect(env.writeCalls).toEqual([]);
  });

  it('closes an initialized environment and leaves an uninitialized one alone', async () => {
    const initialized = new FakeEnvironment();
    await initialized.initialize();
    const untouched = new FakeEnvironment();

    await new SkillToolset([SKILL], {environment: initialized}).close();
    await new SkillToolset([SKILL], {environment: untouched}).close();

    expect(initialized.closeCount).toBe(1);
    expect(untouched.closeCount).toBe(0);
  });

  it('initializes the environment before building the instruction', async () => {
    const env = new FakeEnvironment();
    const toolset = new SkillToolset([SKILL], {environment: env});
    const request: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    await toolset.processLlmRequest(createContext(), request);

    expect(env.isInitialized).toBe(true);
    expect(request.config?.systemInstruction).toContain(
      'NOTE ON ENVIRONMENT EXECUTION',
    );
    expect(request.config?.systemInstruction).toContain(
      `${env.workingDir}/skills/<skill_name>/`,
    );
  });

  it('does not re-initialize an environment that is already up', async () => {
    const env = new FakeEnvironment();
    await env.initialize();
    const toolset = new SkillToolset([SKILL], {environment: env});

    await toolset.processLlmRequest(createContext(), {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    });

    expect(env.initializeCount).toBe(1);
  });
});

describe('SkillToolset against a real LocalEnvironment', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'skill_env_test_'));
  });

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true});
  });

  it('brings an environment nobody initialized up before it runs', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    const tool = new RunSkillScriptTool(
      new SkillToolset([SKILL], {environment}),
    );

    const result = (await tool.runAsync({
      args: {
        skill_name: 'skill1',
        script_path: 'run.sh',
        command: 'sh skills/skill1/scripts/run.sh',
      },
      toolContext: createConfirmedContext(),
    })) as {stdout: string; exit_code: number};

    expect(environment.isInitialized).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exit_code).toBe(0);
  });

  it('materializes the skill and runs its script', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    const toolset = new SkillToolset([SKILL], {environment});
    const tool = new RunSkillScriptTool(toolset);
    await environment.initialize();

    const result = (await tool.runAsync({
      args: {
        skill_name: 'skill1',
        script_path: 'run.sh',
        command: 'sh skills/skill1/scripts/run.sh',
      },
      toolContext: createConfirmedContext(),
    })) as {
      stdout: string;
      stderr: string;
      exit_code: number;
      timed_out: boolean;
    };

    expect(result.stdout.trim()).toBe('hello');
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(
      await fs.readFile(
        path.join(workspace, 'skills/skill1/references/ref1.md'),
        'utf-8',
      ),
    ).toBe('reference one');
    expect(
      await fs.readFile(
        path.join(workspace, 'skills/skill1/assets/asset1.json'),
        'utf-8',
      ),
    ).toBe('{"a": 1}');

    await toolset.close();
  });

  it('reports a non-zero exit code and does not throw', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    const toolset = new SkillToolset([SKILL], {environment});
    const tool = new RunSkillScriptTool(toolset);
    await environment.initialize();

    const result = (await tool.runAsync({
      args: {
        skill_name: 'skill1',
        script_path: 'run.sh',
        command: 'exit 3',
      },
      toolContext: createConfirmedContext(),
    })) as {exit_code: number; timed_out: boolean};

    expect(result.exit_code).toBe(3);
    expect(result.timed_out).toBe(false);

    await toolset.close();
  });

  it('reports a timed-out command', async () => {
    const environment = new LocalEnvironment({workingDir: workspace});
    const toolset = new SkillToolset([SKILL], {
      environment,
      scriptTimeoutSeconds: 0.2,
    });
    const tool = new RunSkillScriptTool(toolset);
    await environment.initialize();

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.sh', command: 'sleep 5'},
      toolContext: createConfirmedContext(),
    })) as {timed_out: boolean};

    expect(result.timed_out).toBe(true);

    await toolset.close();
  });
});

describe('FakeEnvironment contract', () => {
  it('reports ENOENT for a file it does not hold', async () => {
    const env = new FakeEnvironment();
    await env.initialize();

    await expect(env.readFile('/nope')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('round-trips a written file', async () => {
    const env = new FakeEnvironment();
    await env.initialize();
    await env.writeFile('/a/b.txt', 'body');

    expect(new TextDecoder().decode(await env.readFile('/a/b.txt'))).toBe(
      'body',
    );
  });

  it('executes a recorded result', async () => {
    const env = new FakeEnvironment({
      result: {exitCode: 2, stdout: 'o', stderr: 'e', timedOut: true},
    });
    const result: ExecutionResult = await env.execute('cmd', 1);

    expect(result).toEqual({
      exitCode: 2,
      stdout: 'o',
      stderr: 'e',
      timedOut: true,
    });
  });
});
