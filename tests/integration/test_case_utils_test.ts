/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseTestServer, parseBannerPort} from './test_case_utils.js';

/** The message the Go A2A backend prints, so the real handshake is pinned. */
const START_MESSAGE = 'A2A Server started on';
/** Port handed to the constructor, so a read-back is visible as a change. */
const CONSTRUCTOR_PORT = 19999;
/** Port every banner below advertises. */
const BANNER_PORT = 41234;
/**
 * Short on purpose: the start-up watchdog is not cleared, so it holds the
 * event loop open for this long after each test that starts a server.
 */
const START_TIMEOUT_MS = 3000;

/** Keeps a `node -e` child alive until the test kills it. */
const KEEP_ALIVE = 'setTimeout(() => {}, 60000);';

/** A `node -e` statement that writes one line to stdout. */
function writeLine(line: string): string {
  return `process.stdout.write(${JSON.stringify(`${line}\n`)});`;
}

/** `node -e` source that writes the given lines to stdout, then idles. */
function serverScript(...lines: string[]): string {
  return `${lines.map(writeLine).join('')}${KEEP_ALIVE}`;
}

/**
 * Minimal {@link BaseTestServer} driven by a hermetic `node -e` child, so the
 * banner read-back can be exercised without a real server.
 */
class FakeServer extends BaseTestServer {
  private child?: ChildProcessWithoutNullStreams;

  constructor(private readonly script: string) {
    super('localhost', CONSTRUCTOR_PORT);
  }

  async start(): Promise<void> {
    await this.startProcess({
      spawnProcess: () => {
        this.child = spawn(process.execPath, ['-e', this.script]);
        return this.child;
      },
      startMessage: START_MESSAGE,
      successLogMessage: 'fake server started',
      serverName: 'Fake',
      timeoutMs: START_TIMEOUT_MS,
    });
  }

  get childProcess(): ChildProcessWithoutNullStreams {
    if (!this.child) {
      expect.fail('the fake server was never spawned');
    }
    return this.child;
  }
}

/** Resolves once `needle` has been seen on the child's stdout. */
function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  needle: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let output = '';
    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes(needle)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

describe('BaseTestServer start-up banner', () => {
  const servers: FakeServer[] = [];

  function createServer(script: string): FakeServer {
    const server = new FakeServer(script);
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    // Stopped before the spies are restored, so the harness's own exit log
    // stays out of the test report.
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    vi.restoreAllMocks();
  });

  it.each(['http://localhost:41234', 'http://127.0.0.1:41234'])(
    'reads the port back from the banner %s',
    async (banner) => {
      const server = createServer(serverScript(`${START_MESSAGE} ${banner}`));

      await server.start();

      expect(server.port).toBe(BANNER_PORT);
      // The host is the one the constructor chose, for either spelling.
      expect(server.url).toBe(`http://localhost:${BANNER_PORT}`);
    },
  );

  it('keeps the constructor port when the banner host is not loopback', async () => {
    const server = createServer(
      serverScript(`${START_MESSAGE} http://example.com:8080`),
    );

    await server.start();

    expect(server.port).toBe(CONSTRUCTOR_PORT);
    expect(server.url).toBe(`http://localhost:${CONSTRUCTOR_PORT}`);
  });

  it('keeps the constructor port when the banner reports port 0', async () => {
    const server = createServer(
      serverScript(`${START_MESSAGE} http://127.0.0.1:0`),
    );

    await server.start();

    expect(server.port).toBe(CONSTRUCTOR_PORT);
    expect(server.url).toBe(`http://localhost:${CONSTRUCTOR_PORT}`);
  });

  it('ignores a loopback URL logged after the server reports ready', async () => {
    const server = createServer(
      `${writeLine(`${START_MESSAGE} http://127.0.0.1:41234`)}` +
        `setTimeout(() => {${writeLine('GET / from http://127.0.0.1:49999')}}, 50);` +
        KEEP_ALIVE,
    );

    await server.start();
    await waitForStdout(server.childProcess, '49999');

    expect(server.port).toBe(BANNER_PORT);
    expect(server.url).toBe(`http://localhost:${BANNER_PORT}`);
  });
});

describe('parseBannerPort', () => {
  it.each([
    'A2A Server started on http://localhost:41234',
    'A2A Server started on http://127.0.0.1:41234',
    'HTTP://LOCALHOST:41234',
  ])('reads the port out of %s', (banner) => {
    expect(parseBannerPort(banner)).toBe(BANNER_PORT);
  });

  it.each([
    ['no URL at all', 'A2A Server started'],
    ['a host that is not loopback', 'listening on http://example.com:8080'],
    // The dots in `127\.0\.0\.1` are escaped, so they match no other character.
    ['a host that only looks numeric', 'listening on http://127x0x0x1:41234'],
    ['a port the server has not bound yet', 'listening on http://127.0.0.1:0'],
  ])('returns undefined for %s', (_case, banner) => {
    expect(parseBannerPort(banner)).toBeUndefined();
  });
});
