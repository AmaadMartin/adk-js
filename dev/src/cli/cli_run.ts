/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  getFunctionCalls,
  getPendingUserInputRequests,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  requiresUserInput,
  RunnableRoot,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {text} from 'node:stream/consumers';

import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {
  getAbsolutePath,
  loadFileData,
  saveToFile,
} from '../utils/file_utils.js';
import {
  parseTimeout,
  TimeoutError,
  withTimeout,
} from '../utils/timeout_utils.js';
import {isRecord, toMessage} from '../utils/value_utils.js';
import {printEvent, renderUserInputRequest} from './event_printer.js';

const REQUEST_CONFIRMATION = 'adk_request_confirmation';
const REQUEST_INPUT = 'adk_request_input';
const POSITIVE_RESPONSES = new Set(['y', 'yes', 'true', 'confirm']);

/** Exit code adk-python uses for a run that finished waiting on a human. */
const PAUSED_EXIT_CODE = 2;
const FAILURE_EXIT_CODE = 1;

/** Reads `--state`, reporting a parse failure the way adk-python does. */
function parseSessionState(
  stateStr: string | undefined,
): {ok: true; state?: Record<string, unknown>} | {ok: false} {
  if (!stateStr) {
    return {ok: true};
  }
  try {
    const parsed: unknown = JSON.parse(stateStr);
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object');
    }
    return {ok: true, state: parsed};
  } catch (error: unknown) {
    console.error(`Error: Invalid JSON for --state: ${toMessage(error)}`);
    return {ok: false};
  }
}

/** Whether a plain-text answer means "yes" to a confirmation request. */
export function isPositiveResponse(value: string): boolean {
  return POSITIVE_RESPONSES.has(value.trim().toLowerCase());
}

interface InputFile {
  state: Record<string, unknown>;
  queries: string[];
}

/**
 * The one readline interface for the run, created on first prompt. A fresh
 * interface per prompt discards the lines readline had already read ahead from
 * a pipe.
 */
let sharedReadline: readline.Interface | undefined;

function getReadline(): readline.Interface {
  sharedReadline ??= readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return sharedReadline;
}

/** Releases the shared interface, so an idle stdin stops holding the process open. */
function closeUserInput(): void {
  sharedReadline?.close();
  sharedReadline = undefined;
}

async function getUserInput(prompt: string): Promise<string> {
  const rl = getReadline();
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });

  if (!process.stdin.isTTY) {
    console.log(answer);
  }
  return answer;
}

interface RunFromInputFileOptions {
  appName: string;
  userId: string;
  agent: RunnableRoot;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  filePath: string;
}
async function runFromInputFile(
  options: RunFromInputFileOptions,
): Promise<Session | undefined> {
  const fileContent = await loadFileData<InputFile>(
    getAbsolutePath(options.filePath),
  );
  if (!fileContent) {
    return;
  }

  fileContent.state['_time'] = new Date().toISOString();

  const session = await options.sessionService.createSession({
    appName: options.appName,
    userId: options.userId,
    state: fileContent.state,
  });

  const runner = new Runner(options);
  let waitingOnUser = false;

  for (const query of fileContent.queries) {
    console.log(`[user]: ${query}`);

    const runOptions = {
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: query}]},
      // Interactive CLI: let a plain-text "yes"/"no" resolve a pending tool
      // confirmation (opt-in; off by default on non-interactive surfaces).
      runConfig: {plainTextToolConfirmation: true},
    };

    waitingOnUser = false;
    for await (const event of runner.runAsync(runOptions)) {
      printEvent(event);
      // A scripted run has no prompt to answer at: whatever the pause asked
      // for has to be the next query in the file.
      waitingOnUser = requiresUserInput(event) || waitingOnUser;
    }
  }

  if (waitingOnUser) {
    console.error(
      'The run ended while still waiting for user input. ' +
        'Add the answer as the next query in the input file.',
    );
  }

  return session;
}

