/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  getFunctionCalls,
  getFunctionResponses,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  Logger,
  LogLevel,
  RunConfig,
  Runner,
  StreamingMode,
  toA2a,
} from '@google/adk';
import {Content} from '@google/genai';
import {trace, TracerProvider} from '@opentelemetry/api';
import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
import cors from 'cors';
import express, {Request, Response} from 'express';
import * as http from 'node:http';
import * as path from 'node:path';

import {AgentFileOptions, AgentLoader} from '../utils/agent_loader.js';
import {AdkLogger} from '../utils/logger.js';
import {
  ApiServerSpanExporter,
  hrTimeToNanoseconds,
  InMemoryExporter,
  setupTelemetry,
} from '../utils/telemetry_utils.js';
import {getAgentGraphAsDot} from './agent_graph.js';

interface ServerOptions {
  agentsDir?: string;
  host?: string;
  port?: number;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  artifactService?: BaseArtifactService;
  agentLoader?: AgentLoader;
  agentFileLoadOptions?: AgentFileOptions;
  serveDebugUI?: boolean;
  allowOrigins?: string;
  otelToCloud?: boolean;
  logger?: Logger;
  logLevel?: LogLevel;
  a2a?: boolean;
  reloadAgents?: boolean;
  registerProcessors?: (tracerProvider: TracerProvider) => void;
}

/** Default ids applied by the Reasoning Engine surface only. */
const DEFAULT_USER_ID = 'default-user';
const DEFAULT_SESSION_ID = 'default-session';

/**
 * A normalised run request. Missing ids become '' so each endpoint can apply
 * its own policy: a 400 on `/api/reasoning_engine`, a failed session lookup on
 * `/run` and `/run_sse`. `newMessage` stays optional, as in the Python server.
 */
interface AgentRunRequest {
  appName: string;
  userId: string;
  sessionId: string;
  newMessage?: Content;
  stateDelta?: Record<string, unknown>;
  streaming?: boolean;
}

/** Run fields as they arrive on the wire, before normalisation. */
type AgentRunRequestBody = Partial<AgentRunRequest>;

/**
 * Body accepted by `/api/reasoning_engine`, which nests the run fields in an
 * `input` envelope. Fields present in `input` win over top-level fields.
 */
interface ReasoningEngineRequestBody extends AgentRunRequestBody {
  input?: AgentRunRequestBody;
}

/** Normalises a plain run body. Used by `/run` and `/run_sse`. */
function parseAgentRunRequest(body: AgentRunRequestBody): AgentRunRequest {
  return {
    ...body,
    appName: body.appName ?? '',
    userId: body.userId ?? '',
    sessionId: body.sessionId ?? '',
  };
}

/**
 * Normalises a Reasoning Engine body: `input` fields win over top-level ones,
 * an empty string falls through to the top-level field, and a missing
 * `appName` still yields the 400.
 */
function parseReasoningEngineRequest(
  body: ReasoningEngineRequestBody,
): AgentRunRequest {
  const input = body.input ?? {};
  return parseAgentRunRequest({
    appName: input.appName || body.appName,
    userId: input.userId || body.userId || DEFAULT_USER_ID,
    sessionId: input.sessionId || body.sessionId || DEFAULT_SESSION_ID,
    newMessage: input.newMessage ?? body.newMessage,
    stateDelta: input.stateDelta ?? body.stateDelta,
  });
}

/**
 * Reads the Reasoning Engine body, falling back to the raw stream for clients
 * that send a content type `express.json()` does not recognise. A malformed or
 * empty raw body is logged and read as `{}`, which yields the 400.
 */
async function readReasoningEngineBody(
  req: Request,
  logger: Logger,
): Promise<ReasoningEngineRequestBody> {
  if (req.body && (Object.keys(req.body).length > 0 || !req.readable)) {
    logger.info(`Using already parsed body: ${JSON.stringify(req.body)}`);
    return req.body;
  }

  return new Promise((resolve) => {
    let rawBody = '';
    req.on('data', (chunk: Buffer) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      logger.info(`Received Reasoning Engine raw body: ${rawBody}`);
      let body: ReasoningEngineRequestBody = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch (e) {
          logger.error(`Failed to parse raw body as JSON: ${e}`);
        }
      }
      resolve(body);
    });
  });
}

export class AdkApiServer {
  private readonly host: string;
  private readonly port: number;

