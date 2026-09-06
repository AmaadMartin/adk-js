/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property tests ported from adk-python
 * `tests/unittests/telemetry/test_agent_engine_metric_exporter_properties.py`
 * @ main (a119dd77).
 *
 * Instead of hand-written scenarios this file explores synthetic request
 * workloads and asserts the hard invariants of the request-driven reader:
 *
 * - I1, export only while serving: every collect lands inside some
 *   `[requestStart, requestEnd]` window.
 * - I2, never collect more often than the floor: consecutive collects are at
 *   least FLOOR apart.
 * - I4, no lost points on drain: every request end is flushed by a collect at
 *   or before the moment in-flight returns to zero.
 *
 * I4 holds because no collect can land in the last FLOOR of a busy period, so
 * its final drain is never floor-blocked. Every in-period collect is fired by
 * some request R, at R's start (point 2) or at a generation within R (point 4),
 * and the workload keeps both at least FLOOR plus a margin before R's own end.
 * The generation constraint applies to every request, not only long ones,
 * because "overdue" is measured from the last collect in the current busy
 * period.
 *
 * I3 is deliberately not asserted: "an export carries a bounded number of
 * points" is a tunable, not a hard guarantee.
 *
 * adk-python draws the six knobs with Hypothesis. adk-js must not gain a test
 * dependency, so a seeded mulberry32 draws them over 300 examples with seeds
 * 0 to 299, and a failure names the seed that reproduces it.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {FLOOR_MS, Harness} from './agent_engine_metric_exporter_test_utils.js';

/** Guidepost grid, matching the OpenTelemetry default export interval. */
const PERIOD_MS = 60_000;

/**
 * Margin above the floor for the shortest request.
 *
 * It keeps a collect strictly, not exactly, more than FLOOR before its
 * request's end, and absorbs float error at that boundary.
 */
const LEN_MARGIN_MS = 10;
const MIN_LEN_MS = FLOOR_MS + LEN_MARGIN_MS;
const MAX_LEN_MS = 10_000_000;
const MAX_REQUESTS = 1000;
const MAX_CONCURRENCY = 10;
const MAX_GENERATIONS = 10;
const MAX_ARRIVAL_VARIANCE_MS2 = 100e6;
const MAX_LENGTH_VARIANCE_MS2 = 1e12;

const EXAMPLES = 300;
/** Milliseconds. The 300 examples replay millions of hooks through the reader. */
const PROPERTY_TEST_TIMEOUT_MS = 300_000;

/** Event tie-break order at equal timestamps: start, then generation, then end. */
const ORDER = {start: 0, gen: 1, end: 2} as const;

type EventKind = keyof typeof ORDER;

interface Params {
  /** Target number of requests, in [0, 1000]. */
  nRequests: number;
  /** Variance of the gap between arrivals, in ms squared. */
  arrivalVariance: number;
  /** Average request length, in [MIN_LEN_MS, MAX_LEN_MS]. */
  meanLength: number;
  /** Variance of the request length, in ms squared. */
  lengthVariance: number;
  /** Average concurrency, in [0, 10]. */
  meanConcurrency: number;
  /** Average generations per request, in (0, 10]. */
  meanGenerations: number;
  /** Draws the concrete workload from the knobs above. */
  seed: number;
}

interface Req {
  rid: string;
  start: number;
  end: number;
  /** Inference span start times within `[start, end]`. */
  gens: number[];
}

interface TimelineEvent {
  t: number;
  order: number;
  rid: string;
  kind: EventKind;
}

interface Window {
  start: number;
  end: number;
}

interface Collect {
  t: number;
  kind: EventKind;
}

interface Violation {
  invariant: 'I1' | 'I2' | 'I4';
  /** The offending collect or request-end time. */
  t: number;
  message: string;
}

interface Sim {
  reqs: Req[];
  windows: Window[];
  collects: Collect[];
}

