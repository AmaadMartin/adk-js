/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  GcsCapability,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {expect} from 'vitest';

export const STORAGE_READ_TOOL_NAMES = [
  'gcs_get_bucket',
  'gcs_get_object_data',
  'gcs_get_object_metadata',
  'gcs_list_objects',
];
export const STORAGE_WRITE_TOOL_NAMES = [
  'gcs_create_object',
  'gcs_delete_objects',
];
export const ADMIN_READ_TOOL_NAMES = ['gcs_list_buckets'];
export const ADMIN_WRITE_TOOL_NAMES = [
  'gcs_create_bucket',
  'gcs_update_bucket',
  'gcs_delete_bucket',
];

export const READ_WRITE = {capabilities: [GcsCapability.READ_WRITE]};
export const READ_ONLY = {capabilities: [GcsCapability.READ_ONLY]};
export const NO_CAPABILITIES = {capabilities: []};

/** Builds the tool context every `runAsync` call requires. */
export async function createToolContext(): Promise<Context> {
  const session = await new InMemorySessionService().createSession({
    appName: 'gcs-test-app',
    userId: 'gcs-test-user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'gcs-test-invocation',
      agent: new LlmAgent({name: 'gcs_test_agent'}),
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

/** Returns the named tool of a toolset, failing the test when it is absent. */
export async function getTool(
  toolset: BaseToolset,
  name: string,
): Promise<BaseTool> {
  const tool = (await toolset.getTools()).find((it) => it.name === name);
  if (!tool) {
    expect.fail(`Toolset does not expose a tool named ${name}.`);
  }
  return tool;
}

/** The sorted names of the tools a toolset exposes. */
export async function toolNames(
  toolset: BaseToolset,
  context?: ReadonlyContext,
): Promise<string[]> {
  return (await toolset.getTools(context)).map((tool) => tool.name).sort();
}

/**
 * Asserts that the tools declare exactly the given parameters, in order, with
 * the given ones required.
 */
export function expectParameters(
  tools: BaseTool[],
  expected: Record<string, {declared: string[]; required: string[]}>,
): void {
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    Object.keys(expected).sort(),
  );
  for (const tool of tools) {
    const parameters = tool._getDeclaration()?.parameters;
    expect(Object.keys(parameters?.properties ?? {})).toEqual(
      expected[tool.name].declared,
    );
    expect(parameters?.required ?? []).toEqual(expected[tool.name].required);
  }
}
