/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  InvocationContext,
  LlmAgent,
  MCPRequireConfirmation,
  MCPToolset,
  PluginManager,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * End-to-end test with NO mocks: a real `MCPToolset` drives a real MCP server
 * (spawned as a stdio child process, see `mcp_delete_file_server.mjs`) whose
 * `delete_file` tool really deletes the file. The file on disk is therefore the
 * proof: it survives a gated call and disappears on an approved one.
 */

const SERVER_PATH = fileURLToPath(
  new URL('./mcp_delete_file_server.mjs', import.meta.url),
);

function makeToolContext(toolConfirmation?: ToolConfirmation): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: 'fc-1',
    toolConfirmation,
  });
}

describe('MCP requireConfirmation (e2e, real MCP server over stdio)', () => {
  let toolset: MCPToolset;
  let directory: string;
  let victim: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'adk-mcp-confirm-'));
    victim = join(directory, 'victim.txt');
    await writeFile(victim, 'delete me');
  });

  afterEach(async () => {
    await toolset?.close();
    await rm(directory, {recursive: true, force: true});
  });

  async function deleteFileTool(
    requireConfirmation: MCPRequireConfirmation,
  ): Promise<BaseTool> {
    toolset = new MCPToolset(
      {
        type: 'StdioConnectionParams',
        serverParams: {command: process.execPath, args: [SERVER_PATH]},
      },
      [],
      undefined,
      requireConfirmation,
    );
    const tools = await toolset.getTools();
    const tool = tools.find((candidate) => candidate.name === 'delete_file');
    if (!tool) {
      expect.fail('the MCP server did not advertise delete_file');
    }
    return tool;
  }

  it('holds the call for approval and leaves the file on disk', async () => {
    const tool = await deleteFileTool(true);
    const context = makeToolContext();

    const result = await tool.runAsync({
      args: {path: victim},
      toolContext: context,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(existsSync(victim)).toBe(true);
    expect(context.actions.requestedToolConfirmations['fc-1']).toBeDefined();
  });

  it('deletes the file once the user approves', async () => {
    const tool = await deleteFileTool(true);

    const result = await tool.runAsync({
      args: {path: victim},
      toolContext: makeToolContext(new ToolConfirmation({confirmed: true})),
    });

    expect(result).toMatchObject({
      content: [{type: 'text', text: `deleted ${victim}`}],
    });
    expect(existsSync(victim)).toBe(false);
  });

  it('leaves the file on disk once the user declines', async () => {
    const tool = await deleteFileTool(true);

    const result = await tool.runAsync({
      args: {path: victim},
      toolContext: makeToolContext(new ToolConfirmation({confirmed: false})),
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(existsSync(victim)).toBe(true);
  });

  it('deletes the file unguarded when confirmation is not required', async () => {
    const tool = await deleteFileTool(false);

    await tool.runAsync({args: {path: victim}, toolContext: makeToolContext()});

    expect(existsSync(victim)).toBe(false);
  });

  it('gates only the arguments the predicate selects', async () => {
    const spared = join(directory, 'spared.txt');
    await writeFile(spared, 'keep me');
    const tool = await deleteFileTool((args) => args['path'] === victim);

    await tool.runAsync({
      args: {path: spared},
      toolContext: makeToolContext(),
    });
    expect(existsSync(spared)).toBe(false);

    const gated = await tool.runAsync({
      args: {path: victim},
      toolContext: makeToolContext(),
    });
    expect(gated).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(existsSync(victim)).toBe(true);
  });
});
