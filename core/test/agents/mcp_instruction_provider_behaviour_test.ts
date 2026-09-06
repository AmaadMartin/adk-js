/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour adk-js adds on top of the ported adk-python reference tests in
 * `mcp_instruction_provider_test.ts`: session closing, argument serialization
 * and session-manager reuse.
 */

import {
  createSession,
  InvocationContext,
  LlmAgent,
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

/** Makes the server advertise `PROMPT_NAME` declaring `argNames`. */
function advertisePrompt(argNames: string[]): void {
  mocks.listPrompts.mockResolvedValue({
    prompts: [{name: PROMPT_NAME, arguments: argNames.map((name) => ({name}))}],
  });
}

/** The `arguments` object of the single recorded `getPrompt` call. */
function forwardedArgs(): Record<string, string> | undefined {
  const call = mocks.getPrompt.mock.calls[0];
  expect(call).toBeDefined();
  return call[0].arguments;
}

describe('mcpInstructionProvider behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMcpSession.mockResolvedValue(mocks.session);
    advertisePrompt([]);
    mocks.getPrompt.mockResolvedValue({
      messages: [{content: {type: 'text', text: 'instruction'}}],
    });
  });

  it('closes the session on the success path', async () => {
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await provider(makeContext({}));

    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(mocks.session);
  });

  it('closes the session when getPrompt rejects', async () => {
    mocks.getPrompt.mockRejectedValue(new Error('transport closed'));
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await expect(provider(makeContext({}))).rejects.toThrow('transport closed');

    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(mocks.session);
  });

  it('closes the session when the prompt result has no messages', async () => {
    mocks.getPrompt.mockResolvedValue({messages: []});
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await expect(provider(makeContext({}))).rejects.toThrow(
      "Failed to load MCP prompt 'test_prompt'.",
    );

    expect(mocks.closeSession).toHaveBeenCalledExactlyOnceWith(mocks.session);
  });

  it('omits a declared argument that state does not hold', async () => {
    advertisePrompt(['present', 'absent']);
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await provider(makeContext({present: 'here'}));

    // toStrictEqual, not toEqual: toEqual ignores a key whose value is
    // undefined, which is the exact defect this test pins.
    expect(forwardedArgs()).toStrictEqual({present: 'here'});
  });

  it('serializes a non-string argument value as JSON', async () => {
    advertisePrompt(['profile']);
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await provider(makeContext({profile: {a: 1}}));

    expect(forwardedArgs()).toEqual({profile: '{"a":1}'});
  });

  it('returns an empty instruction when no message is text', async () => {
    mocks.getPrompt.mockResolvedValue({
      messages: [
        {content: {type: 'image', data: 'aQ==', mimeType: 'image/png'}},
        {
          content: {
            type: 'resource_link',
            uri: 'file:///doc.txt',
            name: 'doc',
          },
        },
      ],
    });
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await expect(provider(makeContext({}))).resolves.toBe('');
  });

  it('supplies an LlmAgent instruction that resolves through the server', async () => {
    const agent = new LlmAgent({
      name: 'support_agent',
      model: 'gemini-2.5-flash',
      instruction: mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME),
    });

    await expect(
      agent.canonicalInstruction(makeContext({})),
    ).resolves.toStrictEqual({
      instruction: 'instruction',
      requireStateInjection: false,
    });
  });

  it('builds one session manager per factory call, not per invocation', async () => {
    const provider = mcpInstructionProvider(CONNECTION_PARAMS, PROMPT_NAME);

    await provider(makeContext({}));
    await provider(makeContext({}));

    expect(mocks.MCPSessionManager).toHaveBeenCalledExactlyOnceWith(
      CONNECTION_PARAMS,
    );
    expect(mocks.createMcpSession).toHaveBeenCalledTimes(2);
  });
});