  get url(): string {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== 'string') {
        return `http://${this.host}:${address.port}`;
      }
    }
    return `http://${this.host}:${this.port}`;
  }

  readonly app: express.Application;
  private readonly agentLoader: AgentLoader;
  private readonly runnerCache: Record<string, Runner> = {};
  private readonly sessionService: BaseSessionService;
  private readonly memoryService: BaseMemoryService;
  private readonly artifactService: BaseArtifactService;
  private readonly serveDebugUI: boolean;
  private readonly allowOrigins?: string;
  private readonly otelToCloud: boolean;
  private readonly registerProcessors?: (
    tracerProvider: TracerProvider,
  ) => void;
  private server?: http.Server;
  private readonly traceDict: Record<string, Record<string, unknown>> = {};
  private readonly sessionTraceDict: Record<string, string[]> = {};
  private memoryExporter: InMemoryExporter;
  private readonly logger: Logger;
  private readonly a2a: boolean;

  constructor(options: ServerOptions) {
    this.host = options.host ?? 'localhost';
    this.port = options.port ?? 0; // 0 means random free port
    this.sessionService =
      options.sessionService ?? new InMemorySessionService();
    this.memoryService = options.memoryService ?? new InMemoryMemoryService();
    this.artifactService =
      options.artifactService ?? new InMemoryArtifactService();
    this.agentLoader =
      options.agentLoader ??
      new AgentLoader(
        options.agentsDir,
        options.agentFileLoadOptions,
        options.reloadAgents ?? false,
      );
    this.serveDebugUI = options.serveDebugUI ?? false;
    this.allowOrigins = options.allowOrigins;
    this.otelToCloud = options.otelToCloud ?? false;
    this.registerProcessors = options.registerProcessors;
    this.memoryExporter = new InMemoryExporter(this.sessionTraceDict);
    this.logger =
      options.logger ??
      new AdkLogger({
        label: 'ADK API Server',
        timestamp: true,
        colorize: {level: true},
        printFormat: (info) => {
          return `${info.level}: [${info.label}] ${info.timestamp} ${info.message}`;
        },
      });
    this.logger.setLogLevel(options.logLevel ?? LogLevel.INFO);
    this.a2a = options.a2a ?? false;
    this.app = express();
  }

  private async setupTelemetry(): Promise<void> {
    const internalExporters = [
      new SimpleSpanProcessor(new ApiServerSpanExporter(this.traceDict)),
      new SimpleSpanProcessor(this.memoryExporter),
    ];

    await setupTelemetry(this.otelToCloud, internalExporters);

    if (this.registerProcessors) {
      const tracerProvider = trace.getTracerProvider();
      this.registerProcessors(tracerProvider);
    }
  }

  private async initA2A() {
    const appNames = await this.agentLoader.listAgents();

    for (const appName of appNames) {
      const agentFile = await this.agentLoader.getAgentFile(appName);
      const loaded = await agentFile.load();
      const agent = isApp(loaded) ? loaded.rootAgent : loaded;
      const adkApp = isApp(loaded) ? loaded : undefined;
      const runner = await this.getRunner(adkApp ?? agent, appName);

      await toA2a(agent, {
        protocol: 'http',
        host: this.host,
        port: this.port,
        basePath: `/a2a/${appName}`,
        sessionService: this.sessionService,
        memoryService: this.memoryService,
        artifactService: this.artifactService,
        runner,
        app: this.app,
        // This is the local development API server. `toA2a` fails closed by
        // default, so explicitly opt out of authentication
        // here; a loud warning is logged at startup. Production A2A deployments
        // should instead pass an `authentication` UserBuilder.
        allowUnauthenticated: true,
      });
    }
  }

  private async init() {
    const app = this.app;
    await this.setupTelemetry();

    if (this.serveDebugUI) {
      app.get('/', (req: Request, res: Response) => {
        res.redirect('/dev-ui');
      });
      app.use(
        '/dev-ui',
        express.static(path.join(__dirname, '../../browser'), {
          setHeaders: (res: Response, path: string) => {
            if (path.endsWith('.js')) {
              res.setHeader('Content-Type', 'text/javascript');
            }
          },
        }),
      );
    } else {
      app.get('/health', (req: Request, res: Response) => {
        res.status(200).send('OK');
      });
      app.get('/', (req: Request, res: Response) => {
        res.status(200).send('OK');
      });
    }

    if (this.allowOrigins) {
      app.use(
        cors({
          origin: this.allowOrigins!,
        }),
      );
    }

    app.use(
      express.json({
        limit: '50mb',
      }),
    );

    app.use((req: Request, res: Response, next: express.NextFunction) => {
      this.logger.info(`${req.method} ${req.originalUrl}`);
      next();
    });

    app.get('/list-apps', async (req: Request, res: Response) => {
      try {
        const apps = await this.agentLoader.listAgents();
        res.json(apps);
      } catch (e: unknown) {
        const error = `Failed to list apps: ${e}`;

        res.status(500).json({error});
        this.logger.error(error);

        return;
      }
    });

    app.get('/debug/trace/:eventId', (req: Request, res: Response) => {
      try {
        const eventId = req.params['eventId'];
        const eventDict = this.traceDict[eventId];

        if (!eventDict) {
          return res.status(404).json({error: 'Trace not found'});
        }

        return res.json(eventDict);
      } catch (e) {
        const error = `Failed to get trace: ${e}`;

        res.status(500).json({error});
        this.logger.error(error);

        return;
      }
    });

    app.get(
      '/debug/trace/session/:sessionId',
      (req: Request, res: Response) => {
        try {
          const sessionId = req.params['sessionId'];
          const spans = this.memoryExporter.getFinishedSpans(sessionId);
          if (spans.length === 0) {
            return res.json([]);
          }
          const spanData = spans.map((span) => ({
            name: span.name,
            span_id: span.spanContext().spanId,
            trace_id: span.spanContext().traceId,
            start_time: hrTimeToNanoseconds(span.startTime),
            end_time: hrTimeToNanoseconds(span.endTime),
            attributes: {...span.attributes},
            parent_span_id: span.parentSpanContext?.spanId || null,
          }));

          return res.json(spanData);
        } catch (e) {
          const error = `Failed to get trace: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);

          return;
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/events/:eventId/graph',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const eventId = req.params['eventId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          const sessionEvents = session.events || [];
          const event = sessionEvents.find((e) => e.id === eventId);

          if (!event) {
            res.status(404).json({error: `Event not found: ${eventId}`});
            return;
          }

          const functionCalls = getFunctionCalls(event);
          const functionResponses = getFunctionResponses(event);
          await using agentFile = await this.agentLoader.getAgentFile(appName);
          const loaded = await agentFile.load();
          const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;

          if (functionCalls.length > 0) {
            const functionCallHighlights: Array<[string, string]> = [];
            for (const functionCall of functionCalls) {
              functionCallHighlights.push([event.author!, functionCall.name!]);
            }

            return res.send({
              dotSrc: await getAgentGraphAsDot(
                rootAgent,
                functionCallHighlights,
              ),
            });
          }

          if (functionResponses.length > 0) {
            const functionCallHighlights: Array<[string, string]> = [];

            for (const functionResponse of functionResponses) {
              functionCallHighlights.push([
                functionResponse.name!,
                event.author!,
              ]);
            }

            return res.send({
              dotSrc: await getAgentGraphAsDot(
                rootAgent!,
                functionCallHighlights,
              ),
            });
          }

          return res.send({
            dotSrc: await getAgentGraphAsDot(rootAgent!, [[event.author!, '']]),
          });
        } catch (e) {
          const error = `Failed to get agent graph: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
          return;
        }
      },
    );

    // ------------------------- Session related endpoints ---------------------
    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          res.json(session);
        } catch (e: unknown) {
          const error = `Failed to get session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];

          const sessions = await this.sessionService.listSessions({
            appName,
            userId,
          });

          res.json(sessions);
        } catch (e: unknown) {
          const error = `Failed to list sessions: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.post(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const state = req.body['state'] || {};

          const existingSession = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (existingSession) {
            res
              .status(400)
              .json({error: `Session already exists: ${sessionId}`});
            return;
          }

          const createdSession = await this.sessionService.createSession({
            appName,
            userId,
            state,
            sessionId,
          });

          res.json(createdSession);
        } catch (e: unknown) {
          const error = `Failed to create session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.post(
      '/apps/:appName/users/:userId/sessions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const state = req.body['state'] || {};

          const createdSession = await this.sessionService.createSession({
            appName,
            userId,
            state,
          });

          res.json(createdSession);
        } catch (e: unknown) {
          const error = `Failed to create session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.delete(
      '/apps/:appName/users/:userId/sessions/:sessionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const session = await this.sessionService.getSession({
            appName,
            userId,
            sessionId,
          });

          if (!session) {
            res.status(404).json({error: `Session not found: ${sessionId}`});
            return;
          }

          await this.sessionService.deleteSession({
            appName,
            userId,
            sessionId,
          });

          res.status(204).json({});
        } catch (e: unknown) {
          const error = `Failed to delete session: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    // ----------------------- Artifact related endpoints ----------------------
    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];

          const artifact = await this.artifactService.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
          });

          if (!artifact) {
            res
              .status(404)
              .json({error: `Artifact not found: ${artifactName}`});
            return;
          }

          res.json(artifact);
        } catch (e: unknown) {
          const error = `Failed to load artifact: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions/:versionId',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];
          const versionId = req.params['versionId'];

          const artifact = await this.artifactService.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
            version: parseInt(versionId, 10),
          });

          if (!artifact) {
            res
              .status(404)
              .json({error: `Artifact not found: ${artifactName}`});
            return;
          }

          res.json(artifact);
        } catch (e: unknown) {
          const error = `Failed to load artifact version: ${(e as Error).message}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];

          const artifactKeys = await this.artifactService.listArtifactKeys({
            appName,
            userId,
            sessionId,
          });

          res.json(artifactKeys);
        } catch (e: unknown) {
          const error = `Failed to list artifacts: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.get(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName/versions',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];

          const artifactVersions = await this.artifactService.listVersions({
            appName,
            userId,
            sessionId,
            filename: artifactName,
          });

          res.json(artifactVersions);
        } catch (e: unknown) {
          const error = `Failed to list artifact versions: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    app.delete(
      '/apps/:appName/users/:userId/sessions/:sessionId/artifacts/:artifactName',
      async (req: Request, res: Response) => {
        try {
          const appName = req.params['appName'];
          const userId = req.params['userId'];
          const sessionId = req.params['sessionId'];
          const artifactName = req.params['artifactName'];

          await this.artifactService.deleteArtifact({
            appName,
            userId,
            sessionId,
            filename: artifactName,
          });

          res.status(204).json({});
        } catch (e: unknown) {
          const error = `Failed to delete artifact: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      },
    );

    // --------------------- Eval Sets related endpoints -----------------------
    // TODO: Implement eval set related endpoints.
    app.post(
      '/apps/:appName/eval_sets/:evalSetId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get('/apps/:appName/eval_sets', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.post(
      '/apps/:appName/eval_sets/:evalSetId/add_session',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get(
      '/apps/:appName/eval_sets/:evalSetId/evals',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.put(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.delete(
      '/apps/:appName/eval_sets/:evalSetId/evals/:evalCaseId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.post(
      '/apps/:appName/eval_sets/:evalSetId/run_eval',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    // ----------------------- Eval Results related endpoints ------------------
    // TODO: Implement eval results related endpoints.
    app.get(
      '/apps/:appName/eval_results/:evalResultId',
      (req: Request, res: Response) => {
        return res.status(501).json({error: 'Not implemented'});
      },
    );

    app.get('/apps/:appName/eval_results', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    app.get('/apps/:appName/eval_metrics', (req: Request, res: Response) => {
      return res.status(501).json({error: 'Not implemented'});
    });

    // -------------------------- Run related endpoints ------------------------
    app.post('/run', async (req: Request, res: Response) => {
      const request = parseAgentRunRequest(req.body);
      // `/run` requires a pre-existing session; only `/api/reasoning_engine`
      // creates one on demand.
      const session = await this.sessionService.getSession({
        appName: request.appName,
        userId: request.userId,
        sessionId: request.sessionId,
      });

      if (!session) {
        res
          .status(404)
          .json({error: `Session not found: ${request.sessionId}`});
        return;
      }

      try {
        const events: Event[] = [];
        for await (const event of this.runAgentEvents(res, request)) {
          events.push(event);
        }

        res.json(events);
      } catch (e: unknown) {
        const error = `Failed to run agent: ${e}`;

        res.status(500).json({error});
        this.logger.error(error);
      }
    });

    app.post('/api/reasoning_engine', async (req: Request, res: Response) => {
      this.logger.info(
        `Received Reasoning Engine query headers: ${JSON.stringify(req.headers)}`,
      );

      const request = parseReasoningEngineRequest(
        await readReasoningEngineBody(req, this.logger),
      );
      if (!request.appName) {
        res.status(400).json({error: 'appName is required in input'});
        return;
      }

      try {
        // Unlike `/run` and `/run_sse`, the Reasoning Engine surface is called
        // by clients that do not manage sessions, so it creates one on demand
        // instead of returning 404.
        await this.sessionService.getOrCreateSession({
          appName: request.appName,
          userId: request.userId,
          sessionId: request.sessionId,
          state: {},
        });

        const events: Event[] = [];
        for await (const event of this.runAgentEvents(res, request)) {
          events.push(event);
        }

        res.json({output: events});
      } catch (e: unknown) {
        const error = `Failed to run agent via Reasoning Engine API: ${e}`;
        res.status(500).json({error});
        this.logger.error(error);
      }
    });

    app.post('/run_sse', async (req: Request, res: Response) => {
      const request = parseAgentRunRequest(req.body);
      // Validate the session before any header is flushed: once the SSE stream
      // is open the only way to report an error is an in-band `data:` frame.
      const session = await this.sessionService.getSession({
        appName: request.appName,
        userId: request.userId,
        sessionId: request.sessionId,
      });

      if (!session) {
        const error = `Session not found: ${request.sessionId}`;

        res.status(404).json({error});
        this.logger.error(error);
        return;
      }

      try {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        for await (const event of this.runAgentEvents(res, request, {
          streamingMode: request.streaming
            ? StreamingMode.SSE
            : StreamingMode.NONE,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }

        res.end();
      } catch (e: unknown) {
        if (res.headersSent) {
          // The stream is already open, so the error can only be reported
          // in-band.
          const error = (e as Error).message;
          this.logger.error(error);
          try {
            res.end(`data: ${JSON.stringify({error})}\n\n`);
          } catch {
            // Ignore errors from res.end when the response has already been sent.
          }
        } else {
          const error = `Failed to run agent: ${e}`;

          res.status(500).json({error});
          this.logger.error(error);
        }
      }
    });
  }

  async start(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, this.host, async () => {
        try {
          if (this.a2a) {
            await this.initA2A();
          }

          console.log(`
+-----------------------------------------------------------------------------+
| ADK API Server started                                                      |
|                                                                             |
| For local testing, access at ${this.url}.${''.padStart(39 - this.url.length)}       |
+-----------------------------------------------------------------------------+`);
          resolve();
        } catch (error) {
          this.logger.error('Error during AdkApiServer startup:', error);
          reject(error);
        }
      });

      this.server.on('error', (err: unknown) => {
        if ((err as {code: string}).code === 'EADDRINUSE') {
          const error = new Error();
          error.cause = err;
          error.message = `Port ${this.port} is already in use`;
          reject(error);
        } else {
          reject(err);
        }
      });
    });
  }

  stop(): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          reject(err);
          return;
        }

        console.log(`
+-----------------------------------------------------------------------------+
| ADK API Server stopped                                                      |
+-----------------------------------------------------------------------------+`);
        resolve();
      });
    });
  }

  private async getRunner(
    agentOrApp: BaseAgent | App,
    appName: string,
  ): Promise<Runner> {
    if (!(appName in this.runnerCache)) {
      const isAppInstance = isApp(agentOrApp);
      const agent = isAppInstance ? agentOrApp.rootAgent : agentOrApp;
      this.runnerCache[appName] = new Runner({
        app: isAppInstance ? agentOrApp : undefined,
        appName,
        agent,
        memoryService: this.memoryService,
        sessionService: this.sessionService,
        artifactService: this.artifactService,
      });
    }

    return this.runnerCache[appName];
  }

  /**
   * Runs an agent for a single HTTP request and yields its events.
   *
   * Aborts the run if the client disconnects while it is in flight, and
   * detaches the listener once the generator finishes so that the `close`
   * event of a completed response can no longer abort anything.
   *
   * The listener is on the response, not the request: since Node 16 a request
   * emits `close` as soon as its message is complete, which for a body small
   * enough for `express.json()` to buffer happens before the run even starts.
   * Only the response stays open for the lifetime of the run.
   */
  private async *runAgentEvents(
    res: Response,
    request: AgentRunRequest,
    runConfig?: RunConfig,
  ): AsyncGenerator<Event> {
    const abortController = new AbortController();
    const onClose = () => {
      this.logger.info(
        `HTTP connection closed. Aborting agent execution for session ` +
          `${request.sessionId}`,
      );
      abortController.abort();
    };
    res.on('close', onClose);

    try {
      await using agentFile = await this.agentLoader.getAgentFile(
        request.appName,
      );
      const loaded = await agentFile.load();
      const runner = await this.getRunner(loaded, request.appName);

      yield* runner.runAsync({
        userId: request.userId,
        sessionId: request.sessionId,
        // `Runner.runAsync` types `newMessage` as required but tolerates a
        // missing message at runtime (it only rejects a message with no
        // parts); the dev server forwards the request as sent, and the Python
        // dev server models `new_message` as optional too.
        newMessage: request.newMessage!,
        runConfig,
        stateDelta: request.stateDelta,
        abortSignal: abortController.signal,
      });
    } finally {
      res.off('close', onClose);
    }
  }
}
