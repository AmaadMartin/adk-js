/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour that has no adk-python counterpart: the optional peer dependency,
 * the strict UTF-8 decoder, the baked-in tool name prefix and the client the
 * toolset shares between its tools.
 */

import {
  Context,
  createSession,
  GcsCapability,
  GcsToolset,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {FakeStorage, fakeGcs} = await vi.hoisted(
  async () => import('./fake_gcs_storage.js'),
);

vi.mock('@google-cloud/storage', () => ({Storage: FakeStorage}));

const BUCKET = 'test-bucket';

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    session: createSession({id: 'session-1', appName: 'app'}),
    pluginManager: new PluginManager(),
  });
}

/** Runs a tool of `toolset` by its exposed name, through the FunctionTool. */
async function runTool(
  toolset: GcsToolset,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tools = await toolset.getToolsWithPrefix();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    expect.fail(`no tool named ${name} in ${tools.map((t) => t.name)}`);
  }
  return tool.runAsync({
    args,
    toolContext: new Context({invocationContext: makeInvocationContext()}),
  });
}

describe('GcsToolset', () => {
  beforeEach(() => {
    fakeGcs.reset();
  });

  it('runs a read tool end to end through the FunctionTool', async () => {
    fakeGcs.bucket(BUCKET).put('report.txt', Buffer.from('hello'));

    const result = await runTool(new GcsToolset(), 'gcs_get_object_data', {
      bucket_name: BUCKET,
      object_name: 'report.txt',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'hello',
      encoding: 'text',
    });
  });

  it('serves its tools to an LlmAgent that lists it in tools', async () => {
    const agent = new LlmAgent({
      name: 'gcs_agent',
      model: 'gemini-2.5-flash',
      instruction: 'Answer questions about the objects in the user bucket.',
      tools: [new GcsToolset()],
    });

    const tools = await agent.canonicalTools(
      new ReadonlyContext(makeInvocationContext()),
    );

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'gcs_get_object_data',
      'gcs_get_object_metadata',
      'gcs_list_objects',
    ]);
  });

  it('exposes no write tool by default', async () => {
    const names = (await new GcsToolset().getToolsWithPrefix()).map(
      (t) => t.name,
    );

    expect(names).not.toContain('gcs_create_object');
    expect(names).not.toContain('gcs_delete_objects');
  });

  it('runs a write tool once read-write is asked for', async () => {
    const toolset = new GcsToolset({
      capability: GcsCapability.READ_WRITE,
    });

    const result = await runTool(toolset, 'gcs_create_object', {
      bucket_name: BUCKET,
      object_name: 'note.txt',
      data: 'written',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Object note.txt created successfully in bucket test-bucket.',
    });
    expect(
      fakeGcs.bucket(BUCKET).objects.get('note.txt')?.data.toString(),
    ).toBe('written');
  });

  it('runs the metadata tool end to end through the FunctionTool', async () => {
    fakeGcs.bucket(BUCKET).put('report.txt', Buffer.from('hello'));

    const result = await runTool(new GcsToolset(), 'gcs_get_object_metadata', {
      bucket_name: BUCKET,
      object_name: 'report.txt',
    });

    expect(result).toMatchObject({
      status: 'SUCCESS',
      results: {name: 'report.txt', bucket: BUCKET, size: '5'},
    });
  });

  it('runs the delete tool end to end through the FunctionTool', async () => {
    const bucket = fakeGcs.bucket(BUCKET);
    bucket.put('gone.txt', Buffer.from('x'));
    const toolset = new GcsToolset({
      capability: GcsCapability.READ_WRITE,
    });

    const result = await runTool(toolset, 'gcs_delete_objects', {
      bucket_name: BUCKET,
      object_names: ['gone.txt'],
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Objects gone.txt deleted successfully from bucket test-bucket.',
    });
    expect(bucket.objects.size).toBe(0);
  });

  it('drops the prefix when the caller asks for none', async () => {
    const toolset = new GcsToolset({prefix: ''});

    const names = (await toolset.getToolsWithPrefix())
      .map((t) => t.name)
      .sort();

    expect(names).toEqual([
      'get_object_data',
      'get_object_metadata',
      'list_objects',
    ]);
  });

  it('applies a custom prefix', async () => {
    const toolset = new GcsToolset({prefix: 'store'});

    const names = (await toolset.getToolsWithPrefix())
      .map((t) => t.name)
      .sort();

    expect(names).toEqual([
      'store_get_object_data',
      'store_get_object_metadata',
      'store_list_objects',
    ]);
  });

  it('matches a string toolFilter against the prefixed name', async () => {
    const unprefixedFilter = new GcsToolset({
      toolFilter: ['list_objects'],
    });
    const prefixedFilter = new GcsToolset({toolFilter: ['gcs_list_objects']});

    expect(await unprefixedFilter.getToolsWithPrefix()).toEqual([]);
    expect(
      (await prefixedFilter.getToolsWithPrefix()).map((t) => t.name),
    ).toEqual(['gcs_list_objects']);
  });

  it('applies a predicate toolFilter when a context is given', async () => {
    const toolset = new GcsToolset({
      toolFilter: (tool) => tool.name.endsWith('list_objects'),
    });
    const context = new ReadonlyContext(makeInvocationContext());

    expect(
      (await toolset.getToolsWithPrefix(context)).map((t) => t.name),
    ).toEqual(['gcs_list_objects']);
  });

  it('skips a predicate toolFilter when no context is given', async () => {
    const toolset = new GcsToolset({
      toolFilter: (tool) => tool.name.endsWith('list_objects'),
    });

    expect(await toolset.getToolsWithPrefix()).toHaveLength(3);
  });

  it('declares the model-facing parameters in snake_case', async () => {
    const tools = await new GcsToolset().getToolsWithPrefix();
    const listObjects = tools.find((t) => t.name === 'gcs_list_objects');
    if (!listObjects) {
      expect.fail('gcs_list_objects is missing');
    }

    const declaration = listObjects._getDeclaration();

    expect(declaration?.name).toBe('gcs_list_objects');
    expect(
      Object.keys(declaration?.parameters?.properties ?? {}).sort(),
    ).toEqual(['bucket_name', 'page_size', 'page_token', 'prefix']);
    expect(declaration?.parameters?.required).toEqual(['bucket_name']);
  });

  it('shares one client across every tool call', async () => {
    fakeGcs.bucket(BUCKET).put('a', Buffer.from('a'));
    const toolset = new GcsToolset();

    await runTool(toolset, 'gcs_list_objects', {bucket_name: BUCKET});
    await runTool(toolset, 'gcs_list_objects', {bucket_name: BUCKET});

    expect(fakeGcs.clients).toHaveLength(1);
  });

  it('builds a fresh client after close', async () => {
    const toolset = new GcsToolset();
    await runTool(toolset, 'gcs_list_objects', {bucket_name: BUCKET});

    await toolset.close();
    await runTool(toolset, 'gcs_list_objects', {bucket_name: BUCKET});

    expect(fakeGcs.clients).toHaveLength(2);
  });

  it('gives each toolset its own client', async () => {
    await runTool(new GcsToolset(), 'gcs_list_objects', {bucket_name: BUCKET});
    await runTool(new GcsToolset(), 'gcs_list_objects', {bucket_name: BUCKET});

    expect(fakeGcs.clients).toHaveLength(2);
  });

  it('passes the project id to the client', async () => {
    const toolset = new GcsToolset({project: 'my-project'});

    await runTool(toolset, 'gcs_list_objects', {bucket_name: BUCKET});

    expect(fakeGcs.clientOptions[0]).toMatchObject({projectId: 'my-project'});
  });
});

