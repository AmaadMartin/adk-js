/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replays recorded agent conversations and re-records them.
 *
 * Ports adk-python's `cli/agent_test_runner.py`. A fixture is a saved session
 * (what `adk run --save_session` writes) stored at `<agent>/tests/*.json`;
 * replaying one drives the agent with the recorded user messages while a
 * plugin answers every model call from the recording, so no credentials and no
 * network are needed.
 */

import {
  createEvent,
  Event,
  getFunctionCalls,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isApp,
  LlmResponse,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  Runner,
  Session,
} from '@google/adk';
import {Content, Part} from '@google/genai';
import fg from 'fast-glob';
import * as assert from 'node:assert';
import * as path from 'node:path';
import {
  AgentFile,
  AgentFileOptions,
  findAgentEntryFile,
} from '../utils/agent_loader.js';
import {isFolderExists, loadFileData, saveToFile} from '../utils/file_utils.js';
import {
  compareSortKeys,
  JsonObject,
  normalizeEvents,
  normalizeIds,
  normalizeRebuiltEvents,
  PATH_SEPARATOR,
  sortKeysDeep,
} from './agent_test_normalization.js';
import {RecordedModelPlugin} from './recorded_model_plugin.js';

/** One discovered fixture and the agent it belongs to. */
export interface AgentTestCase {
  /** Absolute path of the directory holding the agent entry file. */
  agentDir: string;
  /** Absolute path of the agent entry file to load. */
  entryFile: string;
  /** Absolute path of the recorded fixture. */
  testFile: string;
  /** `<agentDirName>/<fixtureFileName>`, the id used in output. */
  name: string;
  /** The fixture name ends in `_xfail`: it is expected to fail. */
  expectedFailure: boolean;
}

/** Every outcome a fixture can have, in the order the summary reports them. */
const AGENT_TEST_STATUSES = [
  'passed',
  'failed',
  'skipped',
  /** Expected to fail, and it failed. */
  'xfail',
  /** Expected to fail, but it passed. */
  'xpass',
] as const;

/** The outcome of replaying one fixture. */
export type AgentTestStatus = (typeof AGENT_TEST_STATUSES)[number];

/** The result of replaying one fixture. */
export interface AgentTestResult {
  name: string;
  status: AgentTestStatus;
  /** The comparison failure or the skip reason. Absent when passed. */
  message?: string;
}

/** Options shared by {@link runAgentTests} and {@link rebuildAgentTests}. */
export interface AgentTestOptions {
  /** Absolute path of the folder searched for agents and their fixtures. */
  folder: string;
  agentFileLoadOptions?: AgentFileOptions;
}

/** One event as recorded in a fixture: any field may be absent. */
export type RecordedEvent = Partial<Event>;

/** A user turn read from a fixture. It always carries at least one part. */
export type RecordedUserMessage = Content & {parts: Part[]};

/**
 * A parsed fixture. Only `events` and `mocks` are interpreted; every other key
 * is a saved-session field that a rebuild preserves verbatim.
 */
type RecordedFixture = {
  events?: RecordedEvent[];
  mocks?: JsonObject;
};

/** Fixture file name suffix marking an expected failure. */
const XFAIL_SUFFIX = '_xfail';

/** The user a replayed or rebuilt conversation runs as. */
const TEST_USER_ID = 'test_user';

/**
 * Name of the tool a recorded conversation uses to declare the model's
 * structured output. The event that follows it is synthesized by ADK rather
 * than produced by the model, so it is not a recorded model response.
 */
const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/**
 * Discovers the recorded fixtures under `folder`.
 *
 * A fixture is a `.json` file in a `tests/` directory whose parent holds a
 * loadable agent entry file. `node_modules` and dot-directories are skipped.
 *
 * @param folder Absolute path of the folder to search.
 * @returns The discovered fixtures, ordered by path. Empty when `folder` is
 *     not a directory.
 */
