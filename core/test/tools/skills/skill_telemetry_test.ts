/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill telemetry as an agent produces it.
 *
 * These drive the real tool path — `handleFunctionCallList` opens the
 * `execute_tool` span that `callToolAsync` stamps — against a real
 * `SkillToolset`. The script tests run a real Node process through
 * `UnsafeLocalCodeExecutor`, so the exit code on the span is the one the
 * operating system reported.
 */

import {
  BaseTool,
  functionsExportedForTestingOnly,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  loadSkillFromDir,
  PluginManager,
  Skill,
  SkillToolset,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import {FunctionCall} from '@google/genai';
import {SpanStatusCode} from '@opentelemetry/api';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {
  experimentalAttributes,
  startInMemoryTracing,
} from '../../telemetry/span_test_utils.js';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const tracing = startInMemoryTracing();
const sessionService = new InMemorySessionService();

let workDir: string;
let skillDir: string;
let sampleSkill: Skill;

/** Writes a real skill directory and loads it the way an application would. */
beforeAll(async () => {
  workDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adk_skill_telemetry_test_'),
  );
  skillDir = path.join(workDir, 'sample_skill');
  await fs.mkdir(path.join(skillDir, 'scripts'), {recursive: true});
  await fs.mkdir(path.join(skillDir, 'references'), {recursive: true});
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: sample_skill
description: A sample skill.
metadata:
  adk_additional_tools:
    - weather_tool
---
Do the sample thing.`,
  );
  await fs.writeFile(path.join(skillDir, 'references', 'notes.md'), 'Notes.');
  await fs.writeFile(
    path.join(skillDir, 'scripts', 'ok.js'),
    'process.exit(0);',
  );
  await fs.writeFile(
    path.join(skillDir, 'scripts', 'boom.js'),
    'process.exit(2);',
  );
  sampleSkill = await loadSkillFromDir(skillDir);
});

afterAll(async () => {
  await tracing.shutdown();
  await fs.rm(workDir, {recursive: true, force: true});
});

beforeEach(() => {
  tracing.reset();
  process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';
});

function skillToolset(): SkillToolset {
  return new SkillToolset([sampleSkill], {
    codeExecutor: new UnsafeLocalCodeExecutor(),
    scriptOutputDir: path.join(workDir, 'script_output'),
  });
}

/** Runs one tool call through the real tool path and returns its span. */
async function callSkillTool(
  toolset: SkillToolset,
  name: string,
  args: Record<string, unknown>,
): Promise<ReadableSpan> {
  const agent = new LlmAgent({name: 'sample_agent', model: 'test_model'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv_skill_telemetry',
    session: await sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    }),
    agent,
    pluginManager: new PluginManager(),
  });
  const toolsDict: Record<string, BaseTool> = Object.fromEntries(
    (await toolset.getTools()).map((tool) => [tool.name, tool]),
  );
  const functionCall: FunctionCall = {id: 'call_1', name, args};

  await handleFunctionCallList({
    invocationContext,
    functionCalls: [functionCall],
    toolsDict,
    beforeToolCallbacks: [],
    afterToolCallbacks: [],
  });

  const spans = tracing
    .spans()
    .filter((span) => span.name === `execute_tool ${name}`);
  expect(spans).toHaveLength(1);
  return spans[0];
}

describe('load_skill telemetry', () => {
  it('stamps the resolved skill onto the execute_tool span', async () => {
    const span = await callSkillTool(skillToolset(), 'load_skill', {
      name: 'sample_skill',
    });

    expect(span.attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(span.attributes['adk.experimental.skill.description']).toBe(
      'A sample skill.',
    );
    expect(span.attributes['adk.experimental.skill.source.uri']).toBe(
      pathToFileURL(skillDir).href,
    );
    expect(span.attributes['adk.experimental.skill.additional_tools']).toEqual([
      'weather_tool',
    ]);
  });

  it('stamps only the raw name when the skill does not resolve', async () => {
    const span = await callSkillTool(skillToolset(), 'load_skill', {
      name: 'invented_skill',
    });

    expect(span.attributes['adk.experimental.skill.name']).toBe(
      'invented_skill',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.source.uri',
    );
  });

  it('writes nothing without the experimental opt-in', async () => {
    delete process.env.ADK_EXPERIMENTAL_TELEMETRY;

    const span = await callSkillTool(skillToolset(), 'load_skill', {
      name: 'sample_skill',
    });

    expect(experimentalAttributes(span)).toEqual([]);
  });
});

describe('load_skill_resource telemetry', () => {
  it('stamps the resource path onto the execute_tool span', async () => {
    const span = await callSkillTool(skillToolset(), 'load_skill_resource', {
      skill_name: 'sample_skill',
      path: 'references/notes.md',
    });

    expect(span.attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(span.attributes['adk.experimental.skill.resource.path']).toBe(
      'references/notes.md',
    );
    expect(span.attributes['adk.experimental.skill.source.uri']).toBe(
      pathToFileURL(skillDir).href,
    );
  });

  it('keeps the raw path when the resource does not resolve', async () => {
    const span = await callSkillTool(skillToolset(), 'load_skill_resource', {
      skill_name: 'sample_skill',
      path: 'references/invented.md',
    });

    expect(span.attributes['adk.experimental.skill.resource.path']).toBe(
      'references/invented.md',
    );
  });
});

describe('run_skill_script telemetry', () => {
  it('records the exit code of a script that exited cleanly', async () => {
    const span = await callSkillTool(skillToolset(), 'run_skill_script', {
      skill_name: 'sample_skill',
      script_path: 'scripts/ok.js',
    });

    expect(span.attributes['adk.experimental.skill.script.path']).toBe(
      'scripts/ok.js',
    );
    expect(span.attributes['adk.experimental.skill.script.exit_code']).toBe(0);
    expect(span.attributes).not.toHaveProperty('error.type');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('fails the span for a script that exited non-zero', async () => {
    const span = await callSkillTool(skillToolset(), 'run_skill_script', {
      skill_name: 'sample_skill',
      script_path: 'scripts/boom.js',
    });

    expect(span.attributes['adk.experimental.skill.script.exit_code']).toBe(2);
    expect(span.attributes['error.type']).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
  });

  it('records no exit code when the script never ran', async () => {
    const span = await callSkillTool(skillToolset(), 'run_skill_script', {
      skill_name: 'sample_skill',
      script_path: 'scripts/invented.js',
    });

    expect(span.attributes['adk.experimental.skill.script.path']).toBe(
      'scripts/invented.js',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.script.exit_code',
    );
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});

describe('a tool that touches no skill', () => {
  it('leaves the execute_tool span unstamped', async () => {
    const span = await callSkillTool(skillToolset(), 'list_skills', {});

    expect(experimentalAttributes(span)).toEqual([]);
  });
});