interface RunInteractivelyOptions {
  rootAgent?: RunnableRoot;
  app?: App;
  session: Session;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  onAgentFileReloaded?: (subscribe: (newAgent: RunnableRoot) => void) => void;
  jsonl?: boolean;
  /** Budget for one turn, e.g. `30s`; unset leaves a turn unbounded. */
  timeout?: string;
}
async function runInteractively(
  options: RunInteractivelyOptions,
): Promise<void> {
  const currentRoot = options.rootAgent ?? options.app?.rootAgent;
  if (!currentRoot) {
    throw new Error('cli_run requires a rootAgent or an app.');
  }
  let currentAgent: RunnableRoot = currentRoot;
  let runner = new Runner({
    app: options.app,
    appName: options.app?.name ?? currentAgent.name,
    agent: options.app?.rootAgent ?? currentAgent,
    artifactService: options.artifactService,
    sessionService: options.sessionService,
    memoryService: options.memoryService,
  });

  options.onAgentFileReloaded?.((newAgent: RunnableRoot) => {
    currentAgent = newAgent;
    runner = new Runner({
      appName: newAgent.name,
      agent: newAgent,
      artifactService: options.artifactService,
      sessionService: options.sessionService,
      memoryService: options.memoryService,
    });
    console.log(`Agent reloaded. New runner created with existing session.`);
  });

  while (true) {
    const query = await getUserInput('[user]: ');

    if (!query || !query.trim()) {
      continue;
    }

    if (query === 'exit') {
      break;
    }

    const turn = async () => {
      for await (const event of runner.runAsync({
        userId: options.session.userId,
        sessionId: options.session.id,
        newMessage: {role: 'user', parts: [{text: query}]},
        // Interactive CLI: let a plain-text "yes"/"no" resolve a pending tool
        // confirmation (opt-in; off by default on non-interactive surfaces).
        runConfig: {plainTextToolConfirmation: true},
      })) {
        printEvent(event, {
          jsonl: options.jsonl,
          sessionId: options.session.id,
        });
      }
    };

    try {
      await (options.timeout
        ? withTimeout(turn(), parseTimeout(options.timeout))
        : turn());
    } catch (error) {
      console.error(`[ADK CLI] Turn failed: ${toMessage(error)}`);
    }
  }
}

/**
 * Runs an interactive CLI for a certain agent.
 */
