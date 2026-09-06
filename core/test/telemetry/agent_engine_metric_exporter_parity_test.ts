/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scenario tests ported from adk-python
 * `tests/unittests/telemetry/test_agent_engine_metric_exporter.py` @ main
 * (a119dd77).
 *
 * Deterministic: no real time and no network. A fake clock is injected into the
 * reader, and collects run inline. The scenarios mirror the diagrams in the
 * module docstring: baseline drain, overlap batching, the four guidepost
 * points, and the sub-floor skip. Two blanket invariants are asserted over
 * every scenario:
 *
 * - I2, consecutive collects are at least FLOOR apart.
 * - I1, every collect lands inside some `[requestStart, requestEnd]` window.
 *
 * Every Python second becomes a millisecond value, so `0/5/9/12` become
 * `0/5000/9000/12000`.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {
  AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV,
  collectFloorMillis,
  MIN_EXPORT_INTERVAL_MS,
} from '../../src/telemetry/agent_engine_metric_exporter.js';
import {FLOOR_MS, Harness} from './agent_engine_metric_exporter_test_utils.js';

/** Asserts I1 and I2 over a driven harness. */
function expectScenarioInvariants(harness: Harness): void {
  const collects = harness.collects;
  expect(collects.length, 'scenario produced no collects').toBeGreaterThan(0);

  for (let i = 1; i < collects.length; i++) {
    expect(
      collects[i] - collects[i - 1],
      `floor violated: ${collects}`,
    ).toBeGreaterThanOrEqual(FLOOR_MS);
  }

  for (const collect of collects) {
    const inWindow = harness.windows.some(
      ([start, end]) => start <= collect && collect <= end,
    );
    expect(
      inWindow,
      `collect ${collect} outside all windows ${JSON.stringify(harness.windows)}`,
    ).toBe(true);
  }
}

describe('RequestDrivenMetricReader scenarios', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness.close();
  });

  it('test_scenario_invariants[baseline_drain]', async () => {
    // An isolated request collects when it drains to zero.
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(5000).end('r1');

    expect(harness.collects).toEqual([5000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[overlap_batched]', async () => {
    // A burst of overlapping requests produces a single collect.
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(1000).start('r2');
    await harness.at(2000).start('r3');
    await harness.at(3000).end('r1');
    await harness.at(4000).end('r2');
    await harness.at(5000).end('r3');

    expect(harness.collects).toEqual([5000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[guidepost_consumed_by_drain]', async () => {
    // A guidepost inside a lone request is swept by its drain.
    harness = new Harness();
    await harness.at(0).start('r1');
    // Crosses the guidepost at 10000, but only drains here.
    await harness.at(12000).end('r1');

    expect(harness.collects).toEqual([12000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[guidepost_fires_at_start]', async () => {
    // Under continuous overlap, a guidepost fires at the next start.
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(2000).start('r2');
    await harness.at(4000).start('r3');
    // Guidepost (10000) crossed and requests overlap, so collect at the start.
    await harness.at(11000).start('r4');
    await harness.at(12000).end('r1');
    await harness.at(13000).end('r2');
    await harness.at(14000).end('r3');
    await harness.at(16000).end('r4');

    expect(harness.collects).toEqual([11000, 16000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[guidepost_muted]', async () => {
    // A guidepost within FLOOR of the last collect is muted.
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(9000).end('r1');
    await harness.at(9000).start('r2');
    // Guidepost due, but 10000-9000 < FLOOR, so it is muted.
    await harness.at(10000).start('r3');
    await harness.at(11000).end('r2');
    await harness.at(12000).end('r3');

    expect(harness.collects).toEqual([9000, 12000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[generate_content_backstop]', async () => {
    // A lone long request collects off its inference spans.
    harness = new Harness();
    await harness.at(0).start('r1');
    // 5000 into the busy period, under 1.5*PERIOD, so no collect.
    await harness.at(5000).generateContent();
    // 10000 into the busy period, still under 15000, so no collect.
    await harness.at(10000).generateContent();
    // 21000 into the busy period, at or over 15000, so collect.
    await harness.at(21000).generateContent();
    // 9000 since the last collect, so no collect.
    await harness.at(30000).generateContent();
    // 16000 since the last collect, so collect.
    await harness.at(37000).generateContent();
    await harness.at(40000).end('r1');

    expect(harness.collects).toEqual([21000, 37000, 40000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[short_first_request_not_preempted]', async () => {
    // Regression for the empty-metrics bug: point 4 once treated "no collect
    // yet" as overdue, so the first inference span of the first request fired a
    // collect before that request recorded anything. That collect stamped the
    // floor and muted the drain that carries the points. The collect must land
    // at the drain (4000), not at the generation (2000).
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(2000).generateContent();
    await harness.at(4000).end('r1');

    expect(harness.collects).toEqual([4000]);
    expectScenarioInvariants(harness);
  });

  it('test_scenario_invariants[subfloor_skip]', async () => {
    // A sub-floor request draining right after a collect is skipped.
    harness = new Harness();
    await harness.at(0).start('r1');
    await harness.at(5000).end('r1');
    await harness.at(6000).start('r2');
    // 6500-5000 < FLOOR, so this drain is skipped and its points ride the next.
    await harness.at(6500).end('r2');
    await harness.at(9000).start('r3');
    // 9000-5000 >= FLOOR, so this collect sweeps r2's points too.
    await harness.at(9000).end('r3');

    expect(harness.collects).toEqual([5000, 9000]);
    expectScenarioInvariants(harness);
  });
});

describe('collectFloorMillis', () => {
  afterEach(() => {
    delete process.env[AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV];
  });

  it('test_floor_seconds_default', () => {
    delete process.env[AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV];

    expect(collectFloorMillis()).toBe(MIN_EXPORT_INTERVAL_MS);
  });

  it('test_floor_seconds_env_override', () => {
    process.env[AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV] = '1500';

    expect(collectFloorMillis()).toBe(1500);
  });

  it('test_floor_seconds_invalid_falls_back', () => {
    process.env[AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS_ENV] =
      'not-a-number';

    expect(collectFloorMillis()).toBe(MIN_EXPORT_INTERVAL_MS);
  });
});
