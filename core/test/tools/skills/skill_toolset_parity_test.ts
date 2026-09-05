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
  CodeExecutionResult,
  Context,
  createSession,
  DEFAULT_SKILL_SYSTEM_INSTRUCTION,
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
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class StubCodeExecutor extends BaseCodeExecutor {
  override async executeCode(): Promise<CodeExecutionResult> {
    return {stdout: '', stderr: '', outputFiles: []};
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
