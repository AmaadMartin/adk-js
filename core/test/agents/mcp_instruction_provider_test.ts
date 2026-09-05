/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for this module, ported one for one.
 *
 * Source: `google/adk-python`, branch `main`,
 * `tests/unittests/agents/test_mcp_instruction_provider.py`. Each `it()` name
 * is the Python test name verbatim so the two suites stay greppable.
 */

import {
  createSession,
  InvocationContext,
  MCPConnectionParams,
  mcpInstructionProvider,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const listPrompts = vi.fn();
  const getPrompt = vi.fn();
  const session = {listPrompts, getPrompt};
  const createMcpSession = vi.fn().mockResolvedValue(session);
  const closeSession = vi.fn().mockResolvedValue(undefined);
  return {
    listPrompts,
    getPrompt,
    session,
    createMcpSession,
    closeSession,
    MCPSessionManager: vi.fn().mockImplementation(() => ({
      createSession: createMcpSession,
      closeSession,
    })),
  };
});

vi.mock(
  '../../src/tools/mcp/mcp_session_manager.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../src/tools/mcp/mcp_session_manager.js')
    >()),
    MCPSessionManager: mocks.MCPSessionManager,
  }),
);

const CONNECTION_PARAMS: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8000/mcp',
};
const PROMPT_NAME = 'test_prompt';

/** Builds a ReadonlyContext over a real session holding `state`. */
function makeContext(state: Record<string, unknown>): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv_1',
      session: createSession({id: 'sess_1', appName: 'app', state}),
      pluginManager: new PluginManager(),
    }),
  );
}

describe('McpInstructionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMcpSession.mockResolvedValue(mocks.session);
  });

  it('test_call_success_no_args', async () => {
    mocks.listPrompts.mockResolvedValue({
      prompts: [{name: PROMPT_NAME, arguments: undefined}],
    });
    mocks.getPrompt.mockResolvedValue({
      messages: [
        {content: {type: 'text', text: 'instruction part 1. '}},
        {content: {type: 'text', text: 'instruction part 2'}},
      ],
    });
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    const instruction = await provider(makeContext({}));

    expect(instruction).toBe('instruction part 1. instruction part 2');
    expect(mocks.getPrompt).toHaveBeenCalledExactlyOnceWith({
      name: PROMPT_NAME,
      arguments: {},
    });
  });

  it('test_call_success_with_args', async () => {
    mocks.listPrompts.mockResolvedValue({
      prompts: [{name: PROMPT_NAME, arguments: [{name: 'arg1'}]}],
    });
    mocks.getPrompt.mockResolvedValue({
      messages: [{content: {type: 'text', text: 'instruction with arg1'}}],
    });
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    const instruction = await provider(
      makeContext({arg1: 'value1', arg2: 'value2'}),
    );

    expect(instruction).toBe('instruction with arg1');
    expect(mocks.getPrompt).toHaveBeenCalledExactlyOnceWith({
      name: PROMPT_NAME,
      arguments: {arg1: 'value1'},
    });
  });

  it('test_call_prompt_not_found_in_list_prompts', async () => {
    mocks.listPrompts.mockResolvedValue({prompts: []});
    mocks.getPrompt.mockResolvedValue({
      messages: [{content: {type: 'text', text: 'instruction'}}],
    });
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    const instruction = await provider(makeContext({arg1: 'value1'}));

    expect(instruction).toBe('instruction');
    expect(mocks.getPrompt).toHaveBeenCalledExactlyOnceWith({
      name: PROMPT_NAME,
      arguments: {},
    });
  });

  it('test_call_get_prompt_returns_no_messages', async () => {
    mocks.listPrompts.mockResolvedValue({prompts: []});
    mocks.getPrompt.mockResolvedValue({messages: []});
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await expect(provider(makeContext({}))).rejects.toThrow(
      "Failed to load MCP prompt 'test_prompt'.",
    );

    expect(mocks.getPrompt).toHaveBeenCalledExactlyOnceWith({
      name: PROMPT_NAME,
      arguments: {},
    });
  });

  it('test_call_ignore_non_text_messages', async () => {
    mocks.listPrompts.mockResolvedValue({
      prompts: [{name: PROMPT_NAME, arguments: undefined}],
    });
    mocks.getPrompt.mockResolvedValue({
      messages: [
        {content: {type: 'text', text: 'instruction part 1. '}},
        {content: {type: 'image', data: 'aWdub3JlZA==', mimeType: 'image/png'}},
        {content: {type: 'text', text: 'instruction part 2'}},
      ],
    });
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    const instruction = await provider(makeContext({}));

    expect(instruction).toBe('instruction part 1. instruction part 2');
    expect(mocks.getPrompt).toHaveBeenCalledExactlyOnceWith({
      name: PROMPT_NAME,
      arguments: {},
    });
  });
});
