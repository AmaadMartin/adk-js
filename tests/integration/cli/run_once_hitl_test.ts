/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `adk run <agent> "<query>"` against a real agent file, with no mocks:
 * the file is compiled and loaded, the workflow pauses for a human, and a
 * second run answers that pause through the session both runs share.
 */

import {BaseSessionService, InMemorySessionService} from '@google/adk';
import {Console} from 'node:console';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runAgentOnce} from '../../../dev/src/cli/cli_run_once.js';

const AGENT_PATH = path.join(
  import.meta.dirname,
  'test_agents',
  'hitl_gate_agent.ts',
);

describe('adk run <agent> "<query>"', () => {
  let sessionService: BaseSessionService;
  let stdout: string[];
  let stderr: string[];
  let stdoutChunks: string[];
  let stderrChunks: string[];

  beforeEach(() => {
    sessionService = new InMemorySessionService();
    stdout = [];
    stderr = [];
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
    // The streams themselves, not the console: the copy of the ADK logger the
    // agent file loads writes to stdout directly, and a console stub would
    // hide it.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Runs one query against the shared session service. */
  const run = (options: Record<string, unknown>) =>
    runAgentOnce({
      agentPath: AGENT_PATH,
      inMemory: true,
      sessionService,
      ...options,
    });

  /** The session id the run reported on stderr. */
  const reportedSessionId = (): string => {
    const line = stderr.find((entry) => entry.startsWith('Session ID: '));
    if (!line) {
      expect.fail(`no session id in stderr: ${stderr.join('\n')}`);
    }
    return line.slice('Session ID: '.length);
  };

  it('exits 2 when the agent pauses, then 0 once the pause is answered', async () => {
    const pausedCode = await run({query: 'delete everything'});

    expect(pausedCode).toBe(2);
    expect(stderr.join('\n')).toContain('[PAUSED]');
    const sessionId = reportedSessionId();

    stdout = [];
    stderr = [];
    const resumedCode = await run({query: 'yes', sessionId});

    expect(resumedCode).toBe(0);
    expect(stderr.join('\n')).toContain(
      'Auto-resuming interrupt confirm with input: yes',
    );
    expect(stdout.join('\n')).toContain('answered:"yes"');
  }, 120000);

  it('writes only JSON lines on stdout under --jsonl', async () => {
    const code = await run({query: 'delete everything', jsonl: true});

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    expect(stdoutChunks.length).toBeGreaterThan(0);

    const records = stdoutChunks.map(
      (chunk) => JSON.parse(chunk) as Record<string, unknown>,
    );
    expect(
      records.some(
        (record) => (record['longRunningToolIds'] as string[])?.length > 0,
      ),
    ).toBe(true);
    expect(records.every((record) => 'session_id' in record)).toBe(true);
  }, 120000);

  it('moves the agent copy of the ADK logger off stdout under --jsonl', async () => {
    // The test runner swaps in a console of its own that captures output
    // before it reaches a stream. Put the real one back, so the agent's logger
    // writes where it writes in a terminal and this case can see it.
    vi.stubGlobal('console', new Console(process.stdout, process.stderr));

    // The fixture is a Workflow, a class marked experimental, so loading it
    // makes that logger warn. It warns from the agent's own copy of the
    // package, whose log level this process cannot set.
    await run({query: 'delete everything', jsonl: true});

    expect(stderrChunks.join('')).toContain('experimental');
    expect(stdoutChunks.length).toBeGreaterThan(0);
    for (const chunk of stdoutChunks) {
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  }, 120000);
});
