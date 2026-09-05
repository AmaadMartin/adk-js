/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Replays a recorded agent session against a mocked model, and rebuilds the
 * recording from a live run.
 *
 * Ports `google/adk-python` `src/google/adk/cli/agent_test_runner.py`. A
 * fixture is a saved session stored at `<agent>/tests/*.json`; replaying one
 * drives the agent with the recorded user turns while the fixture's own model
 * events answer every model call, so no API key and no network are needed.
 */

import {
  App,
  BaseLlm,
  BaseLlmConnection,
  BasePlugin,
  Context,
  createEvent,
  Event,
  getFunctionCalls,
  InMemoryRunner,
  isApp,
  LlmRequest,
  LlmResponse,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  RunnableRoot,
  Session,
} from '@google/adk';
import {Content, createUserContent, Part} from '@google/genai';
import fg from 'fast-glob';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {AgentFile, findAgentEntryFile} from '../utils/agent_loader.js';
import {loadFileData, saveToFile} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';

import {
  asJsonObject,
  asString,
  NormalizedEvent,
  normalizeEvents,
  normalizeIds,
  normalizeRebuiltEvents,
  sortBySortKey,
  sortKeysDeep,
} from './agent_test_normalization.js';

const logger = new AdkLogger({label: 'AgentTestRunner'});

/** Fixtures live in a `tests/` directory beside the agent entry file. */
const FIXTURE_GLOB = '**/tests/*.json';

/** A fixture whose file stem ends in this is expected to fail. */
const XFAIL_SUFFIX = '_xfail';

/** The directory a reportable test id is made relative to. */
const SAMPLES_DIR_NAME = 'samples';

/** A declarative agent, which marks a directory as an agent directory. */
const AGENT_CONFIG_FILE_NAME = 'root_agent.yaml';

/** The model name {@link MockModel} answers to. */
const MOCK_MODEL_NAME = 'mock';

/** The app and user a replayed or rebuilt conversation runs as. */
const TEST_APP_NAME = 'test_app';
const TEST_USER_ID = 'test_user';

/**
 * The tool a recorded conversation uses to declare the model's structured
 * output. ADK synthesizes the model event that follows it, so that event is
 * not a recorded model response.
 */
const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/** One event as recorded in a fixture: any field may be absent. */
type RecordedEvent = Partial<Event>;

/** One discovered fixture. */
export interface AgentTestCase {
  /** Absolute path of the agent directory (the fixture's grandparent). */
  agentDir: string;
  /** Absolute path of the `tests/*.json` fixture. */
  testFile: string;
  /** Reportable id: `<dir relative to the samples root>/<file name>`. */
  id: string;
  /** True when the file stem ends in `_xfail`. */
  xfail: boolean;
}

/** Outcome of replaying one fixture. */
export type ReplayResult =
  | {status: 'skipped'; reason: string}
  | {
      status: 'compared';
      actual: NormalizedEvent[];
      expected: NormalizedEvent[];
    };

/** Outcome of rebuilding one fixture. */
export interface RebuildResult {
  testFile: string;
  status: 'rebuilt' | 'skipped' | 'error';
  reason?: string;
}

/** The parts of a fixture this module reads, plus the object it rewrites. */
interface Fixture {
  /** The whole parsed file. A rebuild preserves every key it does not set. */
  data: Record<string, unknown>;
  events: RecordedEvent[];
  mocks?: Record<string, unknown>;
}

/**
 * Discovers the fixtures under a folder.
 *
 * Synchronous so that a test runner can build its case list while collecting.
 *
 * @param targetFolder The folder to search. Defaults to `ADK_TEST_FOLDER`.
 * @returns One case per fixture, ordered by path. Empty when no folder is
 *     configured or the folder does not exist.
 */
export function getTestFiles(targetFolder?: string): AgentTestCase[] {
  const folder = targetFolder || process.env['ADK_TEST_FOLDER'];
  if (!folder || !fs.existsSync(folder)) {
    return [];
  }

  const matches = fg.sync(FIXTURE_GLOB, {
    cwd: folder,
    absolute: true,
    onlyFiles: true,
    ignore: ['**/node_modules/**'],
  });

  const cases: AgentTestCase[] = [];
  for (const match of matches.sort()) {
    // fast-glob returns POSIX separators on every platform, so the reported
    // path would not be the one the user sees on Windows.
    const testFile = path.resolve(match);
    const agentDir = path.dirname(path.dirname(testFile));
    if (!isAgentDir(agentDir)) {
      continue;
    }
    cases.push({
      agentDir,
      testFile,
      id: testCaseId(agentDir, testFile),
      xfail: path.basename(testFile, '.json').endsWith(XFAIL_SUFFIX),
    });
  }
  return cases;
}

