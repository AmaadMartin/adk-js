/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a skill tool reports, and what reaches its `execute_tool` span.
 *
 * Ported from the skill section of
 * `tests/unittests/telemetry/test_instrumentation.py` in `google/adk-python`
 * at `b0180620f4c2f4f4467a89c37a30f75bf849700b`. The reference names are kept,
 * so the two suites can be compared by name. The ten reference tests that
 * assert OpenTelemetry metrics are not here: adk-js has no counterpart to
 * `telemetry/_metrics.py`, so there is no counter to read.
 */

import {SpanStatusCode} from '@opentelemetry/api';
import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {Skill} from '../../src/skills/skill.js';
import {
  confirmedNotHallucinated,
  maybeHallucinated,
} from '../../src/telemetry/_hallucination.js';
import {
  attachSkillTelemetry,
  createSkillToolScope,
  dispatchSkillTelemetry,
  SkillToolScope,
  trackSkillLoad,
  trackSkillResourceLoad,
  trackSkillScriptExecution,
  withSkillToolScope,
} from '../../src/telemetry/_skill_instrumentation.js';
import {tracer} from '../../src/telemetry/tracing.js';
import {logger} from '../../src/utils/logger.js';
import {
  experimentalAttributes,
  startInMemoryTracing,
} from './span_test_utils.js';

const tracing = startInMemoryTracing();

afterAll(async () => {
  await tracing.shutdown();
});

beforeEach(() => {
  tracing.reset();
  vi.restoreAllMocks();
  delete process.env.ADK_EXPERIMENTAL_TELEMETRY;
});

/**
 * Mirrors how `callToolAsync` wires a tool call: it opens the span, publishes
 * the scope, and stamps what the tool reported once the call finishes.
 */
async function recordToolExecution(
  toolName: string,
  body: () => Promise<void>,
): Promise<SkillToolScope> {
  const scope = createSkillToolScope();
  await tracer.startActiveSpan(`execute_tool ${toolName}`, async (span) => {
    try {
      await withSkillToolScope(scope, body);
    } finally {
      dispatchSkillTelemetry(span, scope);
      span.end();
    }
  });
  return scope;
}

function loadedSkill(): Skill {
  return {
    frontmatter: {name: 'sample_skill', description: 'A sample skill.'},
    instructions: 'Do the sample thing.',
    uri: 'file:/skills/sample',
  };
}

describe('skill telemetry reaches the enclosing tool execution', () => {
  it('test_record_skill_load_reaches_the_enclosing_tool_execution', async () => {
    const scope = await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(maybeHallucinated('sample_skill'));
      skillTelemetry.skill = loadedSkill();
      skillTelemetry.skillName = confirmedNotHallucinated('sample_skill');
    });

    expect(scope.skillTelemetry?.kind).toBe('load');
    expect(scope.skillTelemetry?.skillName.confirmed).toBe(true);
    expect(scope.skillTelemetry?.skill).toEqual(loadedSkill());
  });

  it('test_record_skill_resource_load_reaches_the_enclosing_tool_execution', async () => {
    const scope = await recordToolExecution('load_skill_resource', async () => {
      const skillTelemetry = trackSkillResourceLoad(
        maybeHallucinated('sample_skill'),
        maybeHallucinated('sample_path'),
      );
      skillTelemetry.skillName = confirmedNotHallucinated('sample_skill');
      skillTelemetry.resourcePath = confirmedNotHallucinated('sample_path');
    });

    const skillTelemetry = scope.skillTelemetry;
    if (skillTelemetry?.kind !== 'resourceLoad') {
      return expect.fail('expected a resource load record');
    }
    expect(skillTelemetry.skillName.confirmed).toBe(true);
    expect(skillTelemetry.resourcePath.confirmed).toBe(true);
  });

  it('test_record_skill_script_execution_reaches_the_enclosing_tool_execution', async () => {
    const scope = await recordToolExecution('run_skill_script', async () => {
      // The exit code is only known once the script has run, so the tool keeps
      // the object the tracker handed it and fills this in afterwards.
      trackSkillScriptExecution(
        maybeHallucinated('sample_skill'),
        maybeHallucinated('scripts/sample.py'),
      ).scriptExitCode = 0;
    });

    const skillTelemetry = scope.skillTelemetry;
    if (skillTelemetry?.kind !== 'scriptExecution') {
      return expect.fail('expected a script execution record');
    }
    expect(skillTelemetry.scriptExitCode).toBe(0);
    expect(skillTelemetry.scriptPath.maybeHallucinatedValue).toBe(
      'scripts/sample.py',
    );
  });

  it('test_record_skill_load_outside_tool_execution_is_a_noop', () => {
    const debug = vi.spyOn(logger, 'debug');

    const skillTelemetry = trackSkillLoad(maybeHallucinated('sample_skill'));

    expect(skillTelemetry.kind).toBe('load');
    expect(tracing.spans()).toHaveLength(0);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('No tool execution is being recorded'),
    );
  });

  it('test_record_skill_script_execution_outside_tool_execution_is_a_noop', () => {
    const skillTelemetry = trackSkillScriptExecution(
      maybeHallucinated('sample_skill'),
      maybeHallucinated('scripts/sample.py'),
    );

    expect(tracing.spans()).toHaveLength(0);
    // Unconfirmed until the tool resolves them: nothing has looked either up
    // yet. The tool still gets an object to record the exit code on.
    expect(skillTelemetry.skillName).toEqual(maybeHallucinated('sample_skill'));
    expect(skillTelemetry.scriptPath).toEqual(
      maybeHallucinated('scripts/sample.py'),
    );
  });

  it('replaces an already-attached record and warns about it', async () => {
    const warn = vi.spyOn(logger, 'warn');

    const scope = await recordToolExecution('load_skill', async () => {
      trackSkillLoad(maybeHallucinated('first_skill'));
      trackSkillLoad(maybeHallucinated('second_skill'));
    });

    expect(scope.skillTelemetry?.skillName.maybeHallucinatedValue).toBe(
      'second_skill',
    );
    expect(warn).toHaveBeenCalledWith(
      'Tool execution already has attached skill telemetry, overwriting.',
    );
  });
});