export interface RunAgentOptions {
  agentPath: string;
  inputFile?: string;
  savedSessionFile?: string;
  saveSession?: boolean;
  sessionId?: string;
  artifactService?: BaseArtifactService;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  otelToCloud?: boolean;
  agentFileLoadOptions?: AgentFileOptions;
  reloadAgents?: boolean;
  /** Initial session state, as a JSON object. */
  stateStr?: string;
  /** Budget for one turn, e.g. `30s`. */
  timeout?: string;
  /** Print one JSON object per event instead of human-readable text. */
  jsonl?: boolean;
}
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const parsedState = parseSessionState(options.stateStr);
  if (!parsedState.ok) {
    return;
  }

  const userId = 'test_user';
  const artifactService =
    options.artifactService || new InMemoryArtifactService();
  const sessionService = options.sessionService || new InMemorySessionService();
  const memoryService = options.memoryService || new InMemoryMemoryService();
  await using agentFile = new AgentFile(
    getAbsolutePath(options.agentPath),
    options.agentFileLoadOptions,
  );
  const loaded = await agentFile.load();
  const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
  const app = isApp(loaded) ? loaded : undefined;

  let session = await sessionService.createSession({
    appName: app?.name ?? rootAgent.name,
    userId,
    state: parsedState.state,
  });

  const reloadSubscribers: Array<(agent: RunnableRoot) => void> = [];
  let watcher: fs.FSWatcher | undefined;

  if (options.reloadAgents) {
    const agentFilePath = getAbsolutePath(options.agentPath);
    watcher = fs.watch(agentFilePath, async () => {
      try {
        await using reloadedFile = new AgentFile(
          agentFilePath,
          options.agentFileLoadOptions,
        );
        const reloaded = await reloadedFile.load();
        const newAgent = isApp(reloaded) ? reloaded.rootAgent : reloaded;
        for (const subscriber of reloadSubscribers) {
          subscriber(newAgent);
        }
      } catch (err) {
        console.warn('Failed to reload agent:', (err as Error).message);
      }
    });
  }

  const onAgentFileReloaded = (subscribe: (agent: RunnableRoot) => void) => {
    reloadSubscribers.push(subscribe);
  };

  try {
    if (options.inputFile) {
      session =
        (await runFromInputFile({
          appName: app?.name ?? rootAgent.name,
          userId,
          agent: rootAgent,
          artifactService,
          sessionService,
          memoryService,
          filePath: options.inputFile,
        })) || session;
    } else if (options.savedSessionFile) {
      const loadedSession = await loadFileData<Session>(
        options.savedSessionFile,
      );
      if (loadedSession) {
        for (const event of loadedSession.events) {
          await sessionService.appendEvent({session, event});
          printEvent(event, {
            announcePauses: false,
            jsonl: options.jsonl,
            sessionId: session.id,
          });
        }

        // Only the pauses the transcript never answered are still live, and
        // they are what the prompt below is waiting on.
        for (const request of getPendingUserInputRequests(
          loadedSession.events,
        )) {
          console.log(renderUserInputRequest(request));
        }
      }

      await runInteractively({
        rootAgent,
        app,
        artifactService,
        sessionService,
        memoryService,
        session,
        jsonl: options.jsonl,
        timeout: options.timeout,
        onAgentFileReloaded: options.reloadAgents
          ? onAgentFileReloaded
          : undefined,
      });
    } else {
      console.log(
        `Running ${app ? `app ${app.name}` : `agent ${rootAgent.name}`}, type exit to exit.`,
      );
      await runInteractively({
        rootAgent,
        app,
        artifactService,
        sessionService,
        memoryService,
        session,
        jsonl: options.jsonl,
        timeout: options.timeout,
        onAgentFileReloaded: options.reloadAgents
          ? onAgentFileReloaded
          : undefined,
      });
    }

    if (options.saveSession) {
      const sessionId =
        options.sessionId || (await getUserInput('Session ID to save: '));
      // Sibling of the agent file, not inside it: joining onto the agent path
      // itself yields `<cwd>/agent.ts/<id>.session.json`, and saveToFile does
      // no mkdir, so the write failed with ENOTDIR.
      const sessionPath = path.join(
        path.dirname(options.agentPath),
        `${sessionId}.session.json`,
      );
      const sessionToStore = await sessionService.getSession({
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      });
      await saveToFile(getAbsolutePath(sessionPath), sessionToStore);

      console.log('Session saved to', sessionPath);
    }
  } finally {
    // A throw out of the run or the save step must still release these, or the
    // shared interface holds stdin open for an in-process caller.
    watcher?.close();
    closeUserInput();
  }
}

/** Options for a single-shot `adk run <agent> [query]`. */
export interface RunOnceOptions {
  agentPath: string;
  /** The message to send. Read from stdin when absent and stdin is piped. */
  query?: string;
  /** Initial session state, as a JSON object. */
  stateStr?: string;
  /** Existing session to continue, which also enables auto-resume. */
  sessionId?: string;
  /** JSON file holding the initial state and a list of queries. */
  replay?: string;
  /** Budget for one query, e.g. `30s`. */
  timeout?: string;
  /** Print one JSON object per event instead of human-readable text. */
  jsonl?: boolean;
  sessionService: BaseSessionService;
  artifactService: BaseArtifactService;
  memoryService: BaseMemoryService;
  agentFileLoadOptions?: AgentFileOptions;
}

/** The interrupt a query should answer instead of starting a new turn. */
function findPendingInterrupt(
  events: Event[],
): {id: string; name?: string} | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const [id] = event.longRunningToolIds ?? [];
    if (id) {
      const call = getFunctionCalls(event).find((each) => each.id === id);
      return {id, name: call?.name};
    }
  }
  return undefined;
}

/** Builds the function response that answers a pending interrupt. */
function buildInterruptResponse(
  interrupt: {id: string; name?: string},
  query: string,
): Content {
  const isConfirmation = interrupt.name === REQUEST_CONFIRMATION;
  let response: Record<string, unknown> = {result: query};

  if (isConfirmation) {
    response = {confirmed: isPositiveResponse(query)};
    try {
      const parsed: unknown = JSON.parse(query);
      // A JSON array is not a response payload, so it falls back to the
      // plain-text reading, as adk-python's isinstance(parsed, dict) does.
      if (isRecord(parsed)) {
        response = parsed;
      }
    } catch {
      // Not JSON, so the plain-text yes/no reading above stands.
    }
  }

  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: interrupt.id,
          name: isConfirmation ? REQUEST_CONFIRMATION : REQUEST_INPUT,
          response,
        },
      },
    ],
  };
}

