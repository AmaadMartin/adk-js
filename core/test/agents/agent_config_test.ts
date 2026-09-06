/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentConfigTag,
  InputValidationError,
  agentConfigDiscriminator,
  parseAgentConfig,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isAdkAgentClass} from '../../src/agents/agent_config.js';
import {resetDeprecationWarnings} from '../../src/utils/deprecated.js';
import {logger} from '../../src/utils/logger.js';

const TAG_CASES: Array<[string, Record<string, unknown>, AgentConfigTag]> = [
  ['LlmAgent', {agentClass: 'LlmAgent'}, 'LlmAgent'],
  ['LoopAgent', {agentClass: 'LoopAgent'}, 'LoopAgent'],
  ['ParallelAgent', {agentClass: 'ParallelAgent'}, 'ParallelAgent'],
  ['SequentialAgent', {agentClass: 'SequentialAgent'}, 'SequentialAgent'],
  ['a document with no agent class', {name: 'no_agent_class'}, 'LlmAgent'],
  [
    'an agent class ADK does not own',
    {agentClass: 'mylib.agents.MyAgent'},
    'BaseAgent',
  ],
  [
    'a fully qualified built-in name',
    {agentClass: 'google.adk.agents.LlmAgent'},
    'BaseAgent',
  ],
  ['an agent class that is not a string', {agentClass: 42}, 'BaseAgent'],
];

function snakeCased(document: Record<string, unknown>) {
  const {agentClass, ...rest} = document;
  return agentClass === undefined ? rest : {agent_class: agentClass, ...rest};
}

describe('agentConfigDiscriminator', () => {
  it.each(TAG_CASES)('tags %s', (_name, document, expected) => {
    expect(agentConfigDiscriminator(document)).toBe(expected);
  });

  it.each(TAG_CASES)(
    'tags %s written in snake_case',
    (_name, document, expected) => {
      expect(agentConfigDiscriminator(snakeCased(document))).toBe(expected);
    },
  );

  it.each([null, undefined, 'name: my_agent', [{name: 'my_agent'}], 42])(
    'rejects %s, which is not a mapping',
    (malformed) => {
      expect(() => agentConfigDiscriminator(malformed)).toThrow(
        InputValidationError,
      );
      expect(() => agentConfigDiscriminator(malformed)).toThrow(
        /Invalid agent config/,
      );
    },
  );
});

describe('isAdkAgentClass', () => {
  it('accepts a bare built-in name and rejects everything else', () => {
    expect(isAdkAgentClass('LoopAgent')).toBe(true);
    expect(isAdkAgentClass('google.adk.agents.LoopAgent')).toBe(false);
    expect(isAdkAgentClass(42)).toBe(false);
  });
});

