/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from google/adk-python, tests/unittests/tools/test_skill_toolset.py
// at main (44e0b2a8b1215aa98f057c4a781ddc24bae220da).
// Test names are kept as in the source so a reviewer can grep for the original.

import {
  BaseCodeExecutor,
  BaseTool,
  BaseToolset,
  buildSkillSystemInstruction,
  CodeExecutionInput,
  CodeExecutionResult,
  Context,
  createSession,
  DEFAULT_SKILL_SYSTEM_INSTRUCTION,
  ExecuteCodeParams,
  Frontmatter,
  InMemorySessionService,
  InvocationContext,
  ListSkillsTool,
  LlmAgent,
  LlmRequest,
  LoadSkillResourceTool,
  LoadSkillTool,
  PluginManager,
  RunSkillScriptTool,
  SearchSkillsTool,
  SequentialAgent,
  Skill,
  SkillRegistry,
  SkillToolset,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeEnvironment} from './fake_environment.js';

class StubCodeExecutor extends BaseCodeExecutor {
  override async executeCode(): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
  }
}

class RecordingCodeExecutor extends BaseCodeExecutor {
  lastInput?: CodeExecutionInput;
  calls = 0;

  constructor(private readonly result: Partial<CodeExecutionResult> = {}) {
    super();
  }

  override async executeCode(
    params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    this.calls++;
    this.lastInput = params.codeExecutionInput;
    return {
      stdout: '',
      stderr: '',
      outputFiles: [],
      ...this.result,
    };
  }
}

class StubTool extends BaseTool {
  constructor(name: string) {
    super({name, description: `${name} description`});
  }
  override async runAsync(): Promise<unknown> {
    return this.name;
  }
}

class StubRegistry implements SkillRegistry {
  async getSkill(name: string): Promise<Skill> {
    throw new Error(`Skill '${name}' is not in the stub registry.`);
  }
  async searchSkills(): Promise<Frontmatter[]> {
    return [];
  }
}

function createSkill(name: string, metadata?: Record<string, unknown>): Skill {
  return {
    frontmatter: {name, description: `${name} description`, metadata},
    instructions: `${name} instructions`,
  };
}

function createInvocationContext(options: {
  agent?: LlmAgent | SequentialAgent;
  state?: Record<string, unknown>;
  invocationId?: string;
}): InvocationContext {
  const agent =
    options.agent ??
    new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'});
  return new InvocationContext({
    invocationId: options.invocationId ?? 'test_invocation',
    agent,
    session: createSession({
      id: 'session-1',
      appName: 'app',
      userId: 'user',
      state: options.state,
    }),
    sessionService: new InMemorySessionService(),
    pluginManager: new PluginManager([]),
  });
}

function createContext(
  options: {
    agent?: LlmAgent | SequentialAgent;
    state?: Record<string, unknown>;
    invocationId?: string;
  } = {},
): Context {
  return new Context({invocationContext: createInvocationContext(options)});
}

/**
 * A context that has already approved the command, so the environment path
 * runs it instead of pausing on the confirmation gate.
 */
