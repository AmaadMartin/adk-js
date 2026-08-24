/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  ADK_AGENT_CLASSES,
  AgentConfigErrorCode,
  agentRefYamlConfigSchema,
  baseAgentYamlConfigSchema,
  llmAgentYamlConfigSchema,
  loopAgentYamlConfigSchema,
  parallelAgentYamlConfigSchema,
  parseWithSchema,
  sequentialAgentYamlConfigSchema,
} from '../../../src/agents/configs/agent_config.js';

const INVALID_CONFIG = expect.objectContaining({
  code: AgentConfigErrorCode.INVALID_CONFIG,
});

/**
 * Which schema a document is validated against is the loader's decision, so
 * the cases covering that live in `config_agent_utils_test.ts` and drive
 * `loadAgentFromConfigFile`. The cases here pin the schemas themselves.
 */
describe('ADK_AGENT_CLASSES', () => {
  it('exposes the four built-in agent classes', () => {
    expect(ADK_AGENT_CLASSES).toEqual([
      'LlmAgent',
      'LoopAgent',
      'ParallelAgent',
      'SequentialAgent',
    ]);
  });
});

describe('llmAgentYamlConfigSchema', () => {
  it('applies the documented defaults to a minimal document', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'writer',
        instruction: 'Write code.',
      }),
    ).toEqual({
      agent_class: 'LlmAgent',
      name: 'writer',
      description: '',
      instruction: 'Write code.',
      include_contents: 'default',
    });
  });

  it('rejects a document that sets both model and model_code', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        model: 'gemini-2.5-flash',
        model_code: {name: 'mylib.models.my_model'},
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('accepts a document that sets only model_code', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        model_code: {name: 'mylib.models.my_model'},
      }),
    ).toMatchObject({model_code: {name: 'mylib.models.my_model'}});
  });

  it('accepts a tool entry with free-form args', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        tools: [{name: 'mylib.tools.make_tool', args: {threshold: 1}}],
      }),
    ).toMatchObject({
      tools: [{name: 'mylib.tools.make_tool', args: {threshold: 1}}],
    });
  });

  it('accepts a tool entry naming nothing but a tool', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        tools: [{name: 'google_search'}],
      }),
    ).toMatchObject({tools: [{name: 'google_search'}]});
  });

  it('rejects a tool entry carrying a key beyond name and args', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        tools: [{name: 'google_search', config: {}}],
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('requires an instruction', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {name: 'a'}),
    ).toThrowError(INVALID_CONFIG);
  });

  it('rejects static_instruction, which adk-js LlmAgent does not support', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        static_instruction: 'Static.',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('rejects a camelCase spelling of a field', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        outputKey: 'draft',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('names the offending key when a field is misspelled', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instructions: 'Do it.',
      }),
    ).toThrowError(/instructions/);
  });

  it('keeps include_contents on the wire spelling', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        include_contents: 'none',
      }),
    ).toMatchObject({include_contents: 'none'});
  });

  it('rejects an include_contents value outside the wire vocabulary', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        include_contents: 'all',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('accepts a generate_content_config object without touching its keys', () => {
    expect(
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        generate_content_config: {temperature: 0.5, top_k: 4},
      }),
    ).toMatchObject({generate_content_config: {temperature: 0.5, top_k: 4}});
  });

  it('rejects a non-object generate_content_config', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {
        name: 'a',
        instruction: 'Do it.',
        generate_content_config: 'hot',
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('reports the underlying validation detail', () => {
    expect(() =>
      parseWithSchema(llmAgentYamlConfigSchema, {instruction: 'Do it.'}),
    ).toThrowError(/Invalid agent config:[\s\S]*name/);
  });
});

describe('loopAgentYamlConfigSchema', () => {
  it("rejects a non-integer max_iterations, matching Python's int", () => {
    expect(() =>
      parseWithSchema(loopAgentYamlConfigSchema, {
        agent_class: 'LoopAgent',
        name: 'looper',
        max_iterations: 2.7,
      }),
    ).toThrowError(INVALID_CONFIG);
  });

  it('keeps every wire key as written', () => {
    expect(
      parseWithSchema(loopAgentYamlConfigSchema, {
        agent_class: 'LoopAgent',
        name: 'looper',
        max_iterations: 3,
        sub_agents: [{config_path: 'sub/child.yaml'}],
        before_agent_callbacks: [{name: 'mylib.callbacks.before'}],
      }),
    ).toEqual({
      agent_class: 'LoopAgent',
      name: 'looper',
      description: '',
      max_iterations: 3,
      sub_agents: [{config_path: 'sub/child.yaml'}],
      before_agent_callbacks: [{name: 'mylib.callbacks.before'}],
    });
  });

  it('rejects a camelCase spelling of a field', () => {
    expect(() =>
      parseWithSchema(loopAgentYamlConfigSchema, {
        agent_class: 'LoopAgent',
        name: 'looper',
        maxIterations: 3,
      }),
    ).toThrowError(INVALID_CONFIG);
  });
});

describe('baseAgentYamlConfigSchema', () => {
  it('keeps an unknown agent_class and its extra fields', () => {
    expect(
      parseWithSchema(baseAgentYamlConfigSchema, {
        agent_class: 'mylib.agents.MyCustomAgent',
        name: 'custom',
        other_field: 'other value',
      }),
    ).toEqual({
      agent_class: 'mylib.agents.MyCustomAgent',
      name: 'custom',
      description: '',
      other_field: 'other value',
    });
  });
});

describe('the strict agent config schemas', () => {
  it.each([
    ['LlmAgent', llmAgentYamlConfigSchema, {instruction: 'Do it.'}],
    ['LoopAgent', loopAgentYamlConfigSchema, {}],
    ['ParallelAgent', parallelAgentYamlConfigSchema, {}],
    ['SequentialAgent', sequentialAgentYamlConfigSchema, {}],
  ])(
    'rejects an unknown key on a %s document',
    (_name, schema, extraFields) => {
      expect(() =>
        parseWithSchema(schema, {
          name: 'a',
          ...extraFields,
          not_a_field: true,
        }),
      ).toThrowError(INVALID_CONFIG);
    },
  );
});

describe('agentRefYamlConfigSchema', () => {
  it('accepts a config_path on its own', () => {
    expect(agentRefYamlConfigSchema.parse({config_path: 'child.yaml'})).toEqual(
      {config_path: 'child.yaml'},
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
