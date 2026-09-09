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
  InvocationContext,
  LlmAgent,
  LoadSkillResourceTool,
  LoadSkillTool,
  PluginManager,
  RunSkillInlineScriptErrorCode,
  RunSkillInlineScriptTool,
  RunSkillScriptTool,
  SearchSkillsTool,
  Skill,
  SkillRegistry,
  SkillToolset,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class FailingCodeExecutor extends BaseCodeExecutor {
  override executeCode(
    _params: ExecuteCodeParams,
  ): Promise<CodeExecutionResult> {
    return Promise.reject(new Error('Mock execution failure'));
  }
}

const FAILING_REGISTRY: SkillRegistry = {
  getSkill: () => Promise.reject(new Error('Registry failure')),
  searchSkills: () => Promise.reject(new Error('Registry failure')),
};

const TEST_SKILL: Skill = {
  frontmatter: {name: 'test-skill', description: 'A test skill'},
  instructions: 'Test instructions',
  resources: {
    scripts: {'setup.js': {src: 'console.log("setup");'}},
    references: {'doc.txt': 'Doc content'},
  },
};

function createContext(
  options: {
    codeExecutor?: BaseCodeExecutor;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({
        name: 'test-agent',
        codeExecutor: options.codeExecutor,
      }),
      session: createSession({id: 'session-1', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'call-1',
    toolConfirmation: options.toolConfirmation,
  });
}

/** A toolset holding {@link TEST_SKILL} locally, with no registry. */
function localToolset(codeExecutor?: BaseCodeExecutor): SkillToolset {
  return new SkillToolset([TEST_SKILL], {codeExecutor});
}

/** A toolset whose every registry call rejects. */
function registryToolset(): SkillToolset {
  return new SkillToolset([], {registry: FAILING_REGISTRY});
}

interface ErrorCase {
  tool: string;
  scenario: string;
  code: string;
  run: () => Promise<unknown>;
}

const ERROR_CASES: ErrorCase[] = [
  {
    tool: 'load_skill',
    scenario: 'missing argument',
    code: 'INVALID_ARGUMENTS',
    run: () =>
      new LoadSkillTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill',
    scenario: 'registry failure',
    code: 'REGISTRY_ERROR',
    run: () =>
      new LoadSkillTool(registryToolset()).runAsync({
        args: {name: 'remote-skill'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill',
    scenario: 'unknown skill',
    code: 'SKILL_NOT_FOUND',
    run: () =>
      new LoadSkillTool(localToolset()).runAsync({
        args: {name: 'unknown-skill'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    scenario: 'missing arguments',
    code: 'INVALID_ARGUMENTS',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    scenario: 'registry failure',
    code: 'REGISTRY_ERROR',
    run: () =>
      new LoadSkillResourceTool(registryToolset()).runAsync({
        args: {skill_name: 'remote-skill', path: 'references/doc.txt'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    scenario: 'unknown skill',
    code: 'SKILL_NOT_FOUND',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {skill_name: 'unknown-skill', path: 'references/doc.txt'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    scenario: 'path outside the allowed directories',
    code: 'INVALID_RESOURCE_PATH',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill', path: 'secrets.txt'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    scenario: 'unknown resource',
    code: 'RESOURCE_NOT_FOUND',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill', path: 'references/missing.txt'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'search_skills',
    scenario: 'missing argument',
    code: 'INVALID_ARGUMENTS',
    run: () =>
      new SearchSkillsTool(registryToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'search_skills',
    scenario: 'registry failure',
    code: 'REGISTRY_ERROR',
    run: () =>
      new SearchSkillsTool(registryToolset()).runAsync({
        args: {query: 'anything'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'missing arguments',
    code: 'INVALID_ARGUMENTS',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'registry failure',
    code: 'REGISTRY_ERROR',
    run: () =>
      new RunSkillScriptTool(registryToolset()).runAsync({
        args: {skill_name: 'remote-skill', script_path: 'scripts/setup.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'unknown skill',
    code: 'SKILL_NOT_FOUND',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {skill_name: 'unknown-skill', script_path: 'scripts/setup.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'unknown script',
    code: 'SCRIPT_NOT_FOUND',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/missing.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'no code executor',
    code: 'NO_CODE_EXECUTOR',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    scenario: 'executor failure',
    code: 'EXECUTION_ERROR',
    run: () =>
      new RunSkillScriptTool(localToolset(new FailingCodeExecutor())).runAsync({
        args: {skill_name: 'test-skill', script_path: 'scripts/setup.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    scenario: 'missing arguments',
    code: RunSkillInlineScriptErrorCode.INVALID_ARGUMENTS,
    run: () =>
      new RunSkillInlineScriptTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    scenario: 'no code executor',
    code: RunSkillInlineScriptErrorCode.NO_CODE_EXECUTOR,
    run: () =>
      new RunSkillInlineScriptTool(localToolset()).runAsync({
        args: {
          script_content: 'console.log(1);',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    scenario: 'rejected confirmation',
    code: RunSkillInlineScriptErrorCode.CONFIRMATION_REJECTED,
    run: () =>
      new RunSkillInlineScriptTool(
        localToolset(new FailingCodeExecutor()),
      ).runAsync({
        args: {
          script_content: 'console.log(1);',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createContext({
          toolConfirmation: new ToolConfirmation({confirmed: false}),
        }),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    scenario: 'executor failure',
    code: RunSkillInlineScriptErrorCode.EXECUTION_ERROR,
    run: () =>
      new RunSkillInlineScriptTool(
        localToolset(new FailingCodeExecutor()),
      ).runAsync({
        args: {
          script_content: 'console.log(1);',
          language: CodeExecutionLanguage.JAVASCRIPT,
        },
        toolContext: createContext({
          toolConfirmation: new ToolConfirmation({confirmed: true}),
        }),
      }),
  },
];

interface MissingArgumentCase {
  tool: string;
  argument: string;
  run: () => Promise<unknown>;
}

const MISSING_ARGUMENT_CASES: MissingArgumentCase[] = [
  {
    tool: 'load_skill',
    argument: 'name',
    run: () =>
      new LoadSkillTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    argument: 'skill_name',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {path: 'references/doc.txt'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'load_skill_resource',
    argument: 'path',
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'search_skills',
    argument: 'query',
    run: () =>
      new SearchSkillsTool(registryToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    argument: 'skill_name',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {script_path: 'scripts/setup.js'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    argument: 'script_path',
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {skill_name: 'test-skill'},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    argument: 'script_content',
    run: () =>
      new RunSkillInlineScriptTool(localToolset()).runAsync({
        args: {language: CodeExecutionLanguage.JAVASCRIPT},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    argument: 'language',
    run: () =>
      new RunSkillInlineScriptTool(localToolset()).runAsync({
        args: {script_content: 'console.log(1);'},
        toolContext: createContext(),
      }),
  },
];

interface AccumulatingCase {
  tool: string;
  missing: string[];
  run: () => Promise<unknown>;
}

const ACCUMULATING_CASES: AccumulatingCase[] = [
  {
    tool: 'load_skill_resource',
    missing: ['skill_name', 'path'],
    run: () =>
      new LoadSkillResourceTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_script',
    missing: ['skill_name', 'script_path'],
    run: () =>
      new RunSkillScriptTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
  {
    tool: 'run_skill_inline_script',
    missing: ['script_content', 'language'],
    run: () =>
      new RunSkillInlineScriptTool(localToolset()).runAsync({
        args: {},
        toolContext: createContext(),
      }),
  },
];

describe('skill tool error contract', () => {
  it.each(ERROR_CASES)(
    '$tool returns $code under error_code on $scenario',
    async ({code, run}) => {
      const response = await run();

      expect(response).toHaveProperty('error_code', code);
      expect(response).not.toHaveProperty('errorCode');
    },
  );

  it.each(MISSING_ARGUMENT_CASES)(
    "$tool names the missing argument '$argument'",
    async ({argument, run}) => {
      const response = await run();

      expect(response).toEqual({
        error: `Argument '${argument}' is required.`,
        error_code: 'INVALID_ARGUMENTS',
      });
    },
  );

  it.each(ACCUMULATING_CASES)(
    '$tool reports every missing argument in one response',
    async ({missing, run}) => {
      const response = await run();

      expect(response).toEqual({
        error: missing
          .map((argument) => `Argument '${argument}' is required.`)
          .join('\n'),
        error_code: 'INVALID_ARGUMENTS',
      });
    },
  );
});
