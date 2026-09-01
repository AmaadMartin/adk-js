/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AGENT_CARD_PATH, AgentCard} from '@a2a-js/sdk';
import {
  GcsArtifactService,
  InMemoryArtifactService,
  InMemorySessionService,
  LlmAgent,
  Logger,
  LogLevel,
  RunnableRoot,
} from '@google/adk';
import {Application} from 'express';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  createApiServer,
  createApiServerApp,
} from '../../src/server/api_server_factory.js';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';
import {version} from '../../src/version.js';

// The real server is kept -- the tests below serve real HTTP requests through
// it -- and only its constructor is wrapped, so the options the factory
// resolves can be read back.
vi.mock('../../src/server/adk_api_server.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/server/adk_api_server.js')>();
  return {
    ...actual,
    AdkApiServer: vi.fn(
      (options: ConstructorParameters<typeof actual.AdkApiServer>[0]) =>
        new actual.AdkApiServer(options),
    ),
  };
});

const AGENT_NAME = 'testAgent';
const APP_NAME = 'testApp';

/** Agent file serving an in-process agent, so no file is compiled. */
class StubAgentFile extends AgentFile {
  constructor(private readonly stubbedAgent: RunnableRoot) {
    super('unused');
  }

  override load(): Promise<RunnableRoot> {
    return Promise.resolve(this.stubbedAgent);
  }
}

/** Agent loader serving one in-process agent under {@link APP_NAME}. */
class StubAgentLoader extends AgentLoader {
  constructor(private readonly stubbedAgent: RunnableRoot) {
    super();
  }

  override listAgents(): Promise<string[]> {
    return Promise.resolve([APP_NAME]);
  }

  override getAgentFile(): Promise<AgentFile> {
    return Promise.resolve(new StubAgentFile(this.stubbedAgent));
  }
}

/** Agent loader that cannot list its agents. */
class FailingAgentLoader extends AgentLoader {
  override listAgents(): Promise<string[]> {
    return Promise.reject(new Error('the agents directory is unreadable'));
  }
}

/** Logger recording what the factory and the server report at its level. */
class RecordingLogger implements Logger {
  readonly messages: Array<{level: LogLevel; message: string}> = [];
  private logLevel = LogLevel.INFO;

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  log(level: LogLevel, ...messages: unknown[]): void {
    if (this.logLevel > level) {
      return;
    }
    this.messages.push({level, message: messages.join(' ')});
  }

  debug(...messages: unknown[]): void {
    this.log(LogLevel.DEBUG, ...messages);
  }

  info(...messages: unknown[]): void {
    this.log(LogLevel.INFO, ...messages);
  }

  warn(...messages: unknown[]): void {
    this.log(LogLevel.WARN, ...messages);
  }

  error(...messages: unknown[]): void {
    this.log(LogLevel.ERROR, ...messages);
  }
}

/** The options the factory handed the most recent `AdkApiServer`. */
function serverOptions(): ConstructorParameters<typeof AdkApiServer>[0] {
  const call = vi.mocked(AdkApiServer).mock.calls.at(-1);
  if (!call) {
    expect.fail('the factory never constructed an AdkApiServer');
  }
  return call[0];
}

/** Returns the text of the error *call* throws. */
function errorFrom(call: () => void): string {
  try {
    call();
  } catch (error: unknown) {
    return String(error);
  }
  expect.fail('the call was expected to throw, and did not');
}

async function getJson<T>(url: string): Promise<{status: number; body: T}> {
  const response = await fetch(url, {redirect: 'manual'});
  return {status: response.status, body: (await response.json()) as T};
}