export async function getTestFiles(folder: string): Promise<AgentTestCase[]> {
  if (!(await isFolderExists(folder))) {
    return [];
  }

  const testFiles = await fg('**/tests/*.json', {
    cwd: folder,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
  });

  const testCases: AgentTestCase[] = [];
  for (const match of testFiles.sort()) {
    // fast-glob returns POSIX separators on every platform, so the reported
    // paths would not be the ones the user sees on Windows.
    const testFile = path.resolve(match);
    const agentDir = path.dirname(path.dirname(testFile));
    const entryFile = await findAgentEntryFile(agentDir);
    if (!entryFile) {
      continue;
    }
    testCases.push({
      agentDir,
      entryFile,
      testFile,
      name: `${path.basename(agentDir)}/${path.basename(testFile)}`,
      expectedFailure: path.basename(testFile, '.json').endsWith(XFAIL_SUFFIX),
    });
  }
  return testCases;
}

/**
 * Replays every fixture under the configured folder against a mocked model and
 * prints a line per fixture plus a summary.
 *
 * @returns One result per discovered fixture.
 */
export async function runAgentTests(
  options: AgentTestOptions,
): Promise<AgentTestResult[]> {
  const testCases = await getTestFiles(options.folder);
  if (testCases.length === 0) {
    console.log(`No agent test files found in ${options.folder}`);
    return [];
  }

  const results: AgentTestResult[] = [];
  for (const testCase of testCases) {
    const result = applyExpectedFailure(
      await replayFixture(testCase, options.agentFileLoadOptions),
      testCase,
    );
    console.log(formatResultLine(result));
    results.push(result);
  }
  console.log(formatSummary(results));
  return results;
}

/**
 * Re-records every fixture under the configured folder by rerunning its
 * conversation against the real model, and overwrites each fixture in place.
 *
 * Unlike {@link runAgentTests} this calls the model, so it needs credentials.
 * A fixture that fails is reported and the loop continues to the next one.
 */
export async function rebuildAgentTests(
  options: AgentTestOptions,
): Promise<void> {
  const testCases = await getTestFiles(options.folder);
  if (testCases.length === 0) {
    console.log(`No agent test files found in ${options.folder}`);
    return;
  }

  for (const testCase of testCases) {
    try {
      console.log(await rebuildFixture(testCase, options.agentFileLoadOptions));
    } catch (error: unknown) {
      console.log(`FAILED ${testCase.name}: ${errorMessage(error)}`);
    }
  }
}

function applyExpectedFailure(
  result: AgentTestResult,
  testCase: AgentTestCase,
): AgentTestResult {
  if (!testCase.expectedFailure || result.status === 'skipped') {
    return result;
  }
  return {
    ...result,
    status: result.status === 'failed' ? 'xfail' : 'xpass',
  };
}

function formatResultLine(result: AgentTestResult): string {
  const head = `${result.status.toUpperCase()} ${result.name}`;
  return result.message ? `${head}\n  ${result.message}` : head;
}

function formatSummary(results: readonly AgentTestResult[]): string {
  return AGENT_TEST_STATUSES.map(
    (status) =>
      `${results.filter((result) => result.status === status).length} ${status}`,
  ).join(', ');
}

/**
 * Replays one fixture. Every failure — a fixture that will not parse, an agent
 * that will not load, a model call with no recorded response, or a comparison
 * that does not match — becomes one `failed` result naming the fixture, so a
 * single broken agent cannot abort the run.
 */
async function replayFixture(
  testCase: AgentTestCase,
  agentFileLoadOptions?: AgentFileOptions,
): Promise<AgentTestResult> {
  try {
    return await replay(testCase, agentFileLoadOptions);
  } catch (error: unknown) {
    return {
      name: testCase.name,
      status: 'failed',
      message: `${testCase.name}: ${errorMessage(error)}`,
    };
  }
}

