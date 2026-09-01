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
  getPendingUserInputRequests,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  requiresUserInput,
  RunnableRoot,
  Runner,
  Session,
  UserInputRequest,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import {AgentFile, AgentFileOptions} from '../utils/agent_loader.js';
import {parseDuration} from '../utils/duration_utils.js';
import {toErrorMessage} from '../utils/error_utils.js';
import {
  getAbsolutePath,
  loadFileData,
  saveToFile,
} from '../utils/file_utils.js';
import {parseStateOption} from '../utils/json_utils.js';
import {runWithTimeout} from '../utils/timeout_utils.js';
import {printEvent, renderUserInputRequest} from './event_printer.js';
import {buildInterruptResponse} from './hitl_response.js';
import {withJsonlStdout} from './jsonl_stdout.js';

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

/**
 * Reads one line from the user.
 *
 * @param prompt The prompt to show.
 * @param echo Whether to repeat the answer on stdout when stdin is a pipe,
 *     where readline shows the user nothing. Off in JSONL mode, whose stdout
 *     carries only JSON lines.
 */
async function getUserInput(prompt: string, echo = true): Promise<string> {
  const rl = getReadline();
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });

  if (!process.stdin.isTTY && echo) {
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
  jsonl?: boolean;
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
    if (!options.jsonl) {
      console.log(`[user]: ${query}`);
    }

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
      printEvent(event, {jsonl: options.jsonl, sessionId: session.id});
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

/**
 * Asks the user to answer one paused request, and builds the function response
 * that carries the answer back.
 */
async function answerUserInputRequest(
  request: UserInputRequest,
  echo: boolean,
): Promise<Part> {
  return buildInterruptResponse(request, await getUserInput('[user]: ', echo));
}

/**
 * Answers every request a turn left open, as one message.
 *
 * Several pending requests are answered together because the run resumes from a
 * single message: sending them one at a time would resume the invocation with
 * the first answer and lose the rest.
 *
 * @param events The events the turn emitted.
 * @param answeredIds The interrupts this session has already answered, which
 *     this call adds to. An agent that raises an interrupt it was already given
 *     an answer for makes no progress, so the CLI stops answering it rather
 *     than prompting for it on every turn.
 * @param echo Whether to repeat the answer on stdout.
 * @return The message answering the turn, or undefined when it left nothing
 *     open.
 */
async function answerPendingRequests(
  events: Event[],
  answeredIds: Set<string>,
  echo: boolean,
): Promise<Content | undefined> {
  const parts: Part[] = [];
  for (const request of getPendingUserInputRequests(events)) {
    if (answeredIds.has(request.interruptId)) {
      continue;
    }
    answeredIds.add(request.interruptId);
    parts.push(await answerUserInputRequest(request, echo));
  }
  return parts.length > 0 ? {role: 'user', parts} : undefined;
}

interface RunInteractivelyOptions {
  rootAgent?: RunnableRoot;
  app?: App;
  session: Session;
  artifactService: BaseArtifactService;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  timeout?: string;
  jsonl?: boolean;
  onAgentFileReloaded?: (subscribe: (newAgent: RunnableRoot) => void) => void;
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

  const timeoutMs = options.timeout
    ? parseDuration(options.timeout)
    : undefined;
  const answeredIds = new Set<string>();
  let nextMessage: Content | undefined;

  while (true) {
    if (!nextMessage) {
      const query = await getUserInput('[user]: ', !options.jsonl);

      if (!query || !query.trim()) {
        continue;
      }

      if (query === 'exit') {
        break;
      }

      nextMessage = {role: 'user', parts: [{text: query}]};
    }

    const message = nextMessage;
    nextMessage = undefined;
    const turnEvents: Event[] = [];

    try {
      const timedOut = await runWithTimeout(timeoutMs, async (abortSignal) => {
        for await (const event of runner.runAsync({
          userId: options.session.userId,
          sessionId: options.session.id,
          newMessage: message,
          // Interactive CLI: let a plain-text "yes"/"no" resolve a pending tool
          // confirmation (opt-in; off by default on non-interactive surfaces).
          runConfig: {plainTextToolConfirmation: true},
          abortSignal,
        })) {
          turnEvents.push(event);
          printEvent(event, {
            jsonl: options.jsonl,
            sessionId: options.session.id,
          });
        }
      });

      if (timedOut) {
        console.error(`Error: Command timed out after ${options.timeout}`);
        continue;
      }
    } catch (error: unknown) {
      console.error(`[ADK CLI] Turn failed: ${toErrorMessage(error)}`);
      continue;
    }

    nextMessage = await answerPendingRequests(
      turnEvents,
      answeredIds,
      !options.jsonl,
    );
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
  /** Initial session state, as a JSON object. */
  state?: string;
  /** Budget for one turn, e.g. `30s` or `5m`. */
  timeout?: string;
  /** Whether to write one JSON line per event instead of readable text. */
  jsonl?: boolean;
  artifactService?: BaseArtifactService;
  sessionService?: BaseSessionService;
  memoryService?: BaseMemoryService;
  otelToCloud?: boolean;
  agentFileLoadOptions?: AgentFileOptions;
  reloadAgents?: boolean;
}
/** Runs the interactive session the options describe. */
async function runSession(
  options: RunAgentOptions,
  initialState: Record<string, unknown> | undefined,
): Promise<void> {
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
    state: initialState,
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
          jsonl: options.jsonl,
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
        if (!options.jsonl) {
          for (const request of getPendingUserInputRequests(
            loadedSession.events,
          )) {
            console.log(renderUserInputRequest(request));
          }
        }
      }

      await runInteractively({
        rootAgent,
        app,
        artifactService,
        sessionService,
        memoryService,
        session,
        timeout: options.timeout,
        jsonl: options.jsonl,
        onAgentFileReloaded: options.reloadAgents
          ? onAgentFileReloaded
          : undefined,
      });
    } else {
      if (!options.jsonl) {
        console.log(
          `Running ${app ? `app ${app.name}` : `agent ${rootAgent.name}`}, type exit to exit.`,
        );
      }
      await runInteractively({
        rootAgent,
        app,
        artifactService,
        sessionService,
        memoryService,
        session,
        timeout: options.timeout,
        jsonl: options.jsonl,
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

export async function runAgent(options: RunAgentOptions): Promise<void> {
  let initialState: Record<string, unknown> | undefined;
  try {
    initialState = parseStateOption(options.state);
  } catch (error: unknown) {
    console.error(`Error: ${toErrorMessage(error)}`);
    return;
  }

  const run = () => runSession(options, initialState);
  return options.jsonl ? withJsonlStdout(run) : run();
}