describe('createApiServer', () => {
  let agentsDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-server-factory-'));
    // Both are read as defaults, so a developer's own environment must not
    // decide what these tests observe.
    vi.stubEnv('DATABASE_URL', undefined);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  describe('wiring', () => {
    it('applies the documented defaults', () => {
      createApiServer({agentsDir, web: false});

      const options = serverOptions();
      expect(options.port).toBe(8000);
      expect(options.host).toBe('localhost');
      expect(options.a2a).toBe(false);
      expect(options.reloadAgents).toBe(false);
      expect(options.otelToCloud).toBe(false);
      expect(options.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(options.artifactService).toBeInstanceOf(InMemoryArtifactService);
      // The factory names no memory service: adk-js has one, and the server
      // already defaults to it.
      expect(options.memoryService).toBeUndefined();
    });

    it('resolves a relative agentsDir against the working directory', () => {
      createApiServer({agentsDir: 'agents', web: false});

      expect(serverOptions().agentsDir).toBe(
        path.resolve(process.cwd(), 'agents'),
      );
    });

    it.each([
      [true, true],
      [false, false],
    ])('serves the dev UI for web: %s', (web, serveDebugUI) => {
      createApiServer({agentsDir, web});

      expect(serverOptions().serveDebugUI).toBe(serveDebugUI);
    });

    it('reads the session service URI', () => {
      createApiServer({agentsDir, web: false, sessionServiceUri: 'memory://'});

      expect(serverOptions().sessionService).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it('falls back to DATABASE_URL for the session service', () => {
      vi.stubEnv('DATABASE_URL', 'ftp://db.example');

      expect(() => createApiServer({agentsDir, web: false})).toThrow(
        /Unsupported session service URI/,
      );
    });

    it('prefers the session service URI over DATABASE_URL', () => {
      vi.stubEnv('DATABASE_URL', 'ftp://db.example');

      createApiServer({agentsDir, web: false, sessionServiceUri: 'memory://'});

      expect(serverOptions().sessionService).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it('reads the artifact service URI', () => {
      createApiServer({
        agentsDir,
        web: false,
        artifactServiceUri: 'gs://my-bucket',
      });

      expect(serverOptions().artifactService).toBeInstanceOf(
        GcsArtifactService,
      );
    });

    it('binds the configured host', () => {
      createApiServer({agentsDir, web: false, host: '0.0.0.0'});

      expect(serverOptions().host).toBe('0.0.0.0');
    });

    it.each([
      ['a single origin', 'https://console.example'],
      ['a list of origins', ['https://console.example', 'https://ops.example']],
    ])('forwards %s unchanged', (_name, allowOrigins) => {
      createApiServer({agentsDir, web: false, allowOrigins});

      expect(serverOptions().allowOrigins).toEqual(allowOrigins);
    });

    it('forwards every remaining option', () => {
      const agentLoader = new StubAgentLoader(new LlmAgent({name: AGENT_NAME}));
      const logger = new RecordingLogger();
      const agentFileLoadOptions = {compile: false, bundle: false};

      createApiServer({
        agentsDir,
        web: false,
        agentLoader,
        agentFileLoadOptions,
        allowedHosts: ['proxy.example'],
        a2a: true,
        a2aAuthToken: 'token',
        port: 9090,
        otelToCloud: true,
        reloadAgents: true,
        logger,
        logLevel: LogLevel.DEBUG,
      });

      const options = serverOptions();
      expect(options.agentLoader).toBe(agentLoader);
      expect(options.agentFileLoadOptions).toBe(agentFileLoadOptions);
      expect(options.allowedHosts).toEqual(['proxy.example']);
      expect(options.a2a).toBe(true);
      expect(options.a2aAuthToken).toBe('token');
      expect(options.port).toBe(9090);
      expect(options.otelToCloud).toBe(true);
      expect(options.reloadAgents).toBe(true);
      expect(options.logger).toBe(logger);
      expect(options.logLevel).toBe(LogLevel.DEBUG);
    });
  });

  describe('traceToCloud', () => {
    it('exports to cloud when GOOGLE_CLOUD_PROJECT is set', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'a-project');

      createApiServer({agentsDir, web: false, traceToCloud: true});

      expect(serverOptions().otelToCloud).toBe(true);
    });

    it('reads GOOGLE_CLOUD_PROJECT from the agents directory .env', async () => {
      await fs.writeFile(
        path.join(agentsDir, '.env'),
        'GOOGLE_CLOUD_PROJECT=a-project\n',
      );

      createApiServer({agentsDir, web: false, traceToCloud: true});

      expect(serverOptions().otelToCloud).toBe(true);
    });

    it('reports that tracing stays off when no project is configured', () => {
      const logger = new RecordingLogger();

      createApiServer({agentsDir, web: false, traceToCloud: true, logger});

      expect(serverOptions().otelToCloud).toBe(false);
      expect(logger.messages).toContainEqual({
        level: LogLevel.WARN,
        message:
          'GOOGLE_CLOUD_PROJECT environment variable is not set. Tracing ' +
          'will not be enabled.',
      });
    });

    it('holds that report back at a log level above warn', () => {
      const logger = new RecordingLogger();

      createApiServer({
        agentsDir,
        web: false,
        traceToCloud: true,
        logger,
        logLevel: LogLevel.ERROR,
      });

      expect(serverOptions().otelToCloud).toBe(false);
      expect(logger.messages).toEqual([]);
    });

    it('is ignored when otelToCloud is already on', () => {
      const logger = new RecordingLogger();

      createApiServer({
        agentsDir,
        web: false,
        traceToCloud: true,
        otelToCloud: true,
        logger,
      });

      expect(serverOptions().otelToCloud).toBe(true);
      expect(logger.messages).toEqual([]);
    });
  });

  describe('unsupported service URIs', () => {
    it('rejects a session service URI without leaking its password', () => {
      const failure = errorFrom(() =>
        createApiServer({
          agentsDir,
          web: false,
          sessionServiceUri: 'ftp://user:hunter2@db.example',
        }),
      );

      expect(failure).toContain('Unsupported session service URI');
      expect(failure).not.toContain('hunter2');
    });

    it('rejects an artifact service URI', () => {
      expect(() =>
        createApiServer({
          agentsDir,
          web: false,
          artifactServiceUri: 'ftp://nope',
        }),
      ).toThrow(/Unsupported artifact service URI/);
    });
  });
});

describe('a server built by createApiServer', () => {
  let agentsDir: string;
  let server: AdkApiServer | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-server-factory-'));
    vi.stubEnv('DATABASE_URL', undefined);
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    vi.unstubAllEnvs();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  it('answers the API endpoints with web disabled', async () => {
    server = createApiServer({agentsDir, web: false, port: 0});
    await server.start();

    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);

    const apps = await getJson<string[]>(`${server.url}/list-apps`);
    expect(apps.body).toEqual([]);

    const reported = await getJson<{version: string}>(`${server.url}/version`);
    expect(reported.body.version).toBe(version);
  });

  it('redirects to the dev UI with web enabled', async () => {
    server = createApiServer({agentsDir, web: true, port: 0});
    await server.start();

    const response = await fetch(`${server.url}/`, {redirect: 'manual'});

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dev-ui');
  });

  it('answers a listed origin with CORS headers', async () => {
    server = createApiServer({
      agentsDir,
      web: false,
      port: 0,
      allowOrigins: ['https://console.example', 'https://ops.example'],
    });
    await server.start();

    const response = await fetch(`${server.url}/list-apps`, {
      headers: {Origin: 'https://ops.example'},
    });

    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://ops.example',
    );
  });

  it('serves the A2A agent card when a2a is enabled', async () => {
    const agentLoader = new StubAgentLoader(new LlmAgent({name: AGENT_NAME}));
    server = createApiServer({
      agentsDir,
      web: false,
      port: 0,
      a2a: true,
      agentLoader,
    });
    await server.start();

    const card = await getJson<AgentCard>(
      `${server.url}/a2a/${APP_NAME}/${AGENT_CARD_PATH}`,
    );

    expect(card.status).toBe(200);
    expect(card.body.name).toBe(AGENT_NAME);
  });

  it('advertises the configured host on the A2A agent card', async () => {
    const agentLoader = new StubAgentLoader(new LlmAgent({name: AGENT_NAME}));
    server = createApiServer({
      agentsDir,
      web: false,
      port: 0,
      a2a: true,
      agentLoader,
      host: '127.0.0.1',
    });
    await server.start();

    const card = await getJson<AgentCard>(
      `${server.url}/a2a/${APP_NAME}/${AGENT_CARD_PATH}`,
    );

    // The card carries the host the caller has to serve the app on, which
    // the option's documentation and the guide both promise.
    expect(new URL(card.body.url).hostname).toBe('127.0.0.1');
  });

  it('mounts no A2A surface by default', async () => {
    const agentLoader = new StubAgentLoader(new LlmAgent({name: AGENT_NAME}));
    server = createApiServer({agentsDir, web: false, port: 0, agentLoader});
    await server.start();

    const response = await fetch(
      `${server.url}/a2a/${APP_NAME}/${AGENT_CARD_PATH}`,
    );

    expect(response.status).toBe(404);
  });

  it('registers its routes once however often the app is built', async () => {
    const logger = new RecordingLogger();
    const agentLoader = new StubAgentLoader(new LlmAgent({name: AGENT_NAME}));
    const listAgents = vi.spyOn(agentLoader, 'listAgents');
    server = createApiServer({
      agentsDir,
      web: false,
      port: 0,
      a2a: true,
      agentLoader,
      logger,
    });

    await server.buildApp();
    await server.buildApp();
    await server.start();

    // initA2A() lists the agents it mounts, and has run once.
    expect(listAgents).toHaveBeenCalledTimes(1);

    const apps = await getJson<string[]>(`${server.url}/list-apps`);
    expect(apps.body).toEqual([APP_NAME]);

    // A request no route answers runs every middleware, so the request
    // logger init() registers reports it once per registration.
    const missing = await fetch(`${server.url}/not-a-route`);
    expect(missing.status).toBe(404);
    expect(
      logger.messages.filter((entry) => entry.message === 'GET /not-a-route'),
    ).toHaveLength(1);
  });

  it('reports a failed build to every later caller', async () => {
    server = createApiServer({
      agentsDir,
      web: false,
      port: 0,
      a2a: true,
      agentLoader: new FailingAgentLoader(),
    });

    await expect(server.buildApp()).rejects.toThrow(
      'the agents directory is unreadable',
    );
    // A retry must not be handed the half-mounted app the first call left.
    await expect(server.buildApp()).rejects.toThrow(
      'the agents directory is unreadable',
    );
    await expect(server.start()).rejects.toThrow(
      'the agents directory is unreadable',
    );
  });
});

describe('createApiServerApp', () => {
  let agentsDir: string;
  let listener: http.Server | undefined;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-server-factory-'));
    vi.stubEnv('DATABASE_URL', undefined);
  });

  afterEach(async () => {
    listener?.close();
    listener = undefined;
    vi.unstubAllEnvs();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  /** Serves *app* on a loopback port of the operating system's choosing. */
  async function serve(app: Application): Promise<string> {
    const created = http.createServer(app);
    listener = created;
    await new Promise<void>((resolve) => created.listen(0, resolve));

    const address = created.address();
    if (!address || typeof address === 'string') {
      expect.fail('the listener reported no port');
    }
    return `http://localhost:${address.port}`;
  }

  it('returns an app a caller can serve without start()', async () => {
    const app = await createApiServerApp({agentsDir, web: false});

    const url = await serve(app);
    const reported = await getJson<{version: string}>(`${url}/version`);

    expect(reported.status).toBe(200);
    expect(reported.body.version).toBe(version);
  });

  it('mounts the A2A surface on the returned app', async () => {
    const app = await createApiServerApp({
      agentsDir,
      web: false,
      a2a: true,
      agentLoader: new StubAgentLoader(new LlmAgent({name: AGENT_NAME})),
    });

    const url = await serve(app);
    const card = await getJson<AgentCard>(
      `${url}/a2a/${APP_NAME}/${AGENT_CARD_PATH}`,
    );

    expect(card.status).toBe(200);
    expect(card.body.name).toBe(AGENT_NAME);
  });
});