function createConfirmedContext(): Context {
  return new Context({
    invocationContext: createInvocationContext({}),
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

/** A context whose agent owns a code executor, so scripts can run. */
function createContextWithExecutor(): Context {
  return createContext({
    agent: new LlmAgent({
      name: 'test_agent',
      model: 'gemini-2.0-flash',
      codeExecutor: new StubCodeExecutor(),
    }),
  });
}

function emptyLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

function systemInstruction(request: LlmRequest): string {
  const instruction = request.config?.systemInstruction;
  expect(typeof instruction).toBe('string');
  return instruction as string;
}

describe('skill_toolset parity: system instruction', () => {
  it('test_system_instruction_references_run_skill_script', () => {
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain('run_skill_script');
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).not.toContain(
      'execute_skill_script',
    );
  });

  it('test_system_instruction_marks_load_skill_as_non_terminal', () => {
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain(
      'does NOT complete your turn',
    );
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain('empty response');
  });

  it('test_prefixed_system_instruction_includes_continue_after_load_rule', () => {
    const instruction = buildSkillSystemInstruction({prefix: 'my'});
    expect(instruction).toContain('does NOT complete your turn');
    expect(instruction).toContain('my_load_skill');
  });

  it('test_filtered_system_instruction_appends_banned_notice', () => {
    const instruction = buildSkillSystemInstruction({
      allowedTools: new Set(['list_skills', 'load_skill']),
    });
    expect(instruction).toContain('Use `run_skill_script` to run scripts');
    expect(instruction).toContain(
      'The `load_skill_resource` tool is for viewing',
    );
    expect(instruction).toContain('`load_skill`');
    expect(instruction).toContain('NOT available');
    expect(instruction).toContain('Do NOT call them');
    expect(instruction).toContain('normal model text');
    expect(instruction).toContain('`run_skill_script`');
    expect(instruction).toContain('`load_skill_resource`');
  });

  it('test_filtered_system_instruction_bans_load_and_list_skills', () => {
    const instruction = buildSkillSystemInstruction({
      allowedTools: new Set(['run_skill_script']),
    });
    expect(instruction).toContain(
      'The following tools are NOT available: `load_skill_resource`,' +
        ' `load_skill`, `list_skills`.',
    );
    expect(instruction).toContain('Do NOT call them');
  });

  it('test_unfiltered_system_instruction_documents_all_tools', () => {
    const instruction = buildSkillSystemInstruction();
    expect(instruction).toBe(DEFAULT_SKILL_SYSTEM_INSTRUCTION);
    expect(instruction).toContain('Use `run_skill_script` to run scripts');
    expect(instruction).toContain(
      'The `load_skill_resource` tool is for viewing',
    );
    expect(instruction).not.toContain('NOT available');
  });

  it('test_default_skill_system_instruction_contract_unchanged', () => {
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain('run_skill_script');
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain('load_skill_resource');
    expect(DEFAULT_SKILL_SYSTEM_INSTRUCTION).toContain(
      'does NOT complete your turn',
    );
  });

  it('test_tool_classes_define_tool_name_constants', () => {
    expect(ListSkillsTool.TOOL_NAME).toBe('list_skills');
    expect(SearchSkillsTool.TOOL_NAME).toBe('search_skills');
    expect(LoadSkillTool.TOOL_NAME).toBe('load_skill');
    expect(LoadSkillResourceTool.TOOL_NAME).toBe('load_skill_resource');
    expect(RunSkillScriptTool.TOOL_NAME).toBe('run_skill_script');

    // adk-python reads these off the classes. Here they are also asserted on
    // the built tools, which is the name the model actually sees.
    const toolset = new SkillToolset([createSkill('skill1')], {
      registry: new StubRegistry(),
    });

    expect(new ListSkillsTool(toolset).name).toBe('list_skills');
    expect(new SearchSkillsTool(toolset).name).toBe('search_skills');
    expect(new LoadSkillTool(toolset).name).toBe('load_skill');
    expect(new LoadSkillResourceTool(toolset).name).toBe('load_skill_resource');
    expect(new RunSkillScriptTool(toolset).name).toBe('run_skill_script');
  });

  it('drops the script steps but keeps the numbering contiguous', () => {
    const instruction = buildSkillSystemInstruction({
      scriptExecutionEnabled: false,
    });
    expect(instruction).not.toContain('run_skill_script');
    expect(instruction).not.toContain('can be run via bash');
    expect([...instruction.matchAll(/^(\d+)\. /gm)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });
});

describe('skill_toolset parity: processLlmRequest', () => {
  it('test_process_llm_request_with_list_skills_tool', async () => {
    const toolset = new SkillToolset([
      createSkill('skill1'),
      createSkill('skill2'),
    ]);
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    expect(systemInstruction(request)).toBe(DEFAULT_SKILL_SYSTEM_INSTRUCTION);
  });

  it('test_process_llm_request_without_list_skills_tool', async () => {
    const toolset = new SkillToolset(
      [createSkill('skill1'), createSkill('skill2')],
      {toolFilter: ['load_skill', 'load_skill_resource', 'run_skill_script']},
    );
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('NOT available: `list_skills`');
    expect(instruction).toContain('<available_skills>');
    expect(instruction).toContain('skill1');
    expect(instruction).toContain('skill2');
  });

  it('test_process_llm_request_with_tool_name_prefix', async () => {
    const toolset = new SkillToolset(
      [createSkill('skill1'), createSkill('skill2')],
      {
        registry: new StubRegistry(),
        toolNamePrefix: 'my_prefix',
        toolFilter: [
          'my_prefix_load_skill',
          'my_prefix_load_skill_resource',
          'my_prefix_run_skill_script',
          'my_prefix_search_skills',
        ],
      },
    );
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('`my_prefix_load_skill`');
    expect(instruction).toContain('`my_prefix_load_skill_resource`');
    expect(instruction).toContain('`my_prefix_run_skill_script`');
    expect(instruction).toContain('my_prefix_search_skills');
  });

  it('test_process_llm_request_respects_list_tool_filter', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      toolFilter: ['list_skills', 'load_skill'],
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('Use `run_skill_script` to run scripts');
    expect(instruction).toContain(
      'The `load_skill_resource` tool is for viewing',
    );
    expect(instruction).toContain('Do NOT call them');
    expect(instruction).toContain('normal model text');
    expect(instruction).not.toBe(DEFAULT_SKILL_SYSTEM_INSTRUCTION);
    // list_skills survives, so the catalogue is not duplicated into the prompt.
    expect(instruction).not.toContain('<available_skills>');
  });

  it('test_process_llm_request_injects_skills_xml_when_list_skills_filtered', async () => {
    const toolset = new SkillToolset(
      [createSkill('skill1'), createSkill('skill2')],
      {toolFilter: ['load_skill']},
    );
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('<available_skills>');
    expect(instruction).toContain('skill1');
    expect(instruction).toContain('skill2');
  });

  it('test_process_llm_request_omits_search_skills_hint_when_filtered', async () => {
    const toolset = new SkillToolset([], {
      registry: new StubRegistry(),
      toolFilter: ['list_skills', 'load_skill'],
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    expect(systemInstruction(request)).not.toContain('search_skills');
  });

  it('test_process_llm_request_includes_search_skills_hint_when_allowed', async () => {
    const toolset = new SkillToolset([], {
      registry: new StubRegistry(),
      toolFilter: ['list_skills', 'load_skill', 'search_skills'],
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    expect(systemInstruction(request)).toContain(
      'you can use the `search_skills` tool',
    );
  });

  it('test_process_llm_request_with_prefix_and_tool_filter', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      toolNamePrefix: 'my',
      toolFilter: ['my_list_skills', 'my_load_skill'],
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('`my_load_skill`');
    expect(instruction).toContain('Use `my_run_skill_script` to run scripts');
    expect(instruction).toContain(
      'The `my_load_skill_resource` tool is for viewing',
    );
    expect(instruction).toContain('Do NOT call them');
  });

  it('test_process_llm_request_respects_predicate_tool_filter', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      toolFilter: (tool) => ['list_skills', 'load_skill'].includes(tool.name),
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContextWithExecutor(), request);

    const instruction = systemInstruction(request);
    expect(instruction).toContain('Use `run_skill_script` to run scripts');
    expect(instruction).toContain('Do NOT call them');
  });

  it('test_process_llm_request_drops_script_guidance_without_backend', async () => {
    const toolset = new SkillToolset([createSkill('skill1')]);
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContext(), request);

    const instruction = systemInstruction(request);
    expect(instruction).not.toContain('run_skill_script');
    expect(instruction).not.toContain('can be run via bash');
    expect([...instruction.matchAll(/^(\d+)\. /gm)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('test_process_llm_request_keeps_script_guidance_with_backend', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      codeExecutor: new StubCodeExecutor(),
    });
    const request = emptyLlmRequest();

    await toolset.processLlmRequest(createContext(), request);

    expect(systemInstruction(request)).toBe(DEFAULT_SKILL_SYSTEM_INSTRUCTION);
  });
});

describe('skill_toolset parity: getTools', () => {
  it('test_skill_toolset_with_list_tool_filter', async () => {
    const toolset = new SkillToolset([], {
      toolFilter: ['list_skills', 'load_skill'],
    });

    const names = (await toolset.getTools()).map((t) => t.name);

    expect(names).toContain('list_skills');
    expect(names).toContain('load_skill');
    expect(names).not.toContain('load_skill_resource');
    expect(names).not.toContain('run_skill_script');
  });

  it('test_skill_toolset_with_predicate_tool_filter', async () => {
    // adk-js `ToolPredicate` takes a `ReadonlyContext`, so unlike the Python
    // reference the predicate is only applied when a context is supplied.
    const toolset = new SkillToolset([], {
      toolFilter: (tool) => tool.name.includes('resource'),
    });

    const names = (await toolset.getTools(createContextWithExecutor())).map(
      (t) => t.name,
    );

    expect(names).toEqual(['load_skill_resource']);
  });

  it('test_skill_toolset_with_dynamic_tools_filter', async () => {
    const toolset = new SkillToolset(
      [createSkill('skill1', {adk_additional_tools: ['my_custom_tool']})],
      {
        additionalTools: [new StubTool('my_custom_tool')],
        toolFilter: ['list_skills', 'my_custom_tool'],
      },
    );

    const context = createContext({
      agent: new LlmAgent({
        name: 'test_agent',
        model: 'gemini-2.0-flash',
        codeExecutor: new StubCodeExecutor(),
      }),
      state: {_adk_activated_skill_test_agent: ['skill1']},
    });

    const names = (await toolset.getTools(context)).map((t) => t.name);

    expect(names).toContain('list_skills');
    expect(names).toContain('my_custom_tool');
    expect(names).not.toContain('load_skill');
  });

  it('test_get_tools_hides_run_skill_script_without_backend', async () => {
    const toolset = new SkillToolset([createSkill('skill1')]);

    const names = (await toolset.getTools(createContext())).map((t) => t.name);

    expect(names).toEqual(['list_skills', 'load_skill', 'load_skill_resource']);
  });

  it('hides run_skill_script for an agent that is not an LlmAgent', async () => {
    const toolset = new SkillToolset([createSkill('skill1')]);
    const context = createContext({
      agent: new SequentialAgent({name: 'test_agent', subAgents: []}),
    });

    const names = (await toolset.getTools(context)).map((t) => t.name);

    expect(names).not.toContain('run_skill_script');
  });

  it('test_get_tools_keeps_run_skill_script_with_toolset_executor', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      codeExecutor: new StubCodeExecutor(),
    });

    const names = (await toolset.getTools(createContext())).map((t) => t.name);

    expect(names).toContain('run_skill_script');
  });

  it('test_get_tools_keeps_run_skill_script_with_agent_executor', async () => {
    const toolset = new SkillToolset([createSkill('skill1')]);

    const names = (await toolset.getTools(createContextWithExecutor())).map(
      (t) => t.name,
    );

    expect(names).toContain('run_skill_script');
  });

  it('test_get_tools_keeps_run_skill_script_without_context', async () => {
    const toolset = new SkillToolset([createSkill('skill1')]);

    const names = (await toolset.getTools()).map((t) => t.name);

    expect(names).toContain('run_skill_script');
  });

  it('prefixes every tool name when toolNamePrefix is set', async () => {
    const toolset = new SkillToolset([createSkill('skill1')], {
      registry: new StubRegistry(),
      allowInlineScripts: true,
      toolNamePrefix: 'my',
    });

    const names = (await toolset.getTools()).map((t) => t.name);

    expect(names).toEqual([
      'my_list_skills',
      'my_load_skill',
      'my_load_skill_resource',
      'my_run_skill_script',
      'my_run_skill_inline_script',
      'my_search_skills',
    ]);
  });
});

describe('skill_toolset parity: toolset shape', () => {
  it('test_duplicate_skill_name_raises', () => {
    expect(
      () => new SkillToolset([createSkill('skill1'), createSkill('skill1')]),
    ).toThrow("Duplicate skill name 'skill1'.");
  });

  it('re-resolves the additional tools after close clears the cache', async () => {
    let resolutions = 0;
    class CountingToolset extends BaseToolset {
      constructor() {
        super([]);
      }
      override async getTools(): Promise<BaseTool[]> {
        resolutions++;
        return [new StubTool('counted_tool')];
      }
      override async close(): Promise<void> {}
    }

    const toolset = new SkillToolset(
      [createSkill('skill1', {adk_additional_tools: ['counted_tool']})],
      {additionalTools: [new CountingToolset()]},
    );
    const context = createContext({
      state: {_adk_activated_skill_test_agent: ['skill1']},
    });

    await toolset.getTools(context);
    await toolset.getTools(context);
    expect(resolutions).toBe(1);

    await toolset.close();
    // `BaseToolset.getToolsWithPrefix` caches per invocation, so the next
    // invocation asks `CountingToolset` again. The toolset cache key does not
    // hold the invocation id, so a second resolution still proves that
    // `close()` cleared the cache.
    const nextContext = createContext({
      state: {_adk_activated_skill_test_agent: ['skill1']},
      invocationId: 'test_invocation_2',
    });
    const names = (await toolset.getTools(nextContext)).map((t) => t.name);

    expect(resolutions).toBe(2);
    expect(names).toContain('counted_tool');
  });
});

describe('skill_toolset parity: environment', () => {
  const envSkill: Skill = {
    frontmatter: {name: 'skill1', description: 'A test skill'},
    instructions: 'Test instructions',
    resources: {scripts: {'run.py': {src: "print('hi')"}}},
  };

  it('test_init_accepts_environment', () => {
    const env = new FakeEnvironment();

    expect(new SkillToolset([envSkill], {environment: env}).environment).toBe(
      env,
    );
  });

  it('test_init_accepts_skills_folder', () => {
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment(),
      skillsFolder: '/custom/skills',
    });

    expect(toolset.skillsFolder).toBe('/custom/skills');
  });

  it('test_init_raises_when_skills_folder_provided_without_environment', () => {
    expect(
      () => new SkillToolset([envSkill], {skillsFolder: '/custom/skills'}),
    ).toThrow('Cannot specify skillsFolder without an environment');
  });

  it('test_skills_folder_defaults_to_environment', () => {
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment({workingDir: '/workspace'}),
    });

    expect(toolset.skillsFolder).toBe('/workspace/skills');
  });

  it('test_init_raises_when_both_executor_and_environment_provided', () => {
    expect(
      () =>
        new SkillToolset([envSkill], {
          codeExecutor: new StubCodeExecutor(),
          environment: new FakeEnvironment(),
        }),
    ).toThrow('Cannot have both codeExecutor and environment');
  });

  it('test_run_skill_script_declaration_with_environment', () => {
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment(),
    });

    const declaration = new RunSkillScriptTool(toolset)._getDeclaration();
    const properties = declaration?.parameters?.properties ?? {};

    expect(Object.keys(properties)).toEqual([
      'skill_name',
      'script_path',
      'command',
    ]);
    expect(declaration?.parameters?.required).toContain('command');
  });

  it('test_run_skill_script_execute_with_environment_missing_command', async () => {
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment(),
    });

    const result = (await new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'skill1', script_path: 'run.py'},
      toolContext: createContext(),
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('INVALID_ARGUMENTS');
    expect(result.error).toContain("Argument 'command' is required");
  });

  it('test_run_skill_script_execute_with_environment', async () => {
    const env = new FakeEnvironment({
      workingDir: '/workspace',
      result: {exitCode: 0, stdout: 'env out', stderr: '', timedOut: false},
    });
    const toolset = new SkillToolset([envSkill], {environment: env});

    const result = await new RunSkillScriptTool(toolset).runAsync({
      args: {
        skill_name: 'skill1',
        script_path: 'run.py',
        command: 'python3 skills/skill1/scripts/run.py --flag 1',
      },
      toolContext: createConfirmedContext(),
    });

    expect(result).toEqual({
      stdout: 'env out',
      stderr: '',
      exit_code: 0,
      timed_out: false,
    });
    expect(env.writeCalls.map((w) => w.filePath)).toEqual([
      '/workspace/skills/skill1/scripts/run.py',
    ]);
    expect(env.executeCalls).toHaveLength(1);
    expect(env.executeCalls[0].command).toBe(
      'python3 skills/skill1/scripts/run.py --flag 1',
    );
  });

  it('test_run_skill_script_environment_execute_exception', async () => {
    const env = new FakeEnvironment({workingDir: '/workspace'});
    env.files.set('/workspace/skills/skill1/scripts/run.py', "print('hi')");
    const toolset = new SkillToolset([envSkill], {environment: env});
    const tool = new RunSkillScriptTool(toolset);
    const failure = new Error('Sandbox connection lost');
    failure.name = 'RuntimeError';
    env.executeError = failure;

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'run.py', command: 'python3 x'},
      toolContext: createConfirmedContext(),
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('EXECUTION_ERROR');
    expect(result.error).toContain('Failed to execute script');
    expect(result.error).toContain('RuntimeError: Sandbox connection lost');
  });

  it('test_run_skill_script_environment_materialize_ls_exception', async () => {
    const failure = new Error('Failed to check file existence');
    failure.name = 'RuntimeError';
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment({
        workingDir: '/workspace',
        readFileError: failure,
      }),
    });

    const result = (await new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'skill1', script_path: 'run.py', command: 'python3 x'},
      toolContext: createConfirmedContext(),
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('EXECUTION_ERROR');
    expect(result.error).toContain(
      'RuntimeError: Failed to check file existence',
    );
  });

  it('test_run_skill_script_environment_materialize_write_exception', async () => {
    const failure = new Error('Disk full');
    failure.name = 'RuntimeError';
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment({
        workingDir: '/workspace',
        writeFileError: failure,
      }),
    });

    const result = (await new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'skill1', script_path: 'run.py', command: 'python3 x'},
      toolContext: createConfirmedContext(),
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('EXECUTION_ERROR');
    expect(result.error).toContain('RuntimeError: Disk full');
  });

  it('test_run_skill_script_materialize_writes_concurrently', async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const env = new FakeEnvironment({
      workingDir: '/workspace',
      onWrite: async () => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWrites--;
      },
    });
    const multiResourceSkill: Skill = {
      frontmatter: {name: 'multi-res', description: 'desc'},
      instructions: 'desc',
      resources: {
        references: {'ref1.md': 'c1', 'ref2.md': 'c2'},
        assets: {'asset1.json': 'c3'},
        scripts: {'run.py': {src: "print('hi')"}},
      },
    };
    const toolset = new SkillToolset([multiResourceSkill], {environment: env});

    await new RunSkillScriptTool(toolset).runAsync({
      args: {
        skill_name: 'multi-res',
        script_path: 'run.py',
        command: 'python3 run.py',
      },
      toolContext: createConfirmedContext(),
    });

    expect(env.writeCalls).toHaveLength(4);
    expect(maxActiveWrites).toBe(4);
  });

  it('test_get_tools_keeps_run_skill_script_with_environment', async () => {
    const toolset = new SkillToolset([envSkill], {
      environment: new FakeEnvironment(),
    });

    const names = (await toolset.getTools(createContext())).map((t) => t.name);

    expect(names).toContain('run_skill_script');
  });

  it('test_close_cancels_futures_and_clears_cache', async () => {
    const env = new FakeEnvironment();
    await env.initialize();
    const toolset = new SkillToolset([envSkill], {environment: env});

    await toolset.close();

    expect(env.closeCount).toBe(1);
  });
});