async function replay(
  testCase: AgentTestCase,
  agentFileLoadOptions?: AgentFileOptions,
): Promise<AgentTestResult> {
  const fixture =
    (await loadFileData<RecordedFixture>(testCase.testFile)) ?? {};
  const events = fixture.events ?? [];
  const skipReason = replaySkipReason(fixture, events);
  if (skipReason) {
    return {name: testCase.name, status: 'skipped', message: skipReason};
  }

  const opening = extractUserContent(events[0]);
  if (!opening?.parts[0]?.text) {
    return {
      name: testCase.name,
      status: 'skipped',
      message: 'the fixture does not open with a user text message',
    };
  }

  const expectedEvents = events.slice(1);
  const plugin = new RecordedModelPlugin(
    buildRecordedResponses(expectedEvents),
    testCase.name,
  );

  await using agentFile = new AgentFile(
    testCase.entryFile,
    agentFileLoadOptions,
  );
  const {runner, session} = await createTestRunner(agentFile, [plugin]);

  const mapper = new FunctionCallIdMapper(recordedFunctionCallIds(events));
  const actual: Event[] = [];
  const firstTurn = await runTurn(runner, session, opening);
  mapper.absorb(firstTurn);
  actual.push(...firstTurn);

  for (const recorded of expectedEvents) {
    const content = extractUserContent(recorded);
    if (!content) {
      continue;
    }
    mapper.remap(content);
    // `runAsync` appends the user message to the session without yielding it,
    // so the replayed conversation has to carry it explicitly.
    actual.push(
      createEvent({author: 'user', content, branch: recorded.branch}),
    );
    const turn = await runTurn(runner, session, content);
    mapper.absorb(turn);
    actual.push(...turn);
  }

  assert.deepStrictEqual(
    normalizeEvents(normalizeIds(actual)).sort(compareSortKeys),
    normalizeEvents(expectedEvents).sort(compareSortKeys),
  );
  return {name: testCase.name, status: 'passed'};
}

async function rebuildFixture(
  testCase: AgentTestCase,
  agentFileLoadOptions?: AgentFileOptions,
): Promise<string> {
  const fixture =
    (await loadFileData<RecordedFixture>(testCase.testFile)) ?? {};
  const events = fixture.events ?? [];
  const skipReason = replaySkipReason(fixture, events);
  if (skipReason) {
    return `SKIPPED ${testCase.name}: ${skipReason}`;
  }

  const userMessages = events
    .map(extractUserContent)
    .filter((content) => content !== undefined);
  if (userMessages.length === 0) {
    return `SKIPPED ${testCase.name}: the fixture records no user messages`;
  }

  await using agentFile = new AgentFile(
    testCase.entryFile,
    agentFileLoadOptions,
  );
  const {runner, session} = await createTestRunner(agentFile, []);

  const mapper = new FunctionCallIdMapper(recordedFunctionCallIds(events));
  const rebuilt: Event[] = [];
  for (const [index, message] of userMessages.entries()) {
    mapper.remap(message);
    const userEvent = createEvent({author: 'user', content: message});
    const turn = await runTurn(runner, session, message);
    mapper.absorb(turn);
    // A rerun that changes nothing must produce no diff, so the invocation id
    // is derived from the turn rather than left random.
    for (const event of [userEvent, ...turn]) {
      event.invocationId = `i-${index + 1}`;
    }
    rebuilt.push(userEvent, ...turn);
  }

  const rebuiltFixture: JsonObject = {
    ...fixture,
    events: normalizeRebuiltEvents(normalizeIds(rebuilt)),
  };
  delete rebuiltFixture['lastUpdateTime'];
  await saveToFile(
    testCase.testFile,
    `${JSON.stringify(sortKeysDeep(rebuiltFixture), null, 2)}\n`,
  );
  return `REBUILT ${testCase.testFile}`;
}

function replaySkipReason(
  fixture: RecordedFixture,
  events: readonly RecordedEvent[],
): string | undefined {
  if (events.length === 0) {
    return 'the fixture records no events';
  }
  if (fixture.mocks && Object.keys(fixture.mocks).length > 0) {
    return 'the fixture relies on recorded RNG mocks, which are not supported';
  }
  return undefined;
}

async function createTestRunner(
  agentFile: AgentFile,
  plugins: RecordedModelPlugin[],
): Promise<{runner: Runner; session: Session}> {
  const loaded = await agentFile.load();
  const app = isApp(loaded) ? loaded : undefined;
  const rootAgent = isApp(loaded) ? loaded.rootAgent : loaded;
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    app,
    appName: app?.name ?? rootAgent.name,
    agent: rootAgent,
    sessionService,
    artifactService: new InMemoryArtifactService(),
    memoryService: new InMemoryMemoryService(),
    plugins,
  });
  const session = await sessionService.createSession({
    appName: runner.appName,
    userId: TEST_USER_ID,
  });
  return {runner, session};
}

async function runTurn(
  runner: Runner,
  session: Session,
  newMessage: Content,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage,
  })) {
    events.push(event);
  }
  return events;
}

/**
 * Builds the model responses a fixture recorded, in the order the agent will
 * ask for them.
 *
 * Not every recorded model event came from the model: ADK synthesizes the
 * structured-output response that follows a `set_model_response` tool call,
 * and it raises the human-in-the-loop requests itself.
 */
