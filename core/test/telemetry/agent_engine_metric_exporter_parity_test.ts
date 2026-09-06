/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python scenario suite for the request-driven metric reader, ported
 * test for test.
 *
 * Source: `tests/unittests/telemetry/test_agent_engine_metric_exporter.py` on
 * google/adk-python `main`. Each `it(...)` carries the Python function name in
 * a comment above it, so either suite can be found from the other by name.
 * The adk-js suite lives in `agent_engine_metric_exporter_test.ts`.
 *
 * The scenarios mirror the timelines in the module documentation: the baseline
 * drain, overlap batching, the four guidepost points, and the sub-floor skip.
 * Every scenario also gets the two blanket checks the reference applies to all
 * of them, in `assertInvariants`: consecutive collects are at least a floor
 * apart (I2), and every collect lands inside a request window (I1).
 *
 * The reference works in seconds, so its timestamps appear here scaled to
 * milliseconds. Its `_floor_seconds()` is a module-private function, so the
 * three floor tests observe the resolved floor through the reader's behaviour
 * instead of reading it.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  FLOOR_MS,
  Harness,
  PERIOD_MS,
} from './agent_engine_metric_exporter_test_utils.js';

const FLOOR_ENV =
  'GOOGLE_CLOUD_AGENT_ENGINE_METRICS_COLLECTION_INTERVAL_FLOOR_MS';

/** The default floor, from `MIN_EXPORT_INTERVAL_MS`. */
const DEFAULT_FLOOR_MS = 5000;

/** I1 and I2, the checks the reference applies to every scenario. */
function assertInvariants(h: Harness): void {
  const collects = h.collects;
  expect(collects.length).toBeGreaterThan(0);

  for (let i = 1; i < collects.length; i++) {
    expect(collects[i] - collects[i - 1]).toBeGreaterThanOrEqual(FLOOR_MS);
  }

  for (const collect of collects) {
    const served = h.windows.some(
      (w) => w.start <= collect && collect <= w.end,
    );
    expect(served).toBe(true);
  }
}

describe('RequestDrivenMetricReader ported from adk-python', () => {
  // test_scenario_invariants[baseline_drain]
  it('collects when an isolated request drains to zero', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(5000).end('r1');

      expect(h.collects).toEqual([5000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[overlap_batched]
  it('collects once for a burst of overlapping requests', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(1000).start('r2');
      await h.at(2000).start('r3');
      await h.at(3000).end('r1');
      await h.at(4000).end('r2');
      await h.at(5000).end('r3');

      expect(h.collects).toEqual([5000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[guidepost_consumed_by_drain]
  it('sweeps a guidepost inside a lone request with its drain', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      // Crosses the guidepost at 10000, but only drains here.
      await h.at(12000).end('r1');

      expect(h.collects).toEqual([12000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[guidepost_fires_at_start]
  it('fires a crossed guidepost at the next start under overlap', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(2000).start('r2');
      await h.at(4000).start('r3');
      // The guidepost at 10000 is crossed and there is overlap, so this start
      // collects.
      await h.at(11000).start('r4');
      await h.at(12000).end('r1');
      await h.at(13000).end('r2');
      await h.at(14000).end('r3');
      await h.at(16000).end('r4');

      expect(h.collects).toEqual([11000, 16000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[guidepost_muted]
  it('mutes a guidepost within the floor of the last collect', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(9000).end('r1');
      await h.at(9000).start('r2');
      // The guidepost is due, but 10000 - 9000 is under the floor.
      await h.at(10000).start('r3');
      await h.at(11000).end('r2');
      await h.at(12000).end('r3');

      expect(h.collects).toEqual([9000, 12000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[generate_content_backstop]
  it('collects a lone long request off its generate_content spans', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(5000).generateContent();
      await h.at(10000).generateContent();
      // 21000 into the busy period, past 1.5 periods, so this one collects.
      await h.at(21000).generateContent();
      await h.at(30000).generateContent();
      await h.at(37000).generateContent();
      await h.at(40000).end('r1');

      expect(h.collects).toEqual([21000, 37000, 40000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[short_first_request_not_preempted]
  it('lets a short first request drain rather than its span start', async () => {
    // Point 4 once treated "no collect yet" as overdue, so the first inference
    // span of the very first request collected before that request had
    // recorded anything. The collect stamped the floor and muted the drain
    // that carries the points, so nothing useful was exported.
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(2000).generateContent();
      await h.at(4000).end('r1');

      expect(h.collects).toEqual([4000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });

  // test_scenario_invariants[subfloor_skip]
  it('skips a sub-floor request draining right after a collect', async () => {
    const h = new Harness();
    try {
      await h.at(0).start('r1');
      await h.at(5000).end('r1');
      await h.at(6000).start('r2');
      // Under the floor after the collect at 5000, so its points wait.
      await h.at(6500).end('r2');
      await h.at(9000).start('r3');
      await h.at(9000).end('r3');

      expect(h.collects).toEqual([5000, 9000]);
      assertInvariants(h);
    } finally {
      await h.close();
    }
  });
});

describe('the collect floor resolved from the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Runs two drains 2000 ms apart and returns the collects.
   *
   * The gap sits between the 1500 ms override and the 5000 ms default, so the
   * second drain collects only when the override is in force.
   */
  async function collectsAcrossTwoDrains(): Promise<number[]> {
    const h = new Harness({periodMs: PERIOD_MS, floorMs: null});
    try {
      await h.at(0).start('r1');
      await h.at(1000).end('r1');
      await h.at(2000).start('r2');
      await h.at(3000).end('r2');
      return h.collects;
    } finally {
      await h.close();
    }
  }

  // test_floor_seconds_default
  it('falls back to the shared minimum export interval', async () => {
    vi.stubEnv(FLOOR_ENV, undefined);

    expect(await collectsAcrossTwoDrains()).toEqual([1000]);
  });

  // test_floor_seconds_env_override
  it('takes the floor from the environment variable', async () => {
    vi.stubEnv(FLOOR_ENV, '1500');

    expect(await collectsAcrossTwoDrains()).toEqual([1000, 3000]);
  });

  // test_floor_seconds_invalid_falls_back
  it('falls back when the environment variable is not a number', async () => {
    vi.stubEnv(FLOOR_ENV, 'not-a-number');

    expect(await collectsAcrossTwoDrains()).toEqual([1000]);
  });
});