/** Runs one query and reports whether the agent stopped waiting on a human. */
async function executeQuery(
  runner: Runner,
  session: Session,
  query: string,
  jsonl: boolean,
): Promise<boolean> {
  const interrupt = findPendingInterrupt(session.events);
  if (interrupt && !jsonl) {
    console.error(
      `Auto-resuming interrupt ${interrupt.id} with input: ${query}`,
    );
  }

  const newMessage = interrupt
    ? buildInterruptResponse(interrupt, query)
    : {role: 'user', parts: [{text: query}]};

  let paused = false;
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage,
  })) {
    printEvent(event, {jsonl, sessionId: session.id});
    paused = paused || (event.longRunningToolIds ?? []).length > 0;
  }

  if (paused && !jsonl) {
    console.error(
      `\n${'='.repeat(60)}\n` +
        '[PAUSED] Workflow is waiting for human input!\n\n' +
        'To resume, run the command again with:\n' +
        `  --session_id ${session.id}\n` +
        'And provide your input as the query.\n' +
        `${'='.repeat(60)}\n`,
    );
  }

  return paused;
}

/**
 * Runs an agent once and exits, instead of opening the interactive prompt.
 *
 * @returns the process exit code: 0 for success, 1 for a usage or runtime
 *   failure, and 2 when the run finished waiting on human input.
 */
export async function runOnceCli(options: RunOnceOptions): Promise<number> {
  const parsedState = parseSessionState(options.stateStr);
  if (!parsedState.ok) {
    return FAILURE_EXIT_CODE;
  }

  let query = options.query;
  if (query && options.replay) {
    console.error('Error: Cannot provide both query and --replay.');
    return FAILURE_EXIT_CODE;
  }

  if (!query && !options.replay) {
    if (process.stdin.isTTY) {
      console.error('Error: Missing query argument or stdin input.');
      return FAILURE_EXIT_CODE;
    }
    query = (await text(process.stdin)).trim();
  }

  const {sessionService, artifactService, memoryService} = options;
  await using agentFile = new AgentFile(
    getAbsolutePath(options.agentPath),
    options.agentFileLoadOptions,
  );
  const loaded = await agentFile.load();
  const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
  const app = isApp(loaded) ? loaded : undefined;
  const appName = app?.name ?? rootAgent.name;
  const userId = 'test_user';

  const runner = new Runner({
    app,
    appName,
    agent: rootAgent,
    artifactService,
    sessionService,
    memoryService,
  });

  let session: Session;
  let queries: string[];

  if (options.replay) {
    const inputFile = await loadFileData<InputFile>(
      getAbsolutePath(options.replay),
    );
    session = await sessionService.createSession({
      appName,
      userId,
      state: inputFile?.state,
      sessionId: options.sessionId,
    });
    queries = inputFile?.queries ?? [];
  } else {
    const existing = options.sessionId
      ? await sessionService.getSession({
          appName,
          userId,
          sessionId: options.sessionId,
        })
      : undefined;
    session =
      existing ??
      (await sessionService.createSession({
        appName,
        userId,
        state: parsedState.state,
        sessionId: options.sessionId,
      }));
    queries = query ? [query] : [];
  }

  const jsonl = options.jsonl === true;
  if (!jsonl) {
    console.error(`Session ID: ${session.id}`);
  }

  let exitCode = 0;
  try {
    for (const each of queries) {
      const run = executeQuery(runner, session, each, jsonl);
      const paused = options.timeout
        ? await withTimeout(run, parseTimeout(options.timeout))
        : await run;
      if (paused) {
        exitCode = PAUSED_EXIT_CODE;
      }
    }
  } catch (error: unknown) {
    console.error(
      error instanceof TimeoutError
        ? `Error: Command timed out after ${options.timeout}`
        : `Error: ${toMessage(error)}`,
    );
    return FAILURE_EXIT_CODE;
  }

  return exitCode;
}