export function buildRecordedResponses(
  events: readonly RecordedEvent[],
): LlmResponse[] {
  const responses: LlmResponse[] = [];
  let afterSetModelResponse = false;

  for (const event of events) {
    const content = event.content;
    if (!content) {
      continue;
    }
    if (content.role === 'user') {
      afterSetModelResponse ||= hasSetModelResponse(content);
      continue;
    }
    if (content.role !== 'model') {
      continue;
    }
    if (afterSetModelResponse) {
      afterSetModelResponse = false;
      continue;
    }
    if (!isFrameworkRequest(event, content)) {
      // A copy, not the fixture's own object: the flow stamps generated ids
      // onto the content it is given, which would edit the recorded side of
      // the comparison into agreeing with the live one.
      responses.push({content: structuredClone(content)});
    }
  }
  return responses;
}

function hasSetModelResponse(content: Content): boolean {
  return (content.parts ?? []).some(
    (part) => part.functionResponse?.name === SET_MODEL_RESPONSE_TOOL_NAME,
  );
}

/**
 * Whether a recorded model event is a human-in-the-loop request the framework
 * raises, rather than a response the model produced.
 *
 * A bare `adk_request_input` at the root of the agent tree IS a model call;
 * only the workflow-node form, which has a parent node in its path, is
 * framework-generated.
 */
function isFrameworkRequest(event: RecordedEvent, content: Content): boolean {
  const nodePath = event.nodeInfo?.path ?? '';
  return (content.parts ?? []).some((part) => {
    switch (part.functionCall?.name) {
      case REQUEST_CONFIRMATION_FUNCTION_CALL_NAME:
      case REQUEST_CREDENTIAL_FUNCTION_CALL_NAME:
        return true;
      case REQUEST_INPUT_FUNCTION_CALL_NAME:
        return nodePath.includes(PATH_SEPARATOR);
      default:
        return false;
    }
  });
}

/**
 * Extracts the content of a recorded event that is a real user turn.
 *
 * An agent-emitted user-role event carries a node path; re-feeding one to the
 * runner would trigger an extra model call, so it is not a user turn.
 */
export function extractUserContent(
  event: RecordedEvent,
): RecordedUserMessage | undefined {
  if (event.author !== 'user' || event.nodeInfo?.path) {
    return undefined;
  }
  const parts = (event.content?.parts ?? [])
    .map(toReplayablePart)
    .filter((part) => part !== undefined);
  return parts.length > 0 ? {role: 'user', parts} : undefined;
}

function toReplayablePart(part: Part): Part | undefined {
  if (part.functionResponse) {
    return {functionResponse: {...part.functionResponse}};
  }
  if (part.text !== undefined) {
    return {text: part.text};
  }
  if (part.functionCall) {
    return {functionCall: {...part.functionCall}};
  }
  return undefined;
}

function recordedFunctionCallIds(events: readonly RecordedEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    for (const part of event.content?.parts ?? []) {
      const id = part.functionCall?.id;
      if (id !== undefined) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * Pairs the function-call ids a fixture recorded with the ids the live run
 * generates, in call order, so a recorded `functionResponse` is replayed
 * against the call the run actually made.
 *
 * A call the model made keeps the recorded id, because the recorded response
 * carries it. The pairing is what covers the calls the framework raises
 * itself — a confirmation or credential request — whose id is generated fresh
 * on every run.
 */
export class FunctionCallIdMapper {
  private readonly idMap = new Map<string, string>();
  private consumed = 0;

  constructor(private readonly recordedIds: readonly string[]) {}

  /** Pairs the calls of one completed turn with the next recorded ids. */
  absorb(events: readonly Event[]): void {
    for (const event of events) {
      for (const call of getFunctionCalls(event)) {
        if (call.id === undefined || this.consumed >= this.recordedIds.length) {
          continue;
        }
        this.idMap.set(this.recordedIds[this.consumed++], call.id);
      }
    }
  }

  /** Rewrites the response ids of a recorded user message, in place. */
  remap(content: RecordedUserMessage): void {
    for (const part of content.parts) {
      const response = part.functionResponse;
      if (response?.id !== undefined) {
        response.id = this.idMap.get(response.id) ?? response.id;
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