describe('skill_toolset parity: script arguments and status', () => {
  const scriptSkill: Skill = {
    frontmatter: {name: 'skill1', description: 'A test skill'},
    instructions: 'Test instructions',
    resources: {
      scripts: {
        'run.py': {src: "print('hi')"},
        'run.sh': {src: 'echo hi'},
        'build.rb': {src: 'puts 1'},
        noext: {src: 'echo hi'},
      },
    },
  };

  function runScript(
    executor: RecordingCodeExecutor,
    args: Record<string, unknown>,
  ) {
    const toolset = new SkillToolset([scriptSkill], {codeExecutor: executor});
    return new RunSkillScriptTool(toolset).runAsync({
      args: {skill_name: 'skill1', ...args},
      toolContext: createContext(),
    });
  }

  it('test_execute_script_with_input_args_python', async () => {
    const executor = new RecordingCodeExecutor({stdout: 'done\n'});

    const result = (await runScript(executor, {
      script_path: 'run.py',
      args: {verbose: true, count: '3'},
    })) as {status: string};

    expect(result.status).toBe('success');
    expect(executor.lastInput?.args).toEqual([
      '--verbose',
      'true',
      '--count',
      '3',
    ]);
  });

  it('test_execute_script_with_input_args_shell', async () => {
    const executor = new RecordingCodeExecutor({stdout: 'done\n'});

    await runScript(executor, {
      script_path: 'run.sh',
      args: {verbose: true},
      short_options: {n: 5},
      positional_args: ['input.csv'],
    });

    expect(executor.lastInput?.args).toEqual([
      '--verbose',
      'true',
      '-n',
      '5',
      '--',
      'input.csv',
    ]);
  });

  it('test_execute_script_with_list_args_python', async () => {
    const executor = new RecordingCodeExecutor({stdout: 'done\n'});

    const result = (await runScript(executor, {
      script_path: 'run.py',
      args: ['--verbose', 'True', '-n', '5', 'input.txt'],
    })) as {status: string};

    expect(result.status).toBe('success');
    expect(executor.lastInput?.args).toEqual([
      '--verbose',
      'True',
      '-n',
      '5',
      'input.txt',
    ]);
  });

  it('test_execute_script_with_list_args_rejects_others_python', async () => {
    const executor = new RecordingCodeExecutor();

    const result = (await runScript(executor, {
      script_path: 'run.py',
      args: ['arg1', 'arg2'],
      short_options: {v: true},
      positional_args: ['pos1'],
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('INVALID_ARGUMENTS');
    expect(result.error).toContain(
      "Cannot specify 'short_options' or 'positional_args'",
    );
    expect(executor.calls).toBe(0);
  });

  it('test_execute_script_invalid_args_type', async () => {
    for (const badArgs of ['not a dict', 42, true]) {
      const executor = new RecordingCodeExecutor();

      const result = (await runScript(executor, {
        script_path: 'run.py',
        args: badArgs,
      })) as {error_code: string};

      expect(result.error_code).toBe('INVALID_ARGUMENTS');
      expect(executor.calls).toBe(0);
    }
  });

  it('test_execute_script_invalid_short_options_type', async () => {
    for (const badShortOptions of ['not a dict', 42, true, ['list']]) {
      const executor = new RecordingCodeExecutor();

      const result = (await runScript(executor, {
        script_path: 'run.py',
        short_options: badShortOptions,
      })) as {error_code: string};

      expect(result.error_code).toBe('INVALID_ARGUMENTS');
      expect(executor.calls).toBe(0);
    }
  });

  it('test_execute_script_invalid_positional_args_type', async () => {
    for (const badPositionalArgs of ['not a list', 42, true, {dict: 1}]) {
      const executor = new RecordingCodeExecutor();

      const result = (await runScript(executor, {
        script_path: 'run.py',
        positional_args: badPositionalArgs,
      })) as {error_code: string};

      expect(result.error_code).toBe('INVALID_ARGUMENTS');
      expect(executor.calls).toBe(0);
    }
  });

  it('test_execute_script_stderr_only_sets_error_status', async () => {
    const executor = new RecordingCodeExecutor({stderr: 'fatal error\n'});

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      status: string;
      stderr: string;
    };

    expect(result.status).toBe('error');
    expect(result.stderr).toBe('fatal error\n');
  });

  it('test_execute_script_stderr_with_stdout_sets_warning', async () => {
    const executor = new RecordingCodeExecutor({
      stdout: 'output\n',
      stderr: 'deprecation\n',
    });

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      status: string;
    };

    expect(result.status).toBe('warning');
  });

  it('test_executor_exit_code_is_not_overridden_by_stderr', async () => {
    const executor = new RecordingCodeExecutor({
      stderr: 'a warning\n',
      exitCode: 0,
    });

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      status: string;
      exitCode?: number | null;
    };

    expect(result.status).toBe('error');
    expect(result.exitCode).toBe(0);
  });

  it('test_missing_executor_exit_code_falls_back_to_stderr', async () => {
    const executor = new RecordingCodeExecutor({stderr: 'fatal error\n'});

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      status: string;
    };

    expect(result.status).toBe('error');
  });

  it('reports a non-zero exit code as an error whatever the streams say', async () => {
    const executor = new RecordingCodeExecutor({
      stdout: 'partial\n',
      exitCode: 3,
    });

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      status: string;
    };

    expect(result.status).toBe('error');
  });

  it('test_execute_script_unsupported_type', async () => {
    const executor = new RecordingCodeExecutor();

    const result = (await runScript(executor, {
      script_path: 'build.rb',
    })) as {error: string; error_code: string};

    expect(result.error_code).toBe('UNSUPPORTED_SCRIPT_TYPE');
    expect(result.error).toContain("Unsupported script type '.rb'");
    expect(executor.calls).toBe(0);
  });

  it('test_execute_script_extensionless_unsupported', async () => {
    const executor = new RecordingCodeExecutor();

    const result = (await runScript(executor, {script_path: 'noext'})) as {
      error: string;
      error_code: string;
    };

    expect(result.error_code).toBe('UNSUPPORTED_SCRIPT_TYPE');
    expect(result.error).toContain('Unsupported script type (no extension)');
  });

  it('names the skill and the script in the response', async () => {
    const executor = new RecordingCodeExecutor({stdout: 'ok'});

    const result = (await runScript(executor, {script_path: 'run.py'})) as {
      skill_name: string;
      script_path: string;
    };

    expect(result.skill_name).toBe('skill1');
    expect(result.script_path).toBe('run.py');
  });
});