/** A seeded uniform generator over `[0, 1)`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws one normal sample by the Box-Muller transform. */
function gauss(rng: () => number, mu: number, sigma: number): number {
  const u = 1 - rng();
  const v = rng();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Draws a uniform sample from `[min, max)`. */
function uniform(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

function drawParams(rng: () => number): Params {
  return {
    nRequests: Math.floor(uniform(rng, 0, MAX_REQUESTS + 1)),
    arrivalVariance: uniform(rng, 0, MAX_ARRIVAL_VARIANCE_MS2),
    meanLength: uniform(rng, MIN_LEN_MS, MAX_LEN_MS),
    lengthVariance: uniform(rng, 0, MAX_LENGTH_VARIANCE_MS2),
    meanConcurrency: uniform(rng, 0, MAX_CONCURRENCY),
    // (0, 10]: rng() is in [0, 1), so 1 - rng() is in (0, 1].
    meanGenerations: MAX_GENERATIONS * (1 - rng()),
    seed: Math.floor(uniform(rng, 0, 2 ** 32)),
  };
}

/** Turns the six knobs into a concrete, seeded list of requests. */
function buildRequests(p: Params): Req[] {
  const rng = mulberry32(p.seed);
  // Little's law: concurrency = arrival rate * service time, so the mean gap
  // between arrivals is meanLength / meanConcurrency. A concurrency near zero
  // means the requests barely overlap.
  const baseGap = p.meanLength / Math.max(p.meanConcurrency, 1e-3);
  const arrivalSd = Math.sqrt(p.arrivalVariance);
  const lengthSd = Math.sqrt(p.lengthVariance);

  const reqs: Req[] = [];
  let t = 0;
  for (let i = 0; i < p.nRequests; i++) {
    t += Math.max(0, gauss(rng, baseGap, arrivalSd));
    const length = Math.min(
      MAX_LEN_MS,
      Math.max(MIN_LEN_MS, gauss(rng, p.meanLength, lengthSd)),
    );
    const nGen = Math.max(
      0,
      Math.round(gauss(rng, p.meanGenerations, Math.sqrt(p.meanGenerations))),
    );
    // Every generation lands at least FLOOR plus a margin before its request's
    // end, which is what makes I4 reachable.
    const genSpan = Math.max(0, length - MIN_LEN_MS);
    const gens: number[] = [];
    for (let k = 0; k < nGen; k++) {
      gens.push(t + ((k + 0.5) / nGen) * genSpan);
    }
    reqs.push({rid: `r${i}`, start: t, end: t + length, gens});
  }
  return reqs;
}

/** Replays the workload through the real reader and records every collect. */
async function simulate(p: Params): Promise<Sim> {
  const reqs = buildRequests(p);

  const events: TimelineEvent[] = [];
  for (const r of reqs) {
    events.push({t: r.start, order: ORDER.start, rid: r.rid, kind: 'start'});
    for (const g of r.gens) {
      events.push({t: g, order: ORDER.gen, rid: r.rid, kind: 'gen'});
    }
    events.push({t: r.end, order: ORDER.end, rid: r.rid, kind: 'end'});
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  const harness = new Harness(PERIOD_MS, FLOOR_MS);
  const collects: Collect[] = [];
  try {
    for (const e of events) {
      harness.at(e.t);
      const before = harness.exporter.times.length;
      if (e.kind === 'start') {
        await harness.start(e.rid);
      } else if (e.kind === 'gen') {
        await harness.generateContent();
      } else {
        await harness.end(e.rid);
      }
      if (harness.exporter.times.length > before) {
        collects.push({t: e.t, kind: e.kind});
      }
    }
    const windows = harness.windows.map(([start, end]) => ({start, end}));
    return {reqs, windows, collects};
  } finally {
    await harness.close();
  }
}

/**
 * Merges request windows into maximal in-flight busy periods.
 *
 * Two windows that merely touch belong to the same busy period: at equal
 * timestamps the harness applies the start before the end, so in-flight never
 * dips to zero. Hence the inclusive comparison.
 */
function busyPeriods(windows: Window[]): Window[] {
  if (windows.length === 0) {
    return [];
  }
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  const merged: Window[] = [ordered[0]];
  for (const w of ordered.slice(1)) {
    const last = merged[merged.length - 1];
    if (w.start <= last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, w.end),
      };
    } else {
      merged.push(w);
    }
  }
  return merged;
}

/** Returns every breach of I1, I2 and I4 in `sim`. */
function violations(sim: Sim): Violation[] {
  const out: Violation[] = [];
  const times = sim.collects.map((c) => c.t);

  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap < FLOOR_MS - 1e-9) {
      out.push({
        invariant: 'I2',
        t: times[i],
        message: `collects ${gap.toFixed(3)}ms apart, under the floor ${FLOOR_MS}ms`,
      });
    }
  }

  for (const t of times) {
    if (!sim.windows.some((w) => w.start <= t && t <= w.end)) {
      out.push({
        invariant: 'I1',
        t,
        message: `collect at t=${t.toFixed(1)}ms with no request in flight`,
      });
    }
  }

  const busy = busyPeriods(sim.windows);
  for (const r of sim.reqs) {
    const period = busy.find((w) => w.start <= r.end && r.end <= w.end);
    if (period === undefined) {
      out.push({
        invariant: 'I4',
        t: r.end,
        message: `${r.rid} ended at ${r.end.toFixed(1)}ms outside every busy period`,
      });
      continue;
    }
    if (!sim.collects.some((c) => r.end <= c.t && c.t <= period.end)) {
      out.push({
        invariant: 'I4',
        t: r.end,
        message:
          `${r.rid} ended at ${r.end.toFixed(1)}ms with no collect before ` +
          `in-flight hit 0 at ${period.end.toFixed(1)}ms`,
      });
    }
  }
  return out;
}

