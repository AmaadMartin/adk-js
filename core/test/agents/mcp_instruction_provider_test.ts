/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvocationContext,
  mcpInstructionProvider,
  ReadonlyContext,
  type MCPConnectionParams,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {mockCreateSession, mockCloseSession} = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockCloseSession: vi.fn(),
}));

vi.mock('../../src/tools/mcp/mcp_session_manager.js', () => ({
  MCPSessionManager: vi.fn().mockImplementation(() => ({
    createSession: mockCreateSession,
    closeSession: mockCloseSession,
  })),
}));

const connectionParams: MCPConnectionParams = {
  type: 'StreamableHTTPConnectionParams',
  url: 'http://localhost:8080/mcp',
};
const promptName = 'test_prompt';

/**
 * Builds a minimal ReadonlyContext backed by a plain-object invocation context,
 * exposing only the session state that the provider reads.
 */
function makeContext(state: Record<string, unknown> = {}): ReadonlyContext {
  const fakeInvocationContext = {
    session: {id: 'sess-1', appName: 'app', userId: 'user-1', state},
  } as unknown as InvocationContext;
  return new ReadonlyContext(fakeInvocationContext);
}

/** A text-type prompt message, as returned by the MCP SDK `getPrompt`. */
function textMessage(text: string) {
  return {role: 'user', content: {type: 'text', text}};
}

describe('mcpInstructionProvider', () => {
  let session: {
    listPrompts: ReturnType<typeof vi.fn>;
    getPrompt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session = {listPrompts: vi.fn(), getPrompt: vi.fn()};
    mockCreateSession.mockResolvedValue(session);
    mockCloseSession.mockResolvedValue(undefined);
  });

  it('concatenates multi-message text when the prompt declares no arguments', async () => {
    session.listPrompts.mockResolvedValue({
      prompts: [{name: promptName, arguments: undefined}],
    });
    session.getPrompt.mockResolvedValue({
      messages: [
        textMessage('instruction part 1. '),
        textMessage('instruction part 2'),
      ],
    });

    const provider = mcpInstructionProvider(connectionParams, promptName);
    const result = await provider(makeContext());

    expect(result).toBe('instruction part 1. instruction part 2');
    expect(session.getPrompt).toHaveBeenCalledWith({
      name: promptName,
      arguments: {},
    });
    expect(mockCloseSession).toHaveBeenCalledWith(session);
  });

  it('forwards only declared args present in state, excluding others', async () => {
    // arg1: declared and present -> forwarded.
    // absent: declared but missing from state -> skipped.
    // arg2: present but not declared -> never forwarded.
    session.listPrompts.mockResolvedValue({
      prompts: [
        {name: promptName, arguments: [{name: 'arg1'}, {name: 'absent'}]},
      ],
    });
    session.getPrompt.mockResolvedValue({
      messages: [textMessage('instruction with arg1')],
    });

    const provider = mcpInstructionProvider(connectionParams, promptName);
    const result = await provider(
      makeContext({arg1: 'value1', arg2: 'value2'}),
    );

    expect(result).toBe('instruction with arg1');
    expect(session.getPrompt).toHaveBeenCalledWith({
      name: promptName,
      arguments: {arg1: 'value1'},
    });
  });

  it('collects no arguments when the prompt is absent from listPrompts', async () => {
    session.listPrompts.mockResolvedValue({prompts: []});
    session.getPrompt.mockResolvedValue({
      messages: [textMessage('instruction')],
    });

    const provider = mcpInstructionProvider(connectionParams, promptName);
    const result = await provider(makeContext({arg1: 'value1'}));

    expect(result).toBe('instruction');
    expect(session.getPrompt).toHaveBeenCalledWith({
      name: promptName,
      arguments: {},
    });
  });

  it('throws and still closes the session when getPrompt returns no messages', async () => {
    session.listPrompts.mockResolvedValue({prompts: []});
    session.getPrompt.mockResolvedValue({messages: []});

    const provider = mcpInstructionProvider(connectionParams, promptName);

    await expect(provider(makeContext())).rejects.toThrow(
      "Failed to load MCP prompt 'test_prompt'.",
    );
    expect(session.getPrompt).toHaveBeenCalledWith({
      name: promptName,
      arguments: {},
    });
    expect(mockCloseSession).toHaveBeenCalledWith(session);
  });

  it('ignores non-text content blocks when concatenating', async () => {
    session.listPrompts.mockResolvedValue({
      prompts: [{name: promptName, arguments: undefined}],
    });
    session.getPrompt.mockResolvedValue({
      messages: [
        textMessage('instruction part 1. '),
        {
          role: 'user',
          content: {type: 'image', data: 'ignored', mimeType: 'image/png'},
        },
        textMessage('instruction part 2'),
      ],
    });

    const provider = mcpInstructionProvider(connectionParams, promptName);
    const result = await provider(makeContext());

    expect(result).toBe('instruction part 1. instruction part 2');
  });
});
