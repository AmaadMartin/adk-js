/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The hard invariants of the request-driven metric reader, over synthetic
 * workloads.
 *
 * Source: `tests/unittests/telemetry/test_agent_engine_metric_exporter_properties.py`
 * on google/adk-python `main`. The reference drives the workload knobs with
 * Hypothesis. adk-js has no property-testing library and this change does not
 * add one, so the knobs are driven by a fixed sweep of tuples, each replayed
 * under several seeds. The generators, the simulation, the invariant checks and
 * the timeline rendering are ported as written; only the source of the knob
 * values differs, which costs shrinking and gains a deterministic run.
 *
 * The invariants:
 *
 * - I1, export only while serving. Every collect lands inside some
 *   [request start, request end] window.
 * - I2, never collect more often than the floor. Consecutive collects are at
 *   least a floor apart.
 * - I4, no lost points on drain. Every request end is flushed by a collect at
 *   or before the moment the in-flight count returns to zero.
 *
 * I4 holds because no collect can land in the last floor of a busy period, so
 * its final drain is never floor-blocked. Every in-period collect is fired by
 * some request, at its start (point 2) or at a generation within it (point 4),
 * and the workload keeps both at least a floor plus a margin before that
 * request's own end. The generation constraint applies to every request, not
 * only the long ones: the overdue test measures from the last collect in the
 * current busy period, so under sustained load even a short request's
 * generation can fire a point-4 collect.
 *
 * I3 is deliberately not asserted. "An export carries at most about 200 points"
 * is a tunable, not a guarantee: under sustained overlap the reader honours
 * "collect once per period" and a single drain can still exceed the cap. The
 * remedy is a shorter export period, not a code change.
 */

import {describe, expect, it} from 'vitest';
import {Harness} from './agent_engine_metric_exporter_test_utils.js';

/** Guidepost grid, the OpenTelemetry default export interval. */
const PERIOD_MS = 60_000;

/** Hard floor on collect spacing (I2). */
const FLOOR_MS = 3_000;

/**
 * Margin above the floor for the shortest request.
 *
 * A collect is then always strictly, not exactly, more than a floor before its
 * request's end, and the margin absorbs float error at that boundary (see I4).
 */
const LEN_MARGIN_MS = 10;

const MIN_LEN_MS = FLOOR_MS + LEN_MARGIN_MS;
const MAX_LEN_MS = 10_000_000;

/** Float epsilon for the floor comparison, in milliseconds. */
const FLOOR_EPSILON_MS = 1e-6;

/** Event tie-break order at equal timestamps: start, then generation, then end. */
const ORDER = {start: 0, gen: 1, end: 2} as const;

type EventKind = keyof typeof ORDER;

/** The six workload knobs, plus the seed that draws a concrete workload. */
interface Params {
  /** Number of requests in the workload. */
  nRequests: number;
  /** Variance of the gap between arrivals. */
  arrivalVariance: number;
  /** Average request length, in milliseconds. */
  meanLengthMs: number;
  /** Variance of the request length. */
  lengthVariance: number;
  /** Average concurrency, which sets the arrival rate through Little's law. */
  meanConcurrency: number;
  /** Average number of generations per request. */
  meanGenerations: number;
  seed: number;
}