describe('skill_toolset parity: invocation-scoped retry guards', () => {
  const guardSkill: Skill = {
    frontmatter: {name: 'skill1', description: 'A test skill'},
    instructions: 'Test instructions',
    resources: {
      references: {'doc.md': 'body'},
      scripts: {'run.py': {src: 'x'}},
    },
  };

  it('test_load_resource_first_missing_returns_soft_error', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([guardSkill]));

    const result = (await tool.runAsync({
      args: {skill_name: 'skill1', path: 'references/nope.md'},
      toolContext: createContext(),
    })) as {error_code: string};

    expect(result.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('test_load_resource_repeated_failure_escalates_to_fatal', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([guardSkill]));
    const context = createContext();
    const args = {skill_name: 'skill1', path: 'references/nope.md'};

    const first = (await tool.runAsync({args, toolContext: context})) as {
      error_code: string;
    };
    const second = (await tool.runAsync({args, toolContext: context})) as {
      error: string;
      error_code: string;
    };

    expect(first.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(second.error_code).toBe('RESOURCE_NOT_FOUND_FATAL');
    expect(second.error).toContain('Do not retry');
    expect(second.error).toContain('failure #2');
    expect(second.error).toContain('stop');
  });

  it('test_load_resource_different_path_also_escalates_to_fatal', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([guardSkill]));
    const context = createContext();

    await tool.runAsync({
      args: {skill_name: 'skill1', path: 'references/one.md'},
      toolContext: context,
    });
    const second = (await tool.runAsync({
      args: {skill_name: 'skill1', path: 'references/two.md'},
      toolContext: context,
    })) as {error_code: string};

    expect(second.error_code).toBe('RESOURCE_NOT_FOUND_FATAL');
  });

  it('test_load_resource_failures_isolated_per_invocation', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([guardSkill]));
    const args = {skill_name: 'skill1', path: 'references/nope.md'};

    const first = (await tool.runAsync({
      args,
      toolContext: createContext(),
    })) as {error_code: string};
    const second = (await tool.runAsync({
      args,
      toolContext: createContext({invocationId: 'other_invocation'}),
    })) as {error_code: string};

    expect(first.error_code).toBe('RESOURCE_NOT_FOUND');
    expect(second.error_code).toBe('RESOURCE_NOT_FOUND');
  });

  it('test_load_resource_counter_uses_temp_prefix', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([guardSkill]));
    const context = createContext();

    await tool.runAsync({
      args: {skill_name: 'skill1', path: 'references/nope.md'},
      toolContext: context,
    });

    const guardKeys = Object.keys(context.eventActions.stateDelta).filter((k) =>
      k.includes('skill_resource_not_found_count'),
    );
    expect(guardKeys).toHaveLength(1);
    expect(guardKeys[0].startsWith('temp:')).toBe(true);
  });

  it('test_execute_script_repeated_failure_escalates_to_fatal', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([guardSkill], {codeExecutor: new StubCodeExecutor()}),
    );
    const context = createContext();
    const args = {skill_name: 'skill1', script_path: 'scripts/nope.py'};

    const first = (await tool.runAsync({args, toolContext: context})) as {
      error_code: string;
    };
    const second = (await tool.runAsync({args, toolContext: context})) as {
      error: string;
      error_code: string;
    };

    expect(first.error_code).toBe('SCRIPT_NOT_FOUND');
    expect(second.error_code).toBe('SCRIPT_NOT_FOUND_FATAL');
    expect(second.error).toContain('Do not retry any script path');
    expect(second.error).toContain('failure #2');
  });

  it('test_execute_script_different_path_also_escalates_to_fatal', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([guardSkill], {codeExecutor: new StubCodeExecutor()}),
    );
    const context = createContext();

    await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'one.py'},
      toolContext: context,
    });
    const second = (await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'two.py'},
      toolContext: context,
    })) as {error_code: string};

    expect(second.error_code).toBe('SCRIPT_NOT_FOUND_FATAL');
  });

  it('test_execute_script_failures_isolated_per_invocation', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([guardSkill], {codeExecutor: new StubCodeExecutor()}),
    );
    const args = {skill_name: 'skill1', script_path: 'nope.py'};

    const first = (await tool.runAsync({
      args,
      toolContext: createContext(),
    })) as {error_code: string};
    const second = (await tool.runAsync({
      args,
      toolContext: createContext({invocationId: 'other_invocation'}),
    })) as {error_code: string};

    expect(first.error_code).toBe('SCRIPT_NOT_FOUND');
    expect(second.error_code).toBe('SCRIPT_NOT_FOUND');
  });

  it('test_execute_script_counter_uses_temp_prefix', async () => {
    const tool = new RunSkillScriptTool(
      new SkillToolset([guardSkill], {codeExecutor: new StubCodeExecutor()}),
    );
    const context = createContext();

    await tool.runAsync({
      args: {skill_name: 'skill1', script_path: 'nope.py'},
      toolContext: context,
    });

    const guardKeys = Object.keys(context.eventActions.stateDelta).filter((k) =>
      k.includes('skill_script_not_found_count'),
    );
    expect(guardKeys).toHaveLength(1);
    expect(guardKeys[0].startsWith('temp:')).toBe(true);
  });
});