function isAgentDir(agentDir: string): boolean {
  return (
    findAgentEntryFile(agentDir) !== undefined ||
    fs.existsSync(path.join(agentDir, AGENT_CONFIG_FILE_NAME))
  );
}

/**
 * Builds the reportable id of a fixture: its path below the samples root, or
 * just the agent directory name when the agent lives outside it.
 */
function testCaseId(agentDir: string, testFile: string): string {
  const samplesRoot = findSamplesRoot(agentDir);
  const relativeDir = samplesRoot
    ? path.relative(samplesRoot, agentDir)
    : path.basename(agentDir);
  const posixDir = relativeDir.split(path.sep).join('/');
  return `${posixDir}/${path.basename(testFile)}`;
}

function findSamplesRoot(agentDir: string): string | undefined {
  let current = path.dirname(agentDir);
  for (;;) {
    if (path.basename(current) === SAMPLES_DIR_NAME) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * A model that serves a fixed list of responses in order and records every
 * request it was asked to answer.
 */
export class MockModel extends BaseLlm {
  /** The requests served so far, in order. */
  readonly requests: LlmRequest[] = [];

  private responseIndex = -1;

  constructor(readonly responses: readonly LlmResponse[]) {
    super({model: MOCK_MODEL_NAME});
  }

  /** Builds one response per content, in the order the contents are given. */
  static create(contents: readonly Content[]): MockModel {
    return new MockModel(contents.map((content) => ({content})));
  }

  /**
   * Records the request and returns the next response.
   *
   * @throws If the responses are exhausted, naming how many there were.
   */
  nextResponse(llmRequest: LlmRequest): LlmResponse {
    this.responseIndex += 1;
    this.requests.push(llmRequest);
    const response = this.responses[this.responseIndex];
    if (!response) {
      throw new Error(
        `No more recorded responses available. Requested ${
          this.responseIndex + 1
        }, but only have ${this.responses.length}.`,
      );
    }
    return response;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield this.nextResponse(llmRequest);
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(`${MOCK_MODEL_NAME} does not support a live connection.`);
  }
}

/**
 * Answers every model call of a replay from the fixture's own recording.
 *
 * A plugin rather than a registry entry: it intercepts the call whatever the
 * agent declared as its model, including an agent that holds a model instance
 * instead of a model name.
 */
class MockModelPlugin extends BasePlugin {
  constructor(private readonly model: MockModel) {
    super('mock_model');
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    return this.model.nextResponse(params.llmRequest);
  }
}

/**
 * Drives one conversation against an in-memory runner, reusing a single
 * session across turns.
 *
 * Wraps the real {@link InMemoryRunner}; adk-python's harness class of the
 * same name is a test harness, not the runner.
 */
export class ReplaySessionRunner {
  private readonly runner: InMemoryRunner;
  private session?: Session;

  constructor(params: {
    app?: App;
    agent?: RunnableRoot;
    plugins?: BasePlugin[];
  }) {
    this.runner = new InMemoryRunner({
      app: params.app,
      agent: params.agent,
      appName: TEST_APP_NAME,
      plugins: params.plugins,
    });
  }

  /** Runs one turn and returns the events it produced. */
  async run(newMessage: string | Content): Promise<Event[]> {
    const session = await this.getSession();
    const content =
      typeof newMessage === 'string'
        ? createUserContent(newMessage)
        : newMessage;

    const events: Event[] = [];
    for await (const event of this.runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: content,
    })) {
      events.push(event);
    }
    return events;
  }

  private async getSession(): Promise<Session> {
    this.session ??= await this.runner.sessionService.createSession({
      appName: this.runner.appName,
      userId: TEST_USER_ID,
    });
    return this.session;
  }
}

/**
 * Rebuilds the user turn a recorded event holds, or returns `undefined` when
 * the event is not one.
 *
 * An agent-emitted user-role event carries a node path; re-feeding one to the
 * runner would trigger an extra model call, so it is not a user turn.
 */
export function extractUserContent(event: unknown): Content | undefined {
  const source = asJsonObject(event);
  if (!source || source['author'] !== 'user') {
    return undefined;
  }
  if (asJsonObject(source['nodeInfo'])?.['path']) {
    return undefined;
  }

  const recordedParts = asJsonObject(source['content'])?.['parts'];
  if (!Array.isArray(recordedParts)) {
    return undefined;
  }
  const parts = recordedParts
    .map(asJsonObject)
    .map(toReplayablePart)
    .filter((part): part is Part => part !== undefined);
  return parts.length > 0 ? {role: 'user', parts} : undefined;
}

