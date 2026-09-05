/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LogLevel, setLogger, type Logger} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AdkWebServer} from '../../src/server/adk_web_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

/** Records every message the ADK logger is asked to write. */
class CapturingLogger implements Logger {
  readonly warnings: unknown[][] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  error(): void {}
  setLogLevel(_level: LogLevel): void {}

  warn(...args: unknown[]): void {
    this.warnings.push(args);
  }
}

const AGENTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-web-server-'));
const AGENT_LOADER = new AgentLoader(AGENTS_DIR);

afterAll(() => {
  fs.rmSync(AGENTS_DIR, {recursive: true, force: true});
});

/**
 * The deprecation warning is recorded once per class in a module-global
 * registry, so this block constructs `AdkWebServer` for the first time in this
 * file and must stay ahead of the other blocks.
 */
describe('AdkWebServer deprecation', () => {
  let capturing: CapturingLogger;
  let previousLogger: Logger;

  beforeEach(() => {
    previousLogger = getLogger();
    capturing = new CapturingLogger();
    setLogger(capturing);
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('warns once however many servers are constructed', () => {
    new AdkWebServer({agentLoader: AGENT_LOADER});
    new AdkWebServer({agentLoader: AGENT_LOADER});

    expect(capturing.warnings).toEqual([
      [
        'AdkWebServer is deprecated and has been renamed to AdkApiServer. Use' +
          ' AdkApiServer instead.',
      ],
    ]);
  });
});

describe('AdkWebServer alias', () => {
  it('is an AdkApiServer', () => {
    const server = new AdkWebServer({agentLoader: AGENT_LOADER});

    expect(server).toBeInstanceOf(AdkApiServer);
  });

  it('keeps its own class name past the decorator', () => {
    expect(AdkWebServer.name).toBe('AdkWebServer');
  });
});

describe('CORS middleware configuration', () => {
  const servers: AdkApiServer[] = [];

  async function startServer(allowOrigins?: string): Promise<AdkApiServer> {
    const server = new AdkApiServer({agentLoader: AGENT_LOADER, allowOrigins});
    await server.start();
    servers.push(server);
    return server;
  }

  /**
   * Reads the `Access-Control-Allow-Origin` the server answers `origin` with,
   * or `null` when it sends none. `/list-apps` is the cheapest route
   * registered after the CORS middleware.
   */
  async function allowedOriginFor(
    server: AdkApiServer,
    origin: string,
  ): Promise<string | null> {
    const response = await fetch(`${server.url}/list-apps`, {
      headers: {Origin: origin},
    });
    await response.text();
    return response.headers.get('access-control-allow-origin');
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  it('echoes a literal origin it was configured with', async () => {
    const server = await startServer('https://example.com');

    expect(await allowedOriginFor(server, 'https://example.com')).toBe(
      'https://example.com',
    );
  });

  it('refuses an origin that is not the configured literal', async () => {
    const server = await startServer('https://example.com');

    expect(await allowedOriginFor(server, 'https://other.com')).toBeNull();
  });

  it('echoes an origin matching a regex: entry', async () => {
    const server = await startServer('regex:https://.*\\.example\\.com');

    expect(await allowedOriginFor(server, 'https://a.example.com')).toBe(
      'https://a.example.com',
    );
  });

  it('refuses an origin that only contains a regex: match', async () => {
    const server = await startServer('regex:https://.*\\.example\\.com');

    expect(
      await allowedOriginFor(server, 'https://a.example.com.evil.com'),
    ).toBeNull();
  });

  it('answers every origin with a wildcard when configured with "*"', async () => {
    const server = await startServer('*');

    expect(await allowedOriginFor(server, 'https://anything.example')).toBe(
      '*',
    );
  });

  it('sends no CORS header when no origin is configured', async () => {
    const server = await startServer();

    expect(await allowedOriginFor(server, 'https://example.com')).toBeNull();
  });

  it('sends no CORS header when the configured origin list is empty', async () => {
    const server = await startServer('');

    expect(await allowedOriginFor(server, 'https://example.com')).toBeNull();
  });
});
