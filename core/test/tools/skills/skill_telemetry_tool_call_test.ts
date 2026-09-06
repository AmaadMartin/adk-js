/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {handleFunctionCallsAsync} from '../../../src/agents/functions.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {createEvent} from '../../../src/events/event.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {loadAllSkillsInDir} from '../../../src/skills/loader.js';
import {SkillToolset} from '../../../src/tools/skill/skill_toolset.js';

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

const SKILL_MD = `---
name: pdf-processing
description: Extract text and tables from PDFs
metadata:
  adk_additional_tools:
    - read_file
    - write_file
---
Use pdftotext first.`;

/**
 * Drives the path a deployed agent takes: skills read off disk, tools built by
 * the toolset, and the `execute_tool` span opened by
 * `handleFunctionCallsAsync` rather than by the test.
 */
describe('skill telemetry through a real tool call', () => {
  let skillsDir: string;

  beforeEach(async () => {
    skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-skill-tel-'));
    const skillDir = path.join(skillsDir, 'pdf-processing');
    await fs.mkdir(path.join(skillDir, 'references'), {recursive: true});
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), SKILL_MD);
    await fs.writeFile(
      path.join(skillDir, 'references', 'tables.md'),
      'Table notes.',
    );
  });

  afterEach(async () => {
    await fs.rm(skillsDir, {recursive: true, force: true});
  });

  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ReadableSpan> {
    const toolset = new SkillToolset(await loadAllSkillsInDir(skillsDir));
    const invocationContext = new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app'}),
      agent: new LlmAgent({name: 'skill_agent'}),
      pluginManager: new PluginManager(),
    });
    const tool = (await toolset.getTools()).find((t) => t.name === name);
    if (!tool) expect.fail(`the toolset exposes no tool named '${name}'`);

    await handleFunctionCallsAsync({
      invocationContext,
      functionCallEvent: createEvent({
        invocationId: 'inv-1',
        author: 'skill-agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'fc-1', name, args}}],
        },
      }),
      toolsDict: {[name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });

    const spanName = `execute_tool ${name}`;
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === spanName);
    expect(spans.map((s) => s.name)).toEqual([spanName]);
    return spans[0];
  }

  it('reports a directory-loaded skill with its file uri', async () => {
    const span = await callTool('load_skill', {name: 'pdf-processing'});

    expect(span.attributes).toMatchObject({
      'gen_ai.tool.name': 'load_skill',
      'adk.experimental.skill.name': 'pdf-processing',
      'adk.experimental.skill.description': 'Extract text and tables from PDFs',
      'adk.experimental.skill.source.uri': pathToFileURL(
        path.join(skillsDir, 'pdf-processing'),
      ).href,
      'adk.experimental.skill.additional_tools': ['read_file', 'write_file'],
    });
  });

  it('reports a resource load with its path', async () => {
    const span = await callTool('load_skill_resource', {
      skill_name: 'pdf-processing',
      path: 'references/tables.md',
    });

    expect(span.attributes).toMatchObject({
      'gen_ai.tool.name': 'load_skill_resource',
      'adk.experimental.skill.name': 'pdf-processing',
      'adk.experimental.skill.source.uri': pathToFileURL(
        path.join(skillsDir, 'pdf-processing'),
      ).href,
      'adk.experimental.skill.resource.path': 'references/tables.md',
    });
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
  });
});
