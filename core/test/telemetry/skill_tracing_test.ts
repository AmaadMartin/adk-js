/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Skill} from '@google/adk';
import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  traceSkillLoad,
  traceSkillResourceLoad,
} from '../../src/telemetry/skill_tracing.js';

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

function onlySpan(name: string): ReadableSpan {
  const matches = exporter.getFinishedSpans().filter((s) => s.name === name);
  expect(matches.map((s) => s.name)).toEqual([name]);
  return matches[0];
}

/** Runs `body` inside a span shaped like the one `callToolAsync` opens. */
function withToolSpan(toolName: string, body: () => void): ReadableSpan {
  const spanName = `execute_tool ${toolName}`;
  trace.getTracer('test').startActiveSpan(spanName, (span) => {
    body();
    span.end();
  });
  return onlySpan(spanName);
}

const fullSkill: Skill = {
  frontmatter: {
    name: 'pdf-processing',
    description: 'Extract text and tables from PDFs',
    metadata: {adk_additional_tools: ['read_file', 'write_file']},
  },
  instructions: 'Use pdftotext.',
  uri: 'file:///skills/pdf-processing',
};

describe('traceSkillLoad', () => {
  it('records every attribute a fully described skill supplies', () => {
    const span = withToolSpan('load_skill', () => {
      traceSkillLoad({skillName: 'pdf-processing', skill: fullSkill});
    });

    expect(span.attributes).toMatchObject({
      'adk.experimental.skill.name': 'pdf-processing',
      'adk.experimental.skill.description': 'Extract text and tables from PDFs',
      'adk.experimental.skill.source.uri': 'file:///skills/pdf-processing',
      'adk.experimental.skill.additional_tools': ['read_file', 'write_file'],
    });
  });

  it('records only the name when the load produced no skill', () => {
    const span = withToolSpan('load_skill', () => {
      traceSkillLoad({skillName: 'missing-skill'});
    });

    expect(span.attributes['adk.experimental.skill.name']).toBe(
      'missing-skill',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.description',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.source.uri',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.additional_tools',
    );
  });

  it('omits the source uri when the skill does not carry one', () => {
    const skill: Skill = {
      frontmatter: {name: 'registry-skill', description: 'From a registry'},
      instructions: 'Do the thing.',
    };

    const span = withToolSpan('load_skill', () => {
      traceSkillLoad({skillName: 'registry-skill', skill});
    });

    expect(span.attributes['adk.experimental.skill.description']).toBe(
      'From a registry',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.source.uri',
    );
  });

  it('omits the additional tools when the skill declares none', () => {
    const skill: Skill = {
      frontmatter: {name: 'plain-skill', description: 'No extra tools'},
      instructions: 'Do the thing.',
      uri: 'file:///skills/plain-skill',
    };

    const span = withToolSpan('load_skill', () => {
      traceSkillLoad({skillName: 'plain-skill', skill});
    });

    expect(span.attributes['adk.experimental.skill.source.uri']).toBe(
      'file:///skills/plain-skill',
    );
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.additional_tools',
    );
  });

  it.each([
    ['a bare string', 'read_file'],
    ['a number array', [1, 2]],
    ['a mixed array', ['read_file', 7]],
  ])(
    'omits the additional tools when the metadata holds %s',
    (_shape, declared) => {
      const skill: Skill = {
        frontmatter: {
          name: 'odd-skill',
          description: 'Declares tools in a shape OTel cannot carry',
          metadata: {adk_additional_tools: declared},
        },
        instructions: 'Do the thing.',
      };

      const span = withToolSpan('load_skill', () => {
        traceSkillLoad({skillName: 'odd-skill', skill});
      });

      expect(span.attributes).not.toHaveProperty(
        'adk.experimental.skill.additional_tools',
      );
    },
  );

  it('does nothing when no span is active', () => {
    traceSkillLoad({skillName: 'pdf-processing', skill: fullSkill});

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

describe('traceSkillResourceLoad', () => {
  it('records the name, source uri and resource path, and nothing else', () => {
    const span = withToolSpan('load_skill_resource', () => {
      traceSkillResourceLoad({
        skillName: 'pdf-processing',
        resourcePath: 'references/tables.md',
        skill: fullSkill,
      });
    });

    expect(span.attributes).toEqual({
      'adk.experimental.skill.name': 'pdf-processing',
      'adk.experimental.skill.source.uri': 'file:///skills/pdf-processing',
      'adk.experimental.skill.resource.path': 'references/tables.md',
    });
  });

  it('records the resource path when the load produced no skill', () => {
    const span = withToolSpan('load_skill_resource', () => {
      traceSkillResourceLoad({
        skillName: 'missing-skill',
        resourcePath: 'references/tables.md',
      });
    });

    expect(span.attributes).toEqual({
      'adk.experimental.skill.name': 'missing-skill',
      'adk.experimental.skill.resource.path': 'references/tables.md',
    });
  });

  it('does nothing when no span is active', () => {
    traceSkillResourceLoad({
      skillName: 'pdf-processing',
      resourcePath: 'references/tables.md',
      skill: fullSkill,
    });

    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
