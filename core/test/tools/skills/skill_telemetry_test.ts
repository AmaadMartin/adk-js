/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  Frontmatter,
  InvocationContext,
  LlmAgent,
  LoadSkillResourceTool,
  LoadSkillTool,
  PluginManager,
  Skill,
  SkillRegistry,
  SkillToolset,
} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
});

const skill: Skill = {
  frontmatter: {
    name: 'test-skill',
    description: 'A test skill',
  },
  instructions: 'Test instructions',
  resources: {references: {'doc.md': 'Doc content'}},
  uri: 'file:///skills/test-skill',
};

/** A registry whose fetch always fails, driving the REGISTRY_ERROR path. */
class FailingSkillRegistry implements SkillRegistry {
  async getSkill(name: string): Promise<Skill> {
    throw new Error(`registry is down for '${name}'`);
  }

  async searchSkills(_query: string): Promise<Frontmatter[]> {
    return [];
  }
}

function createContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app'}),
      agent: new LlmAgent({name: 'test_agent'}),
      pluginManager: new PluginManager(),
    }),
  });
}

/**
 * Runs a tool inside the span `callToolAsync` opens around every tool call,
 * and returns that span together with the tool result.
 */
async function runToolInSpan(
  tool: LoadSkillTool | LoadSkillResourceTool,
  args: Record<string, unknown>,
): Promise<{span: ReadableSpan; result: unknown}> {
  const spanName = `execute_tool ${tool.name}`;
  const result = await trace
    .getTracer('test')
    .startActiveSpan(spanName, async (span) => {
      try {
        return await tool.runAsync({args, toolContext: createContext()});
      } finally {
        span.end();
      }
    });

  const spans = exporter.getFinishedSpans().filter((s) => s.name === spanName);
  expect(spans.map((s) => s.name)).toEqual([spanName]);
  return {span: spans[0], result};
}

describe('LoadSkillTool telemetry', () => {
  it('records the loaded skill on the execute_tool span', async () => {
    const tool = new LoadSkillTool(new SkillToolset([skill]));

    const {span} = await runToolInSpan(tool, {name: 'test-skill'});

    expect(span.attributes).toMatchObject({
      'adk.experimental.skill.name': 'test-skill',
      'adk.experimental.skill.description': 'A test skill',
      'adk.experimental.skill.source.uri': 'file:///skills/test-skill',
    });
  });

  it('records the name alone when the skill is unknown', async () => {
    const tool = new LoadSkillTool(new SkillToolset([]));

    const {span, result} = await runToolInSpan(tool, {name: 'unknown-skill'});

    expect(result).toEqual({
      error: "Skill 'unknown-skill' not found.",
      error_code: 'SKILL_NOT_FOUND',
    });
    expect(span.attributes['adk.experimental.skill.name']).toBe(
      'unknown-skill',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
  });

  it('records the name alone when the registry throws', async () => {
    const toolset = new SkillToolset([], {
      registry: new FailingSkillRegistry(),
    });
    const tool = new LoadSkillTool(toolset);

    const {span, result} = await runToolInSpan(tool, {name: 'remote-skill'});

    expect(result).toMatchObject({error_code: 'REGISTRY_ERROR'});
    expect(span.attributes['adk.experimental.skill.name']).toBe('remote-skill');
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
  });

  it.each([
    ['absent', {}],
    ['empty', {name: ''}],
  ])('records nothing when the skill name argument is %s', async (_c, args) => {
    const tool = new LoadSkillTool(new SkillToolset([skill]));

    const {span, result} = await runToolInSpan(tool, args);

    expect(result).toEqual({
      error: 'Skill name is required.',
      error_code: 'MISSING_SKILL_NAME',
    });
    expect(span.attributes).not.toHaveProperty('adk.experimental.skill.name');
  });
});

describe('LoadSkillResourceTool telemetry', () => {
  it('records the resource path on the execute_tool span', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([skill]));

    const {span, result} = await runToolInSpan(tool, {
      skill_name: 'test-skill',
      path: 'references/doc.md',
    });

    expect(result).toMatchObject({content: 'Doc content'});
    expect(span.attributes).toMatchObject({
      'adk.experimental.skill.name': 'test-skill',
      'adk.experimental.skill.source.uri': 'file:///skills/test-skill',
      'adk.experimental.skill.resource.path': 'references/doc.md',
    });
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.additional_tools',
    );
  });

  it('records the resource path when the path is outside the allowed directories', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([skill]));

    const {span, result} = await runToolInSpan(tool, {
      skill_name: 'test-skill',
      path: 'secrets/keys.txt',
    });

    expect(result).toMatchObject({error_code: 'INVALID_RESOURCE_PATH'});
    expect(span.attributes['adk.experimental.skill.resource.path']).toBe(
      'secrets/keys.txt',
    );
  });

  it('records the name and resource path when the skill is unknown', async () => {
    const tool = new LoadSkillResourceTool(new SkillToolset([]));

    const {span, result} = await runToolInSpan(tool, {
      skill_name: 'unknown-skill',
      path: 'references/doc.md',
    });

    expect(result).toMatchObject({error_code: 'SKILL_NOT_FOUND'});
    expect(span.attributes).toMatchObject({
      'adk.experimental.skill.name': 'unknown-skill',
      'adk.experimental.skill.resource.path': 'references/doc.md',
    });
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.source.uri',
    );
  });

  it.each([
    ['absent', {skill_name: 'test-skill'}],
    ['empty', {skill_name: 'test-skill', path: ''}],
  ])(
    'records nothing when the resource path argument is %s',
    async (_case, args) => {
      const tool = new LoadSkillResourceTool(new SkillToolset([skill]));

      const {span, result} = await runToolInSpan(tool, args);

      expect(result).toEqual({
        error: 'Resource path is required.',
        error_code: 'MISSING_RESOURCE_PATH',
      });
      expect(span.attributes).not.toHaveProperty('adk.experimental.skill.name');
      expect(span.attributes).not.toHaveProperty(
        'adk.experimental.skill.resource.path',
      );
    },
  );
});