interface Request {
  rid: string;
  start: number;
  end: number;
  /** `generate_content` times within [start, end]. */
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

/** A collect that actually ran, and the hook kind that fired it. */
interface Collect {
  t: number;
  kind: EventKind;
}

interface Violation {
  invariant: 'I1' | 'I2' | 'I4';
  /** The offending time. */
  t: number;
  message: string;
}

interface Simulation {
  requests: Request[];
  windows: Window[];
  collects: Collect[];
}

/** A small seeded generator, so a failing case is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, standing in for the reference's `random.gauss`. */
function gauss(random: () => number, mean: number, sd: number): number {
  const u = 1 - random();
  const v = random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Turns the knobs into a concrete list of requests. */
function buildRequests(p: Params): Request[] {
  const random = mulberry32(p.seed);
  // Little's law: concurrency is arrival rate times service time, so the mean
  // gap between arrivals is the mean length over the mean concurrency. A
  // concurrency near zero means the requests barely overlap.
  const baseGap = p.meanLengthMs / Math.max(p.meanConcurrency, 1e-3);
  const arrivalSd = Math.sqrt(p.arrivalVariance);
  const lengthSd = Math.sqrt(p.lengthVariance);

  const requests: Request[] = [];
  let t = 0;
  for (let i = 0; i < p.nRequests; i++) {
    t += Math.max(0, gauss(random, baseGap, arrivalSd));
    const length = Math.min(
      MAX_LEN_MS,
      Math.max(MIN_LEN_MS, gauss(random, p.meanLengthMs, lengthSd)),
    );
    const nGen = Math.max(
      0,
      Math.round(
        gauss(random, p.meanGenerations, Math.sqrt(p.meanGenerations)),
      ),
    );
    // Place generations at least a floor plus a margin before the request's
    // own end, for the I4 guarantee.
    const genSpan = Math.max(0, length - MIN_LEN_MS);
    const gens: number[] = [];
    for (let k = 0; k < nGen; k++) {
      gens.push(t + ((k + 0.5) / nGen) * genSpan);
    }
    requests.push({rid: `r${i}`, start: t, end: t + length, gens});
  }
  return requests;
}

/** Replays a workload through the real reader and records every collect. */
async function simulate(p: Params): Promise<Simulation> {
  const requests = buildRequests(p);

  const events: TimelineEvent[] = [];
  for (const r of requests) {
    events.push({t: r.start, order: ORDER.start, rid: r.rid, kind: 'start'});
    for (const g of r.gens) {
      events.push({t: g, order: ORDER.gen, rid: r.rid, kind: 'gen'});
    }
    events.push({t: r.end, order: ORDER.end, rid: r.rid, kind: 'end'});
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order);

  const h = new Harness({periodMs: PERIOD_MS, floorMs: FLOOR_MS});
  const collects: Collect[] = [];
  try {
    for (const e of events) {
      h.at(e.t);
      const before = h.collects.length;
      if (e.kind === 'start') {
        await h.start(e.rid);
      } else if (e.kind === 'gen') {
        await h.generateContent();
      } else {
        await h.end(e.rid);
      }
      if (h.collects.length > before) {
        collects.push({t: e.t, kind: e.kind});
      }
    }
    return {requests, windows: [...h.windows], collects};
  } finally {
    await h.close();
  }
}

/** Merges request windows into maximal in-flight busy periods. */
function busyPeriods(windows: Window[]): Window[] {
  if (windows.length === 0) {
    return [];
  }
  const ordered = [...windows].sort((a, b) => a.start - b.start);
  const merged: Window[] = [ordered[0]];
  for (const w of ordered.slice(1)) {
    const last = merged[merged.length - 1];
    // Two windows that merely touch belong to the same busy period: at equal
    // timestamps the harness applies the start before the end, so the
    // in-flight count never dips to zero. Hence the inclusive comparison.
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

/** Returns every breach of I1, I2 or I4 in a simulation. */
function violations(sim: Simulation): Violation[] {
  const out: Violation[] = [];
  const times = sim.collects.map((c) => c.t);

  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap < FLOOR_MS - FLOOR_EPSILON_MS) {
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
  for (const r of sim.requests) {
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
          `the in-flight count hit 0 at ${period.end.toFixed(1)}ms`,
      });
    }
  }
  return out;
}

/** Renders one request as a row of the timeline. */
function renderRequest(
  r: Request,
  width: number,
  column: (x: number) => number,
): string {
  const row = new Array<string>(width).fill(' ');
  const a = column(r.start);
  const b = column(r.end);
  for (let c = Math.max(a, 0); c <= Math.min(b, width - 1); c++) {
    row[c] = '=';
  }
  if (a >= 0 && a < width) {
    row[a] = '[';
  }
  if (b >= 0 && b < width) {
    row[b] = ']';
  }
  for (const g of r.gens) {
    const gc = column(g);
    if (gc >= 0 && gc < width && '=[]'.includes(row[gc])) {
      row[gc] = 'o';
    }
  }
  return `${r.rid.padStart(7)}|${row.join('')}`;
}

/**
 * Renders the seconds around a violation as ASCII art.
 *
 * This is what makes a violation debuggable: the requests overlapping the
 * window are drawn as bars, and the collects row marks the offending collect.
 */
function renderTimeline(
  sim: Simulation,
  focusT: number,
  message: string,
  width = 100,
): string {
  // One column is one second of the workload.
  const windowStart = Math.max(0, focusT / 1000 - width / 2);
  const column = (x: number) => Math.round(x / 1000 - windowStart);
  const pad = ' '.repeat(8);

  const ticks = new Array<string>(width).fill(' ');
  const labels = new Array<string>(width).fill(' ');
  for (let c = 0; c <= width; c += 10) {
    if (c < width) {
      ticks[c] = '|';
    }
    const stamp = (windowStart + c).toFixed(0);
    for (let j = 0; j < stamp.length && c + j < width; j++) {
      labels[c + j] = stamp[j];
    }
  }

  const lines = [
    `VIOLATION [${message}]`,
    `window [${windowStart.toFixed(0)}s .. ${(windowStart + width).toFixed(0)}s]  1 col = 1s`,
    pad + ticks.join(''),
    pad + labels.join(''),
  ];

  const shown = sim.requests
    .filter(
      (r) =>
        r.end / 1000 >= windowStart && r.start / 1000 <= windowStart + width,
    )
    .sort((a, b) => a.start - b.start);
  for (const r of shown.slice(0, 30)) {
    lines.push(renderRequest(r, width, column));
  }
  if (shown.length > 30) {
    lines.push(
      `${'...'.padStart(7)}|(+${shown.length - 30} more requests in window)`,
    );
  }

  const collectRow = new Array<string>(width).fill('.');
  for (const c of sim.collects) {
    const ci = column(c.t);
    if (ci >= 0 && ci < width) {
      collectRow[ci] = 'C';
    }
  }
  const focus = column(focusT);
  if (focus >= 0 && focus < width) {
    collectRow[focus] = 'X';
  }
  lines.push(`${'collect'.padStart(7)}|${collectRow.join('')}`);
  lines.push(
    pad + 'legend: [====] request  o generation  C collect  X violation',
  );
  return lines.join('\n');
}

/** One knob tuple of the sweep. */
interface Knobs extends Omit<Params, 'seed'> {
  name: string;
}

const BASE: Omit<Params, 'seed' | 'nRequests'> = {
  arrivalVariance: 1_000_000,
  meanLengthMs: 20_000,
  lengthVariance: 25_000_000,
  meanConcurrency: 2,
  meanGenerations: 3,
};

/**
 * The sweep, covering the six dimensions the reference explores: request count,
 * overlap, sub-period and multi-period lengths, generation count, and the two
 * variances. The counts are capped so the whole suite stays under a second.
 */
const KNOBS: Knobs[] = [
  {...BASE, name: 'no requests', nRequests: 0},
  {...BASE, name: 'one short request', nRequests: 1, meanLengthMs: 5_000},
  {
    ...BASE,
    name: 'one multi-period request',
    nRequests: 1,
    meanLengthMs: 500_000,
  },
  {...BASE, name: 'two touching requests', nRequests: 2, meanConcurrency: 1},
  {...BASE, name: 'no overlap', nRequests: 60, meanConcurrency: 0},
  {...BASE, name: 'light overlap', nRequests: 120, meanConcurrency: 1},
  {...BASE, name: 'heavy overlap', nRequests: 120, meanConcurrency: 10},
  {
    ...BASE,
    name: 'sub-floor lengths under heavy overlap',
    nRequests: 200,
    meanLengthMs: 3_100,
    lengthVariance: 0,
    meanConcurrency: 10,
  },
  {
    ...BASE,
    name: 'sub-period lengths',
    nRequests: 150,
    meanLengthMs: 15_000,
    meanConcurrency: 5,
  },
  {
    ...BASE,
    name: 'multi-period lengths',
    nRequests: 60,
    meanLengthMs: 200_000,
    meanConcurrency: 3,
  },
  {
    ...BASE,
    name: 'multi-period lengths without overlap',
    nRequests: 30,
    meanLengthMs: 200_000,
    meanConcurrency: 0,
  },
  {
    ...BASE,
    name: 'no generations',
    nRequests: 120,
    meanGenerations: 0.001,
    meanConcurrency: 4,
  },
  {
    ...BASE,
    name: 'many generations',
    nRequests: 120,
    meanGenerations: 10,
    meanConcurrency: 4,
  },
  {
    ...BASE,
    name: 'many generations on long requests',
    nRequests: 40,
    meanLengthMs: 300_000,
    meanGenerations: 10,
    meanConcurrency: 1,
  },
  {
    ...BASE,
    name: 'bursty arrivals',
    nRequests: 150,
    arrivalVariance: 100_000_000,
    meanConcurrency: 3,
  },
  {
    ...BASE,
    name: 'wildly varying lengths',
    nRequests: 150,
    lengthVariance: 1_000_000_000,
    meanConcurrency: 3,
  },
  {
    ...BASE,
    name: 'zero variance metronome',
    nRequests: 150,
    arrivalVariance: 0,
    lengthVariance: 0,
    meanConcurrency: 6,
  },
  {
    ...BASE,
    name: 'long requests with rare generations',
    nRequests: 50,
    meanLengthMs: 400_000,
    meanGenerations: 0.5,
    meanConcurrency: 2,
  },
  {
    ...BASE,
    name: 'saturated short requests',
    nRequests: 200,
    meanLengthMs: 4_000,
    meanConcurrency: 8,
    meanGenerations: 1,
  },
  {
    ...BASE,
    name: 'near-serial long requests',
    nRequests: 40,
    meanLengthMs: 120_000,
    meanConcurrency: 0.5,
  },
];

const SEEDS = [1, 20260101, 4294967295];

describe('hard invariants over a seeded workload sweep', () => {
  for (const knobs of KNOBS) {
    for (const seed of SEEDS) {
      // test_hard_invariants
      it(`holds I1, I2 and I4 for ${knobs.name} (seed ${seed})`, async () => {
        const {name, ...rest} = knobs;
        const params: Params = {...rest, seed};
        const sim = await simulate(params);

        const found = violations(sim);
        if (found.length > 0) {
          const first = found[0];
          expect.fail(
            [
              `${name} (seed ${seed}) ${JSON.stringify(params)}`,
              renderTimeline(
                sim,
                first.t,
                `${first.invariant}: ${first.message}`,
              ),
              found.map((v) => `${v.invariant}: ${v.message}`).join('; '),
            ].join('\n'),
          );
        }
      });
    }
  }
});