describe('skill loads on the execute_tool span', () => {
  it('test_skill_load_stamps_the_span_and_counts_the_load', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(
        confirmedNotHallucinated('sample_skill'),
      );
      skillTelemetry.skill = loadedSkill();
    });

    const attributes = tracing.onlySpan().attributes;
    expect(attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(attributes['adk.experimental.skill.description']).toBe(
      'A sample skill.',
    );
    expect(attributes['adk.experimental.skill.source.uri']).toBe(
      'file:/skills/sample',
    );
  });

  it('test_skill_load_that_resolved_nothing_is_counted_with_its_error', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill', async () => {
      trackSkillLoad(maybeHallucinated('sample_skill'));
    });

    // The span keeps what the model actually asked for.
    const attributes = tracing.onlySpan().attributes;
    expect(attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(attributes).not.toHaveProperty('adk.experimental.skill.description');
    expect(attributes).not.toHaveProperty('adk.experimental.skill.source.uri');
  });

  it('test_skill_load_is_silent_without_the_experimental_opt_in', async () => {
    await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(
        confirmedNotHallucinated('sample_skill'),
      );
      skillTelemetry.skill = loadedSkill();
    });

    expect(experimentalAttributes(tracing.onlySpan())).toEqual([]);
  });

  it('stamps the additional tools a skill frontmatter lists', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(
        confirmedNotHallucinated('sample_skill'),
      );
      const skill = loadedSkill();
      skill.frontmatter.metadata = {adk_additional_tools: ['a_tool', 'b_tool']};
      skillTelemetry.skill = skill;
    });

    expect(
      tracing.onlySpan().attributes['adk.experimental.skill.additional_tools'],
    ).toEqual(['a_tool', 'b_tool']);
  });

  it('omits the additional tools when the frontmatter value is not a string array', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(
        confirmedNotHallucinated('sample_skill'),
      );
      const skill = loadedSkill();
      skill.frontmatter.metadata = {adk_additional_tools: ['a_tool', 7]};
      skillTelemetry.skill = skill;
    });

    expect(tracing.onlySpan().attributes).not.toHaveProperty(
      'adk.experimental.skill.additional_tools',
    );
  });

  it('omits the source URI when the skill does not name one', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill', async () => {
      const skillTelemetry = trackSkillLoad(
        confirmedNotHallucinated('sample_skill'),
      );
      skillTelemetry.skill = {...loadedSkill(), uri: undefined};
    });

    const attributes = tracing.onlySpan().attributes;
    expect(attributes).not.toHaveProperty('adk.experimental.skill.source.uri');
    expect(attributes['adk.experimental.skill.description']).toBe(
      'A sample skill.',
    );
  });
});

describe('skill resource loads on the execute_tool span', () => {
  it('stamps the resource path and the source URI', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill_resource', async () => {
      const skillTelemetry = trackSkillResourceLoad(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('references/sample.md'),
      );
      skillTelemetry.skill = loadedSkill();
    });

    const attributes = tracing.onlySpan().attributes;
    expect(attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(attributes['adk.experimental.skill.resource.path']).toBe(
      'references/sample.md',
    );
    expect(attributes['adk.experimental.skill.source.uri']).toBe(
      'file:/skills/sample',
    );
  });

  it('keeps the raw path when nothing resolved the resource', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('load_skill_resource', async () => {
      trackSkillResourceLoad(
        maybeHallucinated('sample_skill'),
        maybeHallucinated('references/invented.md'),
      );
    });

    const attributes = tracing.onlySpan().attributes;
    expect(attributes['adk.experimental.skill.resource.path']).toBe(
      'references/invented.md',
    );
    expect(attributes).not.toHaveProperty('adk.experimental.skill.source.uri');
  });
});