function toReplayablePart(
  part: Record<string, unknown> | undefined,
): Part | undefined {
  const functionResponse = asJsonObject(part?.['functionResponse']);
  if (functionResponse) {
    return {
      functionResponse: {
        id: asString(functionResponse['id']),
        name: asString(functionResponse['name']),
        response: asJsonObject(functionResponse['response']),
      },
    };
  }
  const text = part?.['text'];
  if (typeof text === 'string') {
    return {text};
  }
  const functionCall = asJsonObject(part?.['functionCall']);
  if (functionCall) {
    return {
      functionCall: {
        id: asString(functionCall['id']),
        name: asString(functionCall['name']),
        args: asJsonObject(functionCall['args']),
      },
    };
  }
  return undefined;
}

/**
 * Replays one fixture: runs the agent with the recorded user turns while the
 * recording answers every model call, then canonicalizes both sides.
 *
 * @returns The two comparable event lists, already ordered, or the reason the
 *     fixture was skipped.
 */
export async function runAgentReplay(
  agentDir: string,
  testFile: string,
): Promise<ReplayResult> {
  const fixture = await readFixture(testFile);
  if (fixture.events.length === 0) {
    return {status: 'skipped', reason: `No events in ${testFile}`};
  }
  if (fixture.mocks && Object.keys(fixture.mocks).length > 0) {
    return {
      status: 'skipped',
      reason:
        `${testFile} pins a random number generator through its "mocks" ` +
        'block, which has no equivalent in Node',
    };
  }
  const userMessage = openingUserText(fixture.events[0]);
  if (!userMessage) {
    return {
      status: 'skipped',
      reason: `Could not find user message in ${testFile}`,
    };
  }
  const entryFile = findAgentEntryFile(agentDir);
  if (!entryFile) {
    return {
      status: 'skipped',
      reason: `No JavaScript or TypeScript agent entry file in ${agentDir}`,
    };
  }

  const expected = fixture.events.slice(1);
  const model = new MockModel(buildMockResponses(expected));
  const agentFile = new AgentFile(entryFile);
  try {
    const runner = new ReplaySessionRunner({
      ...rootOf(await agentFile.load()),
      plugins: [new MockModelPlugin(model)],
    });
    const mapper = new FunctionCallIdMapper(
      recordedFunctionCallIds(fixture.events),
    );

    const actual: Event[] = [];
    const firstTurn = await runner.run(userMessage);
    mapper.absorb(firstTurn);
    actual.push(...firstTurn);

    for (const recorded of expected) {
      const content = extractUserContent(recorded);
      if (!content) {
        continue;
      }
      mapper.remap(content);
      // `runAsync` appends the user message to the session without yielding
      // it, so the replayed conversation has to carry it explicitly.
      actual.push(
        createEvent({author: 'user', content, branch: recorded.branch}),
      );
      const turn = await runner.run(content);
      mapper.absorb(turn);
      actual.push(...turn);
    }

    return {
      status: 'compared',
      actual: sortBySortKey(normalizeEvents(normalizeIds(actual))),
      expected: sortBySortKey(normalizeEvents(expected)),
    };
  } finally {
    await agentFile.dispose();
  }
}

/**
 * Rebuilds fixtures by rerunning their conversations against the real model
 * and writing the result back in place.
 *
 * @param target A directory, which rebuilds every fixture under it, or one
 *     fixture file, which rebuilds only that fixture.
 * @returns One result per fixture. A fixture that fails is reported and the
 *     rebuild continues with the next one.
 */
export async function rebuildTests(target: string): Promise<RebuildResult[]> {
  const isDirectory =
    fs.existsSync(target) && fs.statSync(target).isDirectory();
  const folder = isDirectory
    ? target
    : path.dirname(path.dirname(path.resolve(target)));
  const fileName = isDirectory ? undefined : path.basename(target);

  const results: RebuildResult[] = [];
  for (const testCase of getTestFiles(folder)) {
    if (
      fileName !== undefined &&
      path.basename(testCase.testFile) !== fileName
    ) {
      continue;
    }
    logger.debug(`Rebuilding ${testCase.testFile}...`);
    results.push(await rebuildOne(testCase));
  }
  if (results.length === 0) {
    logger.debug(`No test files found in ${folder}`);
  }
  return results;
}