describe('get_object_data encoding', () => {
  beforeEach(() => {
    fakeGcs.reset();
  });

  it.each([
    {id: 'ascii', bytes: Buffer.from('plain text'), results: 'plain text'},
    {
      id: 'multi-byte utf-8',
      bytes: Buffer.from('héllo — 世界', 'utf8'),
      results: 'héllo — 世界',
    },
  ])('reads $id as text', async ({bytes, results}) => {
    fakeGcs.bucket(BUCKET).put('object', bytes);

    const result = await runTool(new GcsToolset(), 'gcs_get_object_data', {
      bucket_name: BUCKET,
      object_name: 'object',
    });

    expect(result).toEqual({status: 'SUCCESS', results, encoding: 'text'});
  });

  it.each([
    {id: 'a lone continuation byte', bytes: Buffer.from([0x80])},
    {id: 'a truncated multi-byte sequence', bytes: Buffer.from([0xe4, 0xb8])},
    {id: 'an overlong encoding', bytes: Buffer.from([0xc0, 0xaf])},
    {
      id: 'a PNG header',
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
  ])('reads $id as base64', async ({bytes}) => {
    fakeGcs.bucket(BUCKET).put('object', bytes);

    const result = await runTool(new GcsToolset(), 'gcs_get_object_data', {
      bucket_name: BUCKET,
      object_name: 'object',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: bytes.toString('base64'),
      encoding: 'base64',
    });
  });
});
