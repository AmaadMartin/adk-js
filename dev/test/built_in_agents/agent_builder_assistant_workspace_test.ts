/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the tools the assistant actually carries against a real directory,
 * with no fakes below the tool boundary, so the wiring between the factory,
 * the tool layer and the filesystem is proven rather than assumed.
 */

import {BaseTool, LlmAgent} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';

import {createAgentBuilderAssistant} from '../../src/built_in_agents/agent_builder_assistant.js';

import {createTestContext, useTempDirs} from './test_helpers.js';

/**
 * Picks one of the assistant's own tools by its model-facing name.
 *
 * @param agent The assistant under test.
 * @param name The model-facing tool name.
 * @return The tool the assistant carries under that name.
 */
async function toolNamed(agent: LlmAgent, name: string): Promise<BaseTool> {
  const tool = (await agent.canonicalTools()).find(
    (candidate) => candidate.name === name,
  );
  if (tool === undefined) {
    expect.fail(`The assistant does not carry a ${name} tool.`);
  }
  return tool;
}

describe('the assistant working in a project directory', () => {
  const tempDir = useTempDirs();
  let agent: LlmAgent;

  beforeEach(() => {
    agent = createAgentBuilderAssistant({model: 'gemini-2.0-flash'});
  });

  it('scaffolds an agent project and reads it back', async () => {
    const root = await tempDir();
    const context = createTestContext({root_directory: root});
    const files = {
      'agent.ts': "export const rootAgent = new LlmAgent({name: 'dice'});\n",
      'tools/roll_die.ts':
        'export function rollDie(): number {\n  return 4;\n}\n',
    };

    const written = await (
      await toolNamed(agent, 'write_files')
    ).runAsync({args: {files}, toolContext: context});
    const read = await (
      await toolNamed(agent, 'read_files')
    ).runAsync({
      args: {file_paths: ['agent.ts', 'tools/roll_die.ts']},
      toolContext: context,
    });

    expect(written).toMatchObject({success: true, successful_writes: 2});
    expect(read).toMatchObject({success: true, successful_reads: 2});
    expect(await fs.readFile(path.join(root, 'agent.ts'), 'utf-8')).toBe(
      files['agent.ts'],
    );
    expect(
      await fs.readFile(path.join(root, 'tools/roll_die.ts'), 'utf-8'),
    ).toBe(files['tools/roll_die.ts']);
  });

  it('refuses to write outside the project root', async () => {
    // The escape target has to sit inside the disposable tree too, or the
    // assertion reads a file some earlier run left in the system temp dir.
    const parent = await tempDir();
    const root = path.join(parent, 'project');
    await fs.mkdir(root);
    const context = createTestContext({root_directory: root});

    const result = await (
      await toolNamed(agent, 'write_files')
    ).runAsync({
      args: {files: {'../escaped.ts': 'export {};\n'}},
      toolContext: context,
    });

    expect(result).toMatchObject({success: false, successful_writes: 0});
    await expect(fs.stat(path.join(parent, 'escaped.ts'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('holds a deletion until the user confirms it', async () => {
    const root = await tempDir();
    const target = path.join(root, 'obsolete.ts');
    await fs.writeFile(target, 'export {};\n');
    const context = createTestContext({root_directory: root}, 'call-1');

    const result = await (
      await toolNamed(agent, 'delete_files')
    ).runAsync({args: {file_paths: ['obsolete.ts']}, toolContext: context});

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(await fs.readFile(target, 'utf-8')).toBe('export {};\n');
  });
});
