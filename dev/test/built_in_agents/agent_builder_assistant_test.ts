/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InstructionProvider,
  LlmAgent,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {createAgentBuilderAssistant} from '../../src/built_in_agents/agent_builder_assistant.js';

import {createTestContext, useTempDirs} from './test_helpers.js';

/** A model object that only has to carry its id. */
class StubLlm extends BaseLlm {
  generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    throw new Error('Not implemented');
  }

  connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Not implemented');
  }
}

/**
 * Narrows the agent's instruction to the provider the assistant installs.
 *
 * @param agent The assistant under test.
 * @return The instruction provider.
 */
function instructionProviderOf(agent: LlmAgent): InstructionProvider {
  const {instruction} = agent;
  if (typeof instruction !== 'function') {
    expect.fail('The assistant must resolve its instruction per invocation.');
  }
  return instruction;
}

/**
 * Resolves the instruction for a session bound to `rootDirectory`.
 *
 * @param agent The assistant under test.
 * @param rootDirectory The project root the session state carries.
 * @return The instruction text.
 */
async function instructionFor(
  agent: LlmAgent,
  rootDirectory: string,
): Promise<string> {
  return instructionProviderOf(agent)(
    createTestContext({root_directory: rootDirectory}),
  );
}

describe('createAgentBuilderAssistant', () => {
  const tempDir = useTempDirs();

  it('exposes exactly the workspace file tools', async () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const tools = await agent.canonicalTools();

    expect(agent.name).toBe('agent_builder_assistant');
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(['read_files', 'write_files', 'delete_files']),
    );
  });

  it('caps the reply at 8192 output tokens', () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    expect(agent.generateContentConfig?.maxOutputTokens).toBe(8192);
  });

  it('names the requested model and the session project folder', async () => {
    const projectDir = path.join(await tempDir(), 'my_agent_project');
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionFor(agent, projectDir);

    expect(instruction).toContain('gemini-2.0-flash');
    expect(instruction).toContain('my_agent_project');
  });

  it('leaves no unsubstituted placeholder in the instruction', async () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionFor(agent, await tempDir());

    expect(instruction).not.toMatch(/\{[a-z_]+\}/i);
  });

  it('states the path rule against the session project folder', async () => {
    const projectDir = path.join(await tempDir(), 'dice_roller');
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionFor(agent, projectDir);

    expect(instruction).toContain('WRONG: `dice_roller/agent.ts`');
    expect(instruction).toContain('CORRECT: `agent.ts`');
  });

  it('describes only the three tools the assistant carries', async () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionFor(agent, await tempDir());

    expect(instruction).toContain('`read_files`');
    expect(instruction).toContain('`write_files`');
    expect(instruction).toContain('`delete_files`');
    expect(instruction).not.toContain('explore_project');
    expect(instruction).not.toContain('search_adk_knowledge');
    expect(instruction).not.toContain('write_config_files');
  });

  it('defaults to gemini-2.5-pro', async () => {
    const agent = createAgentBuilderAssistant();

    const instruction = await instructionFor(agent, await tempDir());

    expect(agent.model).toBe('gemini-2.5-pro');
    expect(instruction).toContain('gemini-2.5-pro');
  });

  it('reads the model id off a model object', async () => {
    const agent = createAgentBuilderAssistant({
      model: new StubLlm({model: 'stub-model-id'}),
    });

    const instruction = await instructionFor(agent, await tempDir());

    expect(instruction).toContain('stub-model-id');
  });

  it('falls back to "project" when the root has no folder name', async () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionFor(
      agent,
      path.parse(process.cwd()).root,
    );

    expect(instruction).toContain('Project folder name: `project`');
  });

  it('names the working directory when the session carries no root', async () => {
    const agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});

    const instruction = await instructionProviderOf(agent)(
      createTestContext({}),
    );

    expect(instruction).toContain(
      `Project folder name: \`${path.basename(process.cwd())}\``,
    );
  });
});