/**
 * Renders a window of the workload around `focusT` as ASCII art.
 *
 * One column is one second. Requests overlapping the window are drawn as bars
 * and the collects row marks the offending collect.
 */
function renderTimeline(
  sim: Sim,
  focusT: number,
  msg: string,
  columns = 100,
  msPerColumn = 1000,
): string {
  const width = columns * msPerColumn;
  const w0 = Math.max(0, focusT - width / 2);
  const col = (x: number) => Math.round((x - w0) / msPerColumn);

  const labelWidth = 7;
  const pad = ' '.repeat(labelWidth + 1);
  const lines = [
    `VIOLATION [${msg}]`,
    `window [${w0.toFixed(0)}ms .. ${(w0 + width).toFixed(0)}ms]  1 col = ${msPerColumn}ms`,
  ];

  const ticks = Array<string>(columns).fill(' ');
  const labels = Array<string>(columns).fill(' ');
  for (let c = 0; c <= columns; c += 10) {
    if (c < columns) {
      ticks[c] = '|';
    }
    const stamp = (w0 + c * msPerColumn).toFixed(0);
    for (let j = 0; j < stamp.length; j++) {
      if (c + j < columns) {
        labels[c + j] = stamp[j];
      }
    }
  }
  lines.push(pad + ticks.join(''), pad + labels.join(''));

  const shown = sim.reqs
    .filter((r) => r.end >= w0 && r.start <= w0 + width)
    .sort((a, b) => a.start - b.start);
  const clipped = shown.length - 30;
  for (const r of shown.slice(0, 30)) {
    const row = Array<string>(columns).fill(' ');
    const a = col(r.start);
    const b = col(r.end);
    for (let c = Math.max(a, 0); c <= Math.min(b, columns - 1); c++) {
      row[c] = '=';
    }
    if (a >= 0 && a < columns) {
      row[a] = '[';
    }
    if (b >= 0 && b < columns) {
      row[b] = ']';
    }
    for (const g of r.gens) {
      const gc = col(g);
      if (gc >= 0 && gc < columns && '=[]'.includes(row[gc])) {
        row[gc] = 'o';
      }
    }
    lines.push(`${r.rid.padStart(labelWidth)}|${row.join('')}`);
  }
  if (clipped > 0) {
    lines.push(`${'...'.padStart(labelWidth)}|(+${clipped} more requests)`);
  }

  const collectRow = Array<string>(columns).fill('.');
  for (const c of sim.collects) {
    const ci = col(c.t);
    if (ci >= 0 && ci < columns) {
      collectRow[ci] = 'C';
    }
  }
  const fc = col(focusT);
  if (fc >= 0 && fc < columns) {
    collectRow[fc] = 'X';
  }
  lines.push(`${'collect'.padStart(labelWidth)}|${collectRow.join('')}`);
  lines.push(
    pad + 'legend: [====] request  o generation  C collect  X violation',
  );
  return lines.join('\n');
}

describe('RequestDrivenMetricReader properties', () => {
  beforeEach(() => {
    delete process.env['OTEL_METRIC_EXPORT_INTERVAL'];
    delete process.env['OTEL_METRIC_EXPORT_TIMEOUT'];
  });

  it(
    'test_hard_invariants',
    async () => {
      for (let seed = 0; seed < EXAMPLES; seed++) {
        const params = drawParams(mulberry32(seed));
        const sim = await simulate(params);
        const found = violations(sim);
        if (found.length > 0) {
          const first = found[0];
          expect.fail(
            `seed=${seed} params=${JSON.stringify(params)}\n` +
              renderTimeline(
                sim,
                first.t,
                `${first.invariant}: ${first.message}`,
              ),
          );
        }
      }
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