describe('skill script executions on the execute_tool span', () => {
  it('test_skill_script_execution_stamps_the_span_and_counts_the_run', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('run_skill_script', async () => {
      const skillTelemetry = trackSkillScriptExecution(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('scripts/sample.py'),
      );
      skillTelemetry.skill = loadedSkill();
      skillTelemetry.scriptExitCode = 0;
    });

    const span = tracing.onlySpan();
    expect(span.attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(span.attributes['adk.experimental.skill.script.path']).toBe(
      'scripts/sample.py',
    );
    expect(span.attributes['adk.experimental.skill.script.exit_code']).toBe(0);
    expect(span.attributes['adk.experimental.skill.source.uri']).toBe(
      'file:/skills/sample',
    );
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).not.toHaveProperty('error.type');
  });

  it('test_skill_script_failure_fails_the_span_and_flags_the_count', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('run_skill_script', async () => {
      const skillTelemetry = trackSkillScriptExecution(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('scripts/sample.py'),
      );
      skillTelemetry.skill = loadedSkill();
      skillTelemetry.scriptExitCode = 3;
    });

    const span = tracing.onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
    expect(span.attributes['error.type']).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
    expect(span.attributes['adk.experimental.skill.script.exit_code']).toBe(3);
  });

  it('fails the span for a script killed by a signal', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('run_skill_script', async () => {
      trackSkillScriptExecution(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('scripts/sample.py'),
      ).scriptExitCode = -9;
    });

    const span = tracing.onlySpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('SKILL_SCRIPT_EXECUTION_ERROR');
    expect(span.attributes['adk.experimental.skill.script.exit_code']).toBe(-9);
  });

  it('test_skill_script_execution_that_never_ran_reports_no_exit_code', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('run_skill_script', async () => {
      trackSkillScriptExecution(
        maybeHallucinated('sample_skill'),
        maybeHallucinated('scripts/sample.py'),
      );
    });

    const span = tracing.onlySpan();
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.script.exit_code',
    );
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).not.toHaveProperty('error.type');
    // The span keeps what the model actually asked for.
    expect(span.attributes['adk.experimental.skill.name']).toBe('sample_skill');
    expect(span.attributes['adk.experimental.skill.script.path']).toBe(
      'scripts/sample.py',
    );
  });

  it('reports no exit code when the executor could not name one', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await recordToolExecution('run_skill_script', async () => {
      trackSkillScriptExecution(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('scripts/sample.py'),
      ).scriptExitCode = null;
    });

    const span = tracing.onlySpan();
    expect(span.attributes).not.toHaveProperty(
      'adk.experimental.skill.script.exit_code',
    );
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('test_skill_script_execution_is_silent_without_the_experimental_opt_in', async () => {
    await recordToolExecution('run_skill_script', async () => {
      trackSkillScriptExecution(
        confirmedNotHallucinated('sample_skill'),
        confirmedNotHallucinated('scripts/sample.py'),
      ).scriptExitCode = 3;
    });

    const span = tracing.onlySpan();
    expect(experimentalAttributes(span)).toEqual([]);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).not.toHaveProperty('error.type');
  });
});

describe('dispatchSkillTelemetry never fails a tool call', () => {
  it('stamps what the tool recorded before it threw', async () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';

    await expect(
      recordToolExecution('load_skill', async () => {
        trackSkillLoad(confirmedNotHallucinated('sample_skill'));
        throw new Error('the tool blew up');
      }),
    ).rejects.toThrow('the tool blew up');

    expect(tracing.onlySpan().attributes['adk.experimental.skill.name']).toBe(
      'sample_skill',
    );
  });

  it('logs and swallows a span that rejects an attribute write', () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';
    const warn = vi.spyOn(logger, 'warn');
    const scope = createSkillToolScope();
    scope.skillTelemetry = {
      kind: 'load',
      skillName: confirmedNotHallucinated('sample_skill'),
    };
    const span = tracer.startSpan('execute_tool load_skill');
    vi.spyOn(span, 'setAttributes').mockImplementation(() => {
      throw new Error('span is already ended');
    });

    dispatchSkillTelemetry(span, scope);

    expect(warn).toHaveBeenCalledWith(
      'Failed to record skill telemetry: span is already ended',
    );
  });

  it('writes nothing when no tool reported a skill', () => {
    process.env.ADK_EXPERIMENTAL_TELEMETRY = 'true';
    const span = tracer.startSpan('execute_tool some_tool');
    const setAttributes = vi.spyOn(span, 'setAttributes');

    dispatchSkillTelemetry(span, createSkillToolScope());

    expect(setAttributes).not.toHaveBeenCalled();
  });
});

describe('attachSkillTelemetry', () => {
  it('finds the scope a caller published and skips it once the scope closes', async () => {
    const debug = vi.spyOn(logger, 'debug');
    const scope = createSkillToolScope();

    await withSkillToolScope(scope, async () => {
      attachSkillTelemetry({
        kind: 'load',
        skillName: maybeHallucinated('inside_the_scope'),
      });
    });
    attachSkillTelemetry({
      kind: 'load',
      skillName: maybeHallucinated('outside_the_scope'),
    });

    expect(scope.skillTelemetry?.skillName.maybeHallucinatedValue).toBe(
      'inside_the_scope',
    );
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