async function rebuildOne(testCase: AgentTestCase): Promise<RebuildResult> {
  const {agentDir, testFile} = testCase;
  try {
    const fixture = await readFixture(testFile);
    if (fixture.events.length === 0) {
      return {testFile, status: 'skipped', reason: `No events in ${testFile}`};
    }
    const userMessages = fixture.events
      .map(extractUserContent)
      .filter((content): content is Content => content !== undefined);
    if (userMessages.length === 0) {
      return {
        testFile,
        status: 'skipped',
        reason: `No user messages found in ${testFile}`,
      };
    }
    const entryFile = findAgentEntryFile(agentDir);
    if (!entryFile) {
      return {
        testFile,
        status: 'skipped',
        reason: `No JavaScript or TypeScript agent entry file in ${agentDir}`,
      };
    }

    const agentFile = new AgentFile(entryFile);
    try {
      const runner = new ReplaySessionRunner(rootOf(await agentFile.load()));
      const mapper = new FunctionCallIdMapper(
        recordedFunctionCallIds(fixture.events),
      );

      const rebuilt: Event[] = [];
      for (const [index, message] of userMessages.entries()) {
        mapper.remap(message);
        const userEvent = createEvent({author: 'user', content: message});
        const turn = await runner.run(message);
        mapper.absorb(turn);
        // A rerun that changes nothing must produce no diff, so the invocation
        // id is derived from the turn number rather than left random.
        for (const event of [userEvent, ...turn]) {
          event.invocationId = `i-${index + 1}`;
        }
        rebuilt.push(userEvent, ...turn);
      }

      const data: Record<string, unknown> = {...fixture.data};
      data['events'] = normalizeRebuiltEvents(normalizeIds(rebuilt));
      delete data['lastUpdateTime'];
      await saveToFile(
        testFile,
        `${JSON.stringify(sortKeysDeep(data), null, 2)}\n`,
      );
      return {testFile, status: 'rebuilt'};
    } finally {
      await agentFile.dispose();
    }
  } catch (error: unknown) {
    const reason = errorMessage(error);
    logger.error(`Error rebuilding ${testFile}: ${reason}`);
    return {testFile, status: 'error', reason};
  }
}

/**
 * Builds the model responses the fixture recorded, in the order the agent asks
 * for them.
 *
 * Not every recorded model event came from the model: ADK synthesizes the one
 * that answers a `set_model_response` call, and it raises the workflow
 * human-in-the-loop requests itself.
 *
 * The responses are served positionally, in recording order, so a replay only
 * reproduces a conversation whose model calls happen one at a time — see the
 * guide's Limits section.
 *
 * @param events The recorded events after the opening user turn.
 */
export function buildMockResponses(
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
 * raises rather than a response the model produced.
 *
 * A bare input request at the root of the agent tree IS a model call; only the
 * workflow form, which has a parent segment in its node path, is raised by the
 * framework.
 */
function isFrameworkRequest(event: RecordedEvent, content: Content): boolean {
  const nodePath = event.nodeInfo?.path ?? '';
  return (content.parts ?? []).some((part) => {
    switch (part.functionCall?.name) {
      case REQUEST_CONFIRMATION_FUNCTION_CALL_NAME:
      case REQUEST_CREDENTIAL_FUNCTION_CALL_NAME:
        return true;
      case REQUEST_INPUT_FUNCTION_CALL_NAME:
        return nodePath.includes('/') || nodePath.includes('.');
      default:
        return false;
    }
  });
}

/**
 * Pairs the function call ids a fixture recorded with the ids the live run
 * generates, in call order, so a recorded `functionResponse` answers the call
 * the run actually made.
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

  /** Rewrites the response ids of a recorded user turn, in place. */
  remap(content: Content): void {
    for (const part of content.parts ?? []) {
      const response = part.functionResponse;
      if (response?.id !== undefined) {
        response.id = this.idMap.get(response.id) ?? response.id;
      }
    }
  }
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

/** The text of the fixture's opening turn, when it is a user text turn. */
function openingUserText(event: RecordedEvent): string | undefined {
  if (event.author !== 'user') {
    return undefined;
  }
  return event.content?.parts?.[0]?.text || undefined;
}

async function readFixture(testFile: string): Promise<Fixture> {
  const data = (await loadFileData<Record<string, unknown>>(testFile)) ?? {};
  const events = Array.isArray(data['events']) ? data['events'] : [];
  return {
    data,
    // Only the entries that are objects are events. Their fields are read as
    // recorded: the fixture is a local file written by this module or by the
    // adk-python runner.
    events: events.filter(
      (event): event is RecordedEvent => asJsonObject(event) !== undefined,
    ),
    mocks: asJsonObject(data['mocks']),
  };
}

function rootOf(loaded: RunnableRoot | App): {app?: App; agent?: RunnableRoot} {
  return isApp(loaded) ? {app: loaded} : {agent: loaded};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
