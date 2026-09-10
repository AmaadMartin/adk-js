/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/environment/test_local_environment.py`
 * (`TestExecuteTimeout`), google/adk-python `main`.
 */

import {LocalEnvironment} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * A background command that keeps appending to a file, started by a command
 * that then blocks. The background one inherits stdout/stderr, so it holds
 * those pipes open for as long as it runs -- which is what used to make a
 * timeout wait forever.
 */
const HEARTBEAT = 'while true; do echo x >> beat; sleep 0.05; done\n';

/** The command that starts the heartbeat and then blocks. */
const COMMAND = 'sh heartbeat.sh & sleep 60';

/**
 * Bounds a call that must not hang. Python wraps the awaited call in
 * `asyncio.wait_for(..., timeout=30)`; the per-test budget does that here.
 */
const OUTER_BOUND_MS = 30_000;

/** Poll budget for {@link waitForBeat}: 200 attempts, 50 ms apart. */
const BEAT_POLL_ATTEMPTS = 200;
const BEAT_POLL_INTERVAL_MS = 50;

/** How long {@link assertStopped} watches a stopped file for late writes. */
const STOPPED_OBSERVATION_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the background command is definitely running. */
async function waitForBeat(env: LocalEnvironment): Promise<string> {
  const beat = path.join(env.workingDir, 'beat');
  for (let attempt = 0; attempt < BEAT_POLL_ATTEMPTS; attempt++) {
    const size = await fs.stat(beat).then(
      (stats) => stats.size,
      () => 0,
    );
    if (size > 0) {
      return beat;
    }
    await sleep(BEAT_POLL_INTERVAL_MS);
  }
  return expect.fail('the background command never started');
}

/** Asserts the background command stopped writing, i.e. it is gone. */
async function assertStopped(beat: string): Promise<void> {
  const before = (await fs.stat(beat)).size;
  await sleep(STOPPED_OBSERVATION_MS);

  expect((await fs.stat(beat)).size).toBe(before);
}

// Mirrors `@pytest.mark.skipif(not hasattr(os, 'killpg'))`: Windows has no
// process group, so nothing can reap the descendants there.
describe.skipIf(os.platform() === 'win32')(
  'LocalEnvironment execute teardown',
  () => {
    let tmpRoot: string;
    let env: LocalEnvironment;

    beforeEach(async () => {
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-local-env-par-'));
      env = new LocalEnvironment({workingDir: path.join(tmpRoot, 'ws')});
      await env.initialize();
      await env.writeFile('heartbeat.sh', HEARTBEAT);
    });

    afterEach(async () => {
      await env.close();
      await fs.rm(tmpRoot, {recursive: true, force: true});
    });

    it(
      'test_timeout_returns_and_reaps_descendants',
      async () => {
        const result = await env.execute(COMMAND, 0.5);

        expect(result.timedOut).toBe(true);
        await assertStopped(path.join(env.workingDir, 'beat'));
      },
      OUTER_BOUND_MS,
    );

    it(
      'test_cancellation_reaps_descendants',
      async () => {
        // JavaScript has no ambient promise cancellation, so `task.cancel()`
        // becomes an AbortController the caller passes in.
        const controller = new AbortController();
        const running = env.execute(COMMAND, undefined, controller.signal);
        const beat = await waitForBeat(env);

        controller.abort();

        await expect(running).rejects.toThrow();
        await assertStopped(beat);
      },
      OUTER_BOUND_MS,
    );
  },
);