describe('parseAgentConfig', () => {
  it('defaults a document with no agent class to an LlmAgent', () => {
    const config = parseAgentConfig({
      name: 'search_agent',
      model: 'gemini-2.5-flash',
      description: 'a sample description',
      instruction: 'a fake instruction',
      tools: [{name: 'google_search'}],
    });

    expect(config).toEqual({
      agentClass: 'LlmAgent',
      name: 'search_agent',
      model: 'gemini-2.5-flash',
      description: 'a sample description',
      instruction: 'a fake instruction',
      includeContents: 'default',
      tools: [{name: 'google_search'}],
    });
  });

  it.each([
    ['LlmAgent', {instruction: 'a fake instruction'}],
    ['LoopAgent', {}],
    ['ParallelAgent', {}],
    ['SequentialAgent', {}],
  ])('routes the bare name %s to its own config shape', (agentClass, extra) => {
    const config = parseAgentConfig({
      agent_class: agentClass,
      name: 'my_agent',
      description: 'a sample description',
      sub_agents: [],
      ...extra,
    });

    expect(config.agentClass).toBe(agentClass);
    // The built-in shapes reject unknown keys, so reaching one proves the
    // document was not routed to the open base shape.
    expect(() =>
      parseAgentConfig({
        agent_class: agentClass,
        name: 'my_agent',
        other_field: 'other value',
        ...extra,
      }),
    ).toThrow(/otherField/);
  });

  it.each([
    'google.adk.agents.LlmAgent',
    'google.adk.agents.llm_agent.LlmAgent',
    'google.adk.agents.LoopAgent',
    'google.adk.agents.loop_agent.LoopAgent',
    'google.adk.agents.ParallelAgent',
    'google.adk.agents.parallel_agent.ParallelAgent',
    'google.adk.agents.SequentialAgent',
    'google.adk.agents.sequential_agent.SequentialAgent',
  ])('keeps the fully qualified name %s verbatim on the base shape', (name) => {
    const config = parseAgentConfig({agent_class: name, name: 'my_agent'});

    expect(config).toEqual({
      agentClass: name,
      name: 'my_agent',
      description: '',
    });
  });

  it('keeps the extra keys of a custom agent class, camelCased', () => {
    const config = parseAgentConfig({
      agent_class: 'mylib.agents.MyCustomAgent',
      name: 'CodePipelineAgent',
      description: 'Executes a sequence of code writing and reviewing.',
      other_field: 'other value',
    });

    expect(config).toEqual({
      agentClass: 'mylib.agents.MyCustomAgent',
      name: 'CodePipelineAgent',
      description: 'Executes a sequence of code writing and reviewing.',
      otherField: 'other value',
    });
  });

  it('rejects a document that sets both model and model_code', () => {
    expect(() =>
      parseAgentConfig({
        name: 'my_agent',
        instruction: 'do the thing',
        model: 'gemini-2.5-flash',
        model_code: {name: 'my_library.clients.my_litellm'},
      }),
    ).toThrow(
      'Only one of `model` or `model_code` should be set, but both were provided.',
    );
  });

  it('names both values in the model and model_code conflict', () => {
    expect(() =>
      parseAgentConfig({
        name: 'my_agent',
        instruction: 'do the thing',
        model: 'gemini-2.5-flash',
        model_code: {name: 'my_library.clients.my_litellm'},
      }),
    ).toThrow(
      'Got model="gemini-2.5-flash" and model_code={"name":"my_library.clients.my_litellm"}.',
    );
  });

  it('rejects a misspelled key on an LlmAgent instead of dropping it', () => {
    expect(() =>
      parseAgentConfig({
        name: 'my_agent',
        instruction: 'do the thing',
        instructions: 'do the other thing',
      }),
    ).toThrow(/instructions/);
  });

  it('rejects an LlmAgent with no instruction', () => {
    expect(() => parseAgentConfig({name: 'my_agent'})).toThrow(
      InputValidationError,
    );
    expect(() => parseAgentConfig({name: 'my_agent'})).toThrow(/instruction/);
  });

  it('carries the documented defaults of a minimal LlmAgent', () => {
    const config = parseAgentConfig({
      name: 'my_agent',
      instruction: 'do the thing',
    });

    expect(config).toEqual({
      agentClass: 'LlmAgent',
      name: 'my_agent',
      description: '',
      instruction: 'do the thing',
      includeContents: 'default',
    });
  });

  it.each([3, 0])('round trips max_iterations %i', (maxIterations) => {
    const config = parseAgentConfig({
      agent_class: 'LoopAgent',
      name: 'looper',
      description: 'repeats its sub agents',
      max_iterations: maxIterations,
      sub_agents: [],
    });

    expect(config).toEqual({
      agentClass: 'LoopAgent',
      name: 'looper',
      description: 'repeats its sub agents',
      maxIterations,
      subAgents: [],
    });
  });

  it('rejects a max_iterations that is not an integer', () => {
    expect(() =>
      parseAgentConfig({
        agent_class: 'LoopAgent',
        name: 'looper',
        max_iterations: 2.5,
      }),
    ).toThrow(/maxIterations/);
  });

  it('keeps the nested shapes of an LlmAgent through a round trip', () => {
    const config = parseAgentConfig({
      name: 'my_agent',
      instruction: 'do the thing',
      static_instruction: 'read this first',
      include_contents: 'none',
      output_key: 'result',
      input_schema: {name: 'my_library.schemas.Input'},
      output_schema: {name: 'my_library.schemas.Output'},
      disallow_transfer_to_parent: true,
      disallow_transfer_to_peers: false,
      sub_agents: [
        {config_path: 'search_agent.yaml'},
        {code: 'my_library.agents.a'},
      ],
      before_agent_callbacks: [{name: 'my_library.callbacks.before_agent'}],
      after_agent_callbacks: [{name: 'my_library.callbacks.after_agent'}],
      before_model_callbacks: [{name: 'my_library.callbacks.before_model'}],
      after_model_callbacks: [{name: 'my_library.callbacks.after_model'}],
      before_tool_callbacks: [{name: 'my_library.callbacks.before_tool'}],
      after_tool_callbacks: [{name: 'my_library.callbacks.after_tool'}],
      tools: [
        {name: 'google_search'},
        {name: 'my_library.my_tools.make', args: {top_k: 5}},
      ],
      generate_content_config: {temperature: 0.5},
    });

    expect(config).toEqual({
      agentClass: 'LlmAgent',
      name: 'my_agent',
      description: '',
      instruction: 'do the thing',
      staticInstruction: 'read this first',
      includeContents: 'none',
      outputKey: 'result',
      inputSchema: {name: 'my_library.schemas.Input'},
      outputSchema: {name: 'my_library.schemas.Output'},
      disallowTransferToParent: true,
      disallowTransferToPeers: false,
      subAgents: [
        {configPath: 'search_agent.yaml'},
        {code: 'my_library.agents.a'},
      ],
      beforeAgentCallbacks: [{name: 'my_library.callbacks.before_agent'}],
      afterAgentCallbacks: [{name: 'my_library.callbacks.after_agent'}],
      beforeModelCallbacks: [{name: 'my_library.callbacks.before_model'}],
      afterModelCallbacks: [{name: 'my_library.callbacks.after_model'}],
      beforeToolCallbacks: [{name: 'my_library.callbacks.before_tool'}],
      afterToolCallbacks: [{name: 'my_library.callbacks.after_tool'}],
      // The camelCasing is deep, so it renames the keys of a free-form args bag.
      tools: [
        {name: 'google_search'},
        {name: 'my_library.my_tools.make', args: {topK: 5}},
      ],
      generateContentConfig: {temperature: 0.5},
    });
  });

  it('accepts a Content object as the static instruction', () => {
    const config = parseAgentConfig({
      name: 'my_agent',
      instruction: 'do the thing',
      static_instruction: {parts: [{text: 'read this first'}], role: 'user'},
    });

    expect(config).toMatchObject({
      staticInstruction: {parts: [{text: 'read this first'}], role: 'user'},
    });
  });

  it('accepts a list of parts as the static instruction', () => {
    const config = parseAgentConfig({
      name: 'my_agent',
      instruction: 'do the thing',
      static_instruction: [{text: 'read this first'}, 'and this'],
    });

    expect(config).toMatchObject({
      staticInstruction: [{text: 'read this first'}, 'and this'],
    });
  });

  it.each([null, 42, true])(
    'rejects %s as the static instruction, which is not a ContentUnion',
    (staticInstruction) => {
      expect(() =>
        parseAgentConfig({
          name: 'my_agent',
          instruction: 'do the thing',
          static_instruction: staticInstruction,
        }),
      ).toThrow(/staticInstruction must be a string, a Part, or a Content/);
    },
  );

  it('rejects a list as the generate_content_config', () => {
    expect(() =>
      parseAgentConfig({
        name: 'my_agent',
        instruction: 'do the thing',
        generate_content_config: [{temperature: 0.5}],
      }),
    ).toThrow(/generateContentConfig must be an object/);
  });

  it('rejects a generate_content_config that is not an object', () => {
    expect(() =>
      parseAgentConfig({
        name: 'my_agent',
        instruction: 'do the thing',
        generate_content_config: 'hot',
      }),
    ).toThrow(/generateContentConfig must be an object/);
  });

  it('keeps the unknown keys of the base shape', () => {
    const config = parseAgentConfig({
      agent_class: 'mylib.agents.MyAgent',
      name: 'my_agent',
      other_field: 'other value',
    });

    expect(config).toEqual({
      agentClass: 'mylib.agents.MyAgent',
      name: 'my_agent',
      description: '',
      otherField: 'other value',
    });
  });

  it('does not mutate the document it was given', () => {
    const document = {name: 'my_agent', instruction: 'do the thing'};

    parseAgentConfig(document);

    expect(document).toEqual({name: 'my_agent', instruction: 'do the thing'});
  });
});

describe('the parseAgentConfig deprecation warning', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('is logged once, not once per call', () => {
    const document = {name: 'my_agent', instruction: 'do the thing'};

    parseAgentConfig(document);
    parseAgentConfig(document);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(
      'AgentConfig is deprecated',
    );
  });
});
