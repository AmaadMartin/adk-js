/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  InputValidationError,
  llmAgentFromConfig,
  parseLlmAgentConfig,
  Runner,
} from '@google/adk';
import yaml from 'js-yaml';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

import {callOrder, preconfiguredModel} from './fixtures/config_code_refs.js';

/** A config file beside the fixture module its `./` references name. */
const CONFIG_PATH = fileURLToPath(
  new URL('./fixtures/root_agent.yaml', import.meta.url),
);

/** The smallest document the schema accepts. */
const MINIMAL = {name: 'search_agent', instruction: 'Answer the question.'};

describe('parseLlmAgentConfig', () => {
  it('fills in every default from a minimal document', () => {
    const config = parseLlmAgentConfig(MINIMAL);

    expect(config).toEqual({
      agentClass: 'LlmAgent',
      name: 'search_agent',
      description: '',
      instruction: 'Answer the question.',
      includeContents: 'default',
    });
  });

  it('keeps an agent class the document names', () => {
    const config = parseLlmAgentConfig({
      ...MINIMAL,
      'agent_class': 'google.adk.agents.llm_agent.LlmAgent',
    });

    expect(config.agentClass).toBe('google.adk.agents.llm_agent.LlmAgent');
  });

  it('rejects a document with no instruction', () => {
    expect(() => parseLlmAgentConfig({name: 'search_agent'})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a document with no name', () => {
    expect(() => parseLlmAgentConfig({instruction: 'Answer.'})).toThrow(
      InputValidationError,
    );
  });

  it('rejects a document setting both model and model_code', () => {
    try {
      parseLlmAgentConfig({
        ...MINIMAL,
        model: 'gemini-2.5-flash',
        'model_code': {name: './clients.js#myLlm'},
      });
      expect.fail('expected the call to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InputValidationError);
      expect(error).toHaveProperty(
        'cause.issues.0.message',
        'Only one of `model` or `model_code` should be set, but both were ' +
          'provided. Got model="gemini-2.5-flash" and ' +
          'model_code={"name":"./clients.js#myLlm"}.',
      );
    }
  });

  it('rejects a misspelled key and names it', () => {
    try {
      parseLlmAgentConfig({...MINIMAL, instructions: 'Answer.'});
      expect.fail('expected the call to throw');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InputValidationError);
      expect(error).toHaveProperty('cause.issues.0.keys.0', 'instructions');
    }
  });

  it('accepts the snake_case spelling adk-python writes', () => {
    const config = parseLlmAgentConfig({
      ...MINIMAL,
      'output_key': 'answer',
      'include_contents': 'none',
      'disallow_transfer_to_parent': true,
      'before_model_callbacks': [{name: './callbacks.js#redactPii'}],
    });

    expect(config.outputKey).toBe('answer');
    expect(config.includeContents).toBe('none');
    expect(config.disallowTransferToParent).toBe(true);
    expect(config.beforeModelCallbacks).toEqual([
      {name: './callbacks.js#redactPii'},
    ]);
  });

  it('keeps the keys of a tool args object verbatim', () => {
    const config = parseLlmAgentConfig({
      ...MINIMAL,
      tools: [
        {name: './my_tools.js#createRetriever', args: {'corpus_id': 'docs'}},
      ],
    });

    expect(config.tools?.[0].args).toEqual({'corpus_id': 'docs'});
  });

  it('camelCases the keys nested in a generate_content_config', () => {
    const config = parseLlmAgentConfig({
      ...MINIMAL,
      'generate_content_config': {
        temperature: 0.2,
        'thinking_config': {'include_thoughts': true},
      },
    });

    expect(config.generateContentConfig).toEqual({
      temperature: 0.2,
      thinkingConfig: {includeThoughts: true},
    });
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseLlmAgentConfig('not a document')).toThrow(
      InputValidationError,
    );
  });

  it('rejects a generate_content_config that is not an object', () => {
    expect(() =>
      parseLlmAgentConfig({...MINIMAL, 'generate_content_config': 'warm'}),
    ).toThrow(InputValidationError);
  });
});

describe('an agent built from a YAML document', () => {
  const document = `
agent_class: LlmAgent
name: search_agent
description: answers questions with a web search
instruction: Answer the user's question.
model_code:
  name: ./config_code_refs.ts#preconfiguredModel
output_key: answer
tools:
  - name: ./config_code_refs.ts#createRetriever
    args:
      corpus_id: docs-prod
before_model_callbacks:
  - name: ./config_code_refs.ts#firstCallback
  - name: ./config_code_refs.ts#secondCallback
`;

  it('runs the turn the document describes', async () => {
    const config = parseLlmAgentConfig(yaml.load(document));
    const agent = await llmAgentFromConfig(config, CONFIG_PATH);
    callOrder.length = 0;

    const sessionService = new InMemorySessionService();
    const runner = new Runner({appName: 'config_app', agent, sessionService});
    const session = await sessionService.createSession({
      appName: 'config_app',
      userId: 'test_user',
    });

    const texts: string[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'Where are the docs?'}]},
    })) {
      for (const part of event.content?.parts ?? []) {
        if (part.text) {
          texts.push(part.text);
        }
      }
    }

    expect(texts).toContain('a scripted reply');
    expect(callOrder).toEqual(['first', 'second']);

    expect(agent.model).toBe(preconfiguredModel);
    const request = preconfiguredModel.seen.at(-1);
    expect(request?.config?.systemInstruction).toContain(
      "Answer the user's question.",
    );
    const declared = (request?.config?.tools ?? []).flatMap((tool) =>
      'functionDeclarations' in tool
        ? (tool.functionDeclarations ?? []).map((d) => d.name)
        : [],
    );
    expect(declared).toContain('retrieve_docs-prod');

    const stored = await sessionService.getSession({
      appName: 'config_app',
      userId: session.userId,
      sessionId: session.id,
    });
    expect(stored?.state?.['answer']).toBe('a scripted reply');
  });
});
