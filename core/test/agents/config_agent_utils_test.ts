/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  isBaseTool,
  llmAgentFromConfig,
  parseLlmAgentConfig,
  resolveCallbacks,
  resolveTools,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {
  answerSchema,
  factoryArgs,
  firstCallback,
  genaiAnswerSchema,
  helperAgent,
  preconfiguredModel,
  searchTool,
  searchToolset,
  secondCallback,
} from './fixtures/config_code_refs.js';

/** A config file beside the fixture module its `./` references name. */
const CONFIG_PATH = fileURLToPath(
  new URL('./fixtures/root_agent.yaml', import.meta.url),
);

/** Names an export of the fixture module, the way a document would. */
function ref(exportName: string): string {
  return `./config_code_refs.ts#${exportName}`;
}

/** The fields every document below has to carry. */
const MINIMAL = {name: 'search_agent', instruction: 'Answer the question.'};

/** Builds the agent a document describes, against the fixture module. */
async function agentFrom(document: Record<string, unknown>) {
  return llmAgentFromConfig(
    parseLlmAgentConfig({...MINIMAL, ...document}),
    CONFIG_PATH,
  );
}

/** Returns the error a call rejects with, failing the test if it resolves. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => expect.fail('expected the call to reject'),
    (err: unknown) => err,
  );
}

describe('resolveCallbacks', () => {
  it('returns an empty list for no configs', async () => {
    await expect(resolveCallbacks(undefined)).resolves.toEqual([]);
    await expect(resolveCallbacks([])).resolves.toEqual([]);
  });

  it('rejects a name that does not resolve, keeping the cause', async () => {
    const error = await rejectionOf(
      resolveCallbacks([{name: ref('noSuchExport')}], CONFIG_PATH),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'message',
      `Invalid fully qualified name: ${ref('noSuchExport')}`,
    );
    expect(error).toHaveProperty('cause');
  });

  it('preserves the order the document lists', async () => {
    const resolved = await resolveCallbacks(
      [{name: ref('secondCallback')}, {name: ref('firstCallback')}],
      CONFIG_PATH,
    );

    expect(resolved).toEqual([secondCallback, firstCallback]);
  });

  it('rejects a reference that is not a function', async () => {
    await expect(
      resolveCallbacks([{name: ref('notAnything')}], CONFIG_PATH),
    ).rejects.toThrow(
      `The callback \`${ref('notAnything')}\` is not a function.`,
    );
  });
});

describe('resolveTools', () => {
  it('returns an empty list for no configs', async () => {
    await expect(resolveTools(undefined)).resolves.toEqual([]);
  });

  it('uses a tool instance as it is', async () => {
    await expect(
      resolveTools([{name: ref('searchTool')}], CONFIG_PATH),
    ).resolves.toEqual([searchTool]);
  });

  it('uses a toolset as it is', async () => {
    await expect(
      resolveTools([{name: ref('searchToolset')}], CONFIG_PATH),
    ).resolves.toEqual([searchToolset]);
  });

  it('calls a factory with the declared args', async () => {
    const [tool] = await resolveTools(
      [{name: ref('createRetriever'), args: {'corpus_id': 'docs-prod'}}],
      CONFIG_PATH,
    );

    expect(isBaseTool(tool) && tool.name).toBe('retrieve_docs-prod');
  });

  it('calls a factory with no args with an empty object', async () => {
    factoryArgs.length = 0;

    const [tool] = await resolveTools(
      [{name: ref('createRetriever')}],
      CONFIG_PATH,
    );

    expect(factoryArgs).toEqual([{}]);
    expect(isBaseTool(tool) && tool.name).toBe('retrieve_default-corpus');
  });

  it('awaits an async factory', async () => {
    const [tool] = await resolveTools(
      [{name: ref('createRetrieverAsync'), args: {'corpus_id': 'docs'}}],
      CONFIG_PATH,
    );

    expect(isBaseTool(tool) && tool.name).toBe('retrieve_docs');
  });

  it('rejects args on a reference to an existing tool', async () => {
    await expect(
      resolveTools([{name: ref('searchTool'), args: {a: 1}}], CONFIG_PATH),
    ).rejects.toThrow(
      `The tool \`${ref('searchTool')}\` names a tool that already exists, ` +
        `so its \`args\` would not be read. Name a factory instead, or drop ` +
        `the \`args\`.`,
    );
  });

  it('rejects a reference that is neither a tool nor a factory', async () => {
    await expect(
      resolveTools([{name: ref('notAnything')}], CONFIG_PATH),
    ).rejects.toThrow(
      `The tool \`${ref('notAnything')}\` names neither a tool, a toolset, ` +
        `nor a factory that builds one.`,
    );
  });

  it('rejects a factory that returns something other than a tool', async () => {
    await expect(
      resolveTools([{name: ref('createNothing')}], CONFIG_PATH),
    ).rejects.toThrow(
      `The tool factory \`${ref('createNothing')}\` returned neither a tool ` +
        `nor a toolset.`,
    );
  });

  it('reports a class named as a factory, keeping the cause', async () => {
    const error = await rejectionOf(
      resolveTools([{name: ref('NotAFactory')}], CONFIG_PATH),
    );

    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toHaveProperty(
      'message',
      `The tool factory \`${ref('NotAFactory')}\` failed.`,
    );
    expect(error).toHaveProperty('cause');
  });
});

describe('llmAgentFromConfig', () => {
  it('passes the model_code object through by identity', async () => {
    const agent = await agentFrom({
      'model_code': {name: ref('preconfiguredModel')},
    });

    expect(agent.model).toBe(preconfiguredModel);
  });

  it('rejects a model_code that is not a model', async () => {
    await expect(
      agentFrom({'model_code': {name: ref('searchTool')}}),
    ).rejects.toThrow(`The model \`${ref('searchTool')}\` is not a BaseLlm.`);
  });

  it('keeps a model named by string', async () => {
    const agent = await agentFrom({model: 'gemini-2.5-flash'});

    expect(agent.model).toBe('gemini-2.5-flash');
  });

  it('runs the model callbacks in the order the document lists', async () => {
    const agent = await agentFrom({
      'before_model_callbacks': [
        {name: ref('firstCallback')},
        {name: ref('secondCallback')},
      ],
    });

    expect(agent.beforeModelCallback).toEqual([firstCallback, secondCallback]);
  });

  it('carries every callback kind onto the agent', async () => {
    const agent = await agentFrom({
      'before_agent_callbacks': [{name: ref('beforeAgentCallback')}],
      'after_agent_callbacks': [{name: ref('beforeAgentCallback')}],
      'after_model_callbacks': [{name: ref('firstCallback')}],
      'before_tool_callbacks': [{name: ref('firstCallback')}],
      'after_tool_callbacks': [{name: ref('secondCallback')}],
    });

    expect(agent.beforeAgentCallback).toHaveLength(1);
    expect(agent.afterAgentCallback).toHaveLength(1);
    expect(agent.afterModelCallback).toEqual([firstCallback]);
    expect(agent.beforeToolCallback).toEqual([firstCallback]);
    expect(agent.afterToolCallback).toEqual([secondCallback]);
  });

  it('leaves a callback option unset when the document omits it', async () => {
    const agent = await agentFrom({});

    expect(agent.beforeModelCallback).toBeUndefined();
    expect(agent.afterToolCallback).toBeUndefined();
  });

  it('accepts a Zod schema reference', async () => {
    const agent = await agentFrom({
      'input_schema': {name: ref('answerSchema')},
      'output_schema': {name: ref('answerSchema')},
    });

    expect(agent.inputSchemaSource).toBe(answerSchema);
    expect(agent.outputSchemaSource).toBe(answerSchema);
  });

  it('accepts a schema object reference', async () => {
    const agent = await agentFrom({
      'output_schema': {name: ref('genaiAnswerSchema')},
    });

    expect(agent.outputSchema).toBe(genaiAnswerSchema);
  });

  it('rejects a schema reference that names a function', async () => {
    await expect(
      agentFrom({'input_schema': {name: ref('createRetriever')}}),
    ).rejects.toThrow(
      `The schema \`${ref('createRetriever')}\` is neither a Zod object nor ` +
        `a schema object.`,
    );
  });

  it('adds a sub-agent named by code', async () => {
    const agent = await agentFrom({
      'sub_agents': [{code: ref('helperAgent')}],
    });

    expect(agent.subAgents).toEqual([helperAgent]);
  });

  it('rejects a sub-agent reference that is not an agent', async () => {
    await expect(
      agentFrom({'sub_agents': [{code: ref('searchTool')}]}),
    ).rejects.toThrow(
      `The sub-agent \`${ref('searchTool')}\` is not an agent.`,
    );
  });

  it('rejects a sub-agent loaded from its own config file', async () => {
    await expect(
      agentFrom({'sub_agents': [{'config_path': './helper.yaml'}]}),
    ).rejects.toThrow(
      'Loading the sub-agent declared by `./helper.yaml` from its own ' +
        'config file is not supported yet. Name the agent with `code` ' +
        'instead.',
    );
  });

  it('rejects a sub-agent reference that sets both sources', async () => {
    await expect(
      agentFrom({
        'sub_agents': [{code: ref('helperAgent'), 'config_path': './h.yaml'}],
      }),
    ).rejects.toThrow(
      'An agent reference sets both `code` and `configPath`; exactly one of ' +
        '`code` and `configPath` must be set.',
    );
  });

  it('rejects a sub-agent reference that sets neither source', async () => {
    await expect(agentFrom({'sub_agents': [{}]})).rejects.toThrow(
      'An agent reference sets neither `code` nor `configPath`; exactly one ' +
        'of `code` and `configPath` must be set.',
    );
  });

  it('carries every plain field onto the agent', async () => {
    const agent = await agentFrom({
      description: 'answers questions',
      'output_key': 'answer',
      'include_contents': 'none',
      'disallow_transfer_to_parent': true,
      'disallow_transfer_to_peers': true,
      'generate_content_config': {temperature: 0.25},
      tools: [{name: ref('searchTool')}],
    });

    expect(agent.name).toBe('search_agent');
    expect(agent.instruction).toBe('Answer the question.');
    expect(agent.description).toBe('answers questions');
    expect(agent.outputKey).toBe('answer');
    expect(agent.includeContents).toBe('none');
    expect(agent.disallowTransferToParent).toBe(true);
    expect(agent.disallowTransferToPeers).toBe(true);
    expect(agent.generateContentConfig).toEqual({temperature: 0.25});
    expect(agent.tools).toEqual([searchTool]);
  });

  it('leaves an unset option at the agent default', async () => {
    const agent = await agentFrom({});

    expect(agent.model).toBeUndefined();
    expect(agent.outputKey).toBeUndefined();
    expect(agent.disallowTransferToParent).toBe(false);
    expect(agent.disallowTransferToPeers).toBe(false);
    // `LlmAgent` fills in an empty object when the option is absent.
    expect(agent.generateContentConfig).toEqual({});
    expect(agent.tools).toEqual([]);
    expect(agent.subAgents).toEqual([]);
  });
});