describe('skill_toolset parity: session-state injection', () => {
  function stateSkill(metadata?: Record<string, unknown>): Skill {
    return {
      frontmatter: {name: 'skill1', description: 'desc', metadata},
      instructions: 'Hello {user_name}!',
    };
  }

  it('test_load_skill_run_async_injects_state_when_opt_in', async () => {
    const tool = new LoadSkillTool(
      new SkillToolset([stateSkill({adk_inject_state: true})]),
    );

    const result = (await tool.runAsync({
      args: {name: 'skill1'},
      toolContext: createContext({state: {user_name: 'Alice'}}),
    })) as {instructions: string};

    expect(result.instructions).toBe('Hello Alice!');
  });

  it('test_load_skill_run_async_skips_injection_when_opt_out', async () => {
    const tool = new LoadSkillTool(
      new SkillToolset([stateSkill({adk_inject_state: false})]),
    );

    const result = (await tool.runAsync({
      args: {name: 'skill1'},
      toolContext: createContext({state: {user_name: 'Alice'}}),
    })) as {instructions: string};

    expect(result.instructions).toBe('Hello {user_name}!');
  });

  it('test_load_skill_run_async_skips_injection_when_metadata_absent', async () => {
    const tool = new LoadSkillTool(new SkillToolset([stateSkill()]));

    const result = (await tool.runAsync({
      args: {name: 'skill1'},
      toolContext: createContext({state: {user_name: 'Alice'}}),
    })) as {instructions: string};

    expect(result.instructions).toBe('Hello {user_name}!');
  });
});
