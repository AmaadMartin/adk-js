/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  ADK_AGENT_CLASSES,
  AgentConfigErrorCode,
  agentClassDiscriminator,
  agentRefYamlConfigSchema,
  parseAgentYamlConfig,
} from '../../../src/agents/configs/agent_config.js';

const INVALID_CONFIG = expect.objectContaining({
  code: AgentConfigErrorCode.INVALID_CONFIG,
});

describe('agentClassDiscriminator', () => {
  it('defaults a document with no agent_class to LlmAgent', () => {
    expect(agentClassDiscriminator({name: 'writer'})).toBe('LlmAgent');
  });

  it.each([
    ['LlmAgent', 'LlmAgent', 'llm_agent'],
    ['LoopAgent', 'LoopAgent', 'loop_agent'],
    ['ParallelAgent', 'ParallelAgent', 'parallel_agent'],
    ['SequentialAgent', 'SequentialAgent', 'sequential_agent'],
  ])(
    'tags the bare name %s but not its qualified spellings',
    (agentClass, bareName, moduleName) => {
      expect(agentClassDiscriminator({name: 'a', agent_class: bareName})).toBe(
        agentClass,
      );
      expect(
        agentClassDiscriminator({
          name: 'a',
          agent_class: `google.adk.agents.${bareName}`,
        }),
      ).toBe('BaseAgent');
      expect(
        agentClassDiscriminator({
          name: 'a',
          agent_class: `google.adk.agents.${moduleName}.${bareName}`,
        }),
      ).toBe('BaseAgent');
    },
  );

  it('reads an already-camelCased document', () => {
    expect(agentClassDiscriminator({name: 'a', agentClass: 'LoopAgent'})).toBe(
      'LoopAgent',
    );
  });

  it('tags an unknown agent_class as BaseAgent', () => {
    expect(
      agentClassDiscriminator({name: 'a', agent_class: 'mylib.MyCustomAgent'}),
    ).toBe('BaseAgent');
  });

  it.each([[null], [undefined], [42], ['x'], [['a']]])(
    'rejects the non-object document %s',
    (document) => {
      expect(() => agentClassDiscriminator(document)).toThrowError(
        INVALID_CONFIG,
      );
    },
  );

  it('exposes the four built-in agent classes', () => {
    expect(ADK_AGENT_CLASSES).toEqual([
      'LlmAgent',
      'LoopAgent',
      'ParallelAgent',
      'SequentialAgent',
    ]);
  });
});

describe('parseAgentYamlConfig', () => {
  it('applies the LlmAgent defaults to a document with no agent_class', () => {
    expect(
      parseAgentYamlConfig({name: 'writer', instruction: 'Write code.'}),
    ).toEqual({
      agentClass: 'LlmAgent',
      name: 'writer',
      description: '',
      instruction: 'Write code.',
      includeContents: 'default',
    });
  });

  it('keeps an unknown agent_class and its extra fields', () => {
    expect(
      parseAgentYamlConfig({
        agent_class: 'mylib.agents.MyCustomAgent',
        name: 'custom',
        other_field: 'other value',
      }),
    ).toEqual({
      agentClass: 'mylib.agents.MyCustomAgent',
      name: 'custom',
      description: '',
      otherField: 'other value',
    });
  });

  it.each([
    ['LlmAgent', {instruction: 'Do it.'}],
    ['LoopAgent', {}],
    ['ParallelAgent', {}],
    ['SequentialAgent', {}],
  ])('rejects an unknown key on a %s document', (agentClass, extraFields) => {
    expect(() =>
      parseAgentYamlConfig({
        agent_class: agentClass,
        name: 'a',
        ...extraFields,
        not_a_field: true,
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('rejects a document that sets both model and model_code', () => {
    expect(() =>
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        model: 'gemini-2.5-flash',
        model_code: {name: 'mylib.models.my_model'},
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('accepts a document that sets only model_code', () => {
    expect(
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        model_code: {name: 'mylib.models.my_model'},
      }),
    ).toMatchObject({modelCode: {name: 'mylib.models.my_model'}});
  });

  it('rejects a tool entry carrying args', () => {
    expect(() =>
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        tools: [{name: 'mylib.tools.make_tool', args: [{name: 'p', value: 1}]}],
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('requires an instruction on an LlmAgent document', () => {
    expect(() => parseAgentYamlConfig({name: 'a'})).toThrowError(
      INVALID_CONFIG,
    );
  });

  it('rejects static_instruction, which adk-js LlmAgent does not support', () => {
    expect(() =>
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        static_instruction: 'Static.',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it("rejects a non-integer max_iterations, matching Python's int", () => {
    expect(() =>
      parseAgentYamlConfig({
        agent_class: 'LoopAgent',
        name: 'looper',
        max_iterations: 2.7,
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('parses a snake_case and a camelCase document identically', () => {
    const snakeCase = parseAgentYamlConfig({
      agent_class: 'LoopAgent',
      name: 'looper',
      max_iterations: 3,
      sub_agents: [{config_path: 'sub/child.yaml'}],
      before_agent_callbacks: [{name: 'mylib.callbacks.before'}],
    });
    const camelCase = parseAgentYamlConfig({
      agentClass: 'LoopAgent',
      name: 'looper',
      maxIterations: 3,
      subAgents: [{configPath: 'sub/child.yaml'}],
      beforeAgentCallbacks: [{name: 'mylib.callbacks.before'}],
    });

    expect(snakeCase).toEqual(camelCase);
    expect(snakeCase).toEqual({
      agentClass: 'LoopAgent',
      name: 'looper',
      description: '',
      maxIterations: 3,
      subAgents: [{configPath: 'sub/child.yaml'}],
      beforeAgentCallbacks: [{name: 'mylib.callbacks.before'}],
    });
  });

  it('camelCases include_contents and its value stays on the wire spelling', () => {
    expect(
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        include_contents: 'none',
      }),
    ).toMatchObject({includeContents: 'none'});
  });

  it('rejects an include_contents value outside the wire vocabulary', () => {
    expect(() =>
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        include_contents: 'all',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('accepts a generate_content_config object and camelCases its keys', () => {
    expect(
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        generate_content_config: {temperature: 0.5, top_k: 4},
      }),
    ).toMatchObject({generateContentConfig: {temperature: 0.5, topK: 4}});
  });

  it('rejects a non-object generate_content_config', () => {
    expect(() =>
      parseAgentYamlConfig({
        name: 'a',
        instruction: 'Do it.',
        generate_content_config: 'hot',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('reports the underlying validation detail', () => {
    expect(() => parseAgentYamlConfig({instruction: 'Do it.'})).toThrowError(
      /Invalid agent config:[\s\S]*name/,
    );
  });
});

describe('agentRefYamlConfigSchema', () => {
  it('accepts a config_path on its own', () => {
    expect(agentRefYamlConfigSchema.parse({config_path: 'child.yaml'})).toEqual(
      {
        configPath: 'child.yaml',
      },
    );
  });

  it('accepts a code reference on its own', () => {
    expect(
      agentRefYamlConfigSchema.parse({code: 'mylib.agents.child'}),
    ).toEqual({code: 'mylib.agents.child'});
  });

  it('rejects a reference setting neither field', () => {
    expect(() => agentRefYamlConfigSchema.parse({})).toThrowError(
      /Exactly one of/,
    );
  });

  it('rejects a reference setting both fields', () => {
    expect(() =>
      agentRefYamlConfigSchema.parse({
        config_path: 'child.yaml',
        code: 'mylib.agents.child',
      }),
    ).toThrowError(/Exactly one of/);
  });
});
