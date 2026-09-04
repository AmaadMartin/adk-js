/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  InvocationContext,
  LlmRequest,
  LlmResponse,
  StreamingMode,
} from '@google/adk';
import {Content} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {toCamelKeys, writeYamlFile} from '../conformance/yaml_writer.js';
import {isFileExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {Recording, Recordings, ToolRecording} from './test_types.js';

const logger = new AdkLogger({label: 'Recording', colorize: {all: true}});

/** Session-state key the conformance recorder writes. */
const RECORDINGS_CONFIG_KEY = '_adk_recordings_config';

const STATE_NOT_INITIALIZED =
  'Recording state not initialized. Ensure beforeRunCallback created it.';

/**
 * The recorder's configuration, as it appears in session state.
 *
 * Keys are snake_case because this is a cross-process, cross-SDK contract:
 * adk-python's conformance client writes exactly these names, and a fixture
 * recorded by either SDK has to be readable by the other.
 */
interface RecordingsConfig {
  dir?: string;
  user_message_index?: number;
  streaming_mode?: string;
}

/** A {@link RecordingsConfig} that carries everything the plugin needs. */
interface ActiveRecordingsConfig {
  dir: string;
  userMessageIndex: number;
  streamingMode: string;
}

/** An LLM recording the plugin opened and is appending responses to. */
interface PendingLlmRecording {
  kind: 'llm';
  recording: Recording;
  responses: LlmResponse[];
}

/** A tool recording the plugin opened and is awaiting the result for. */
interface PendingToolRecording {
  kind: 'tool';
  recording: Recording;
  toolRecording: ToolRecording;
}

type PendingRecording = PendingLlmRecording | PendingToolRecording;

/** Per-invocation recording state, so concurrent runs stay isolated. */
interface InvocationRecordingState {
  userMessageIndex: number;
  recordingsFile: string;
  records: Recordings;
  /** Pending LLM recordings, keyed by agent name. */
  pendingLlmRecordings: Map<string, PendingLlmRecording>;
  /** Pending tool recordings, keyed by function call id. */
  pendingToolRecordings: Map<string, PendingToolRecording>;
  /** Every pending recording, in the order the plugin opened it. */
  pendingRecordingsOrder: PendingRecording[];
}

/**
 * Records what the model and the tools returned during a conformance run.
 *
 * The plugin is inert until session state carries a
 * `_adk_recordings_config` entry naming the test case directory and the index
 * of the user message being recorded. The recorder drives the agent over HTTP
 * against a running API server, so session state is the only channel it has to
 * reach the plugin.
 *
 * Every invocation gets its own state, keyed by invocation id, so two runs
 * sharing one plugin instance do not interleave. `afterRunCallback` appends the
 * complete recordings to whatever the fixture already held and rewrites it.
 */
export class RecordingPlugin extends BasePlugin {
  private readonly invocationStates = new Map<
    string,
    InvocationRecordingState
  >();

  constructor(name = 'adk_recordings') {
    super(name);
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const context = new Context({invocationContext});
    const config = readRecordingsConfig(context);
    if (!config) {
      return undefined;
    }

    this.invocationStates.set(
      context.invocationId,
      await createInvocationState(config),
    );
    logger.debug(
      `Created recording state for invocation ${context.invocationId}`,
    );
    return undefined;
  }

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (!readRecordingsConfig(callbackContext)) {
      return undefined;
    }
    const state = this.requireState(callbackContext);

    const agentName = callbackContext.agentName;
    const responses: LlmResponse[] = [];
    const pending: PendingLlmRecording = {
      kind: 'llm',
      recording: {
        userMessageIndex: state.userMessageIndex,
        agentName,
        llmRecording: {llmRequest, llmResponses: responses},
      },
      responses,
    };
    state.pendingLlmRecordings.set(agentName, pending);
    state.pendingRecordingsOrder.push(pending);

    logger.debug(`Created pending LLM recording for agent ${agentName}`);
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    if (!readRecordingsConfig(callbackContext)) {
      return undefined;
    }
    const state = this.requireState(callbackContext);

    const agentName = callbackContext.agentName;
    const pending = state.pendingLlmRecordings.get(agentName);
    if (!pending) {
      logger.warn(
        `No pending LLM recording found for agent ${agentName}, skipping response`,
      );
      return undefined;
    }

    pending.responses.push(llmResponse);
    // A streaming turn arrives as a run of partial responses followed by a
    // final one. Keeping the recording open until the final response lands
    // collects the whole turn into a single recording.
    if (!llmResponse.partial) {
      state.pendingLlmRecordings.delete(agentName);
    }
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolArgs,
    toolContext,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    if (!readRecordingsConfig(toolContext)) {
      return undefined;
    }

    const functionCallId = toolContext.functionCallId;
    if (!functionCallId) {
      logger.warn(
        `No functionCallId provided for tool ${tool.name}, skipping recording`,
      );
      return undefined;
    }
    const state = this.requireState(toolContext);

    const toolRecording: ToolRecording = {
      toolCall: {id: functionCallId, name: tool.name, args: toolArgs},
    };
    const pending: PendingToolRecording = {
      kind: 'tool',
      recording: {
        userMessageIndex: state.userMessageIndex,
        agentName: toolContext.agentName,
        toolRecording,
      },
      toolRecording,
    };
    state.pendingToolRecordings.set(functionCallId, pending);
    state.pendingRecordingsOrder.push(pending);

    logger.debug(
      `Created pending tool recording for tool ${tool.name}, id ${functionCallId}`,
    );
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    if (!readRecordingsConfig(toolContext)) {
      return undefined;
    }

    const functionCallId = toolContext.functionCallId;
    if (!functionCallId) {
      logger.warn(
        `No functionCallId provided for tool ${tool.name} result, skipping completion`,
      );
      return undefined;
    }
    const state = this.requireState(toolContext);

    const pending = state.pendingToolRecordings.get(functionCallId);
    state.pendingToolRecordings.delete(functionCallId);
    if (!pending) {
      logger.warn(
        `No pending tool recording found for id ${functionCallId}, skipping result`,
      );
      return undefined;
    }

    pending.toolRecording.toolResponse = {
      id: functionCallId,
      name: tool.name,
      response: result,
    };
    logger.debug(
      `Completed tool recording for tool ${tool.name}, id ${functionCallId}`,
    );
    return undefined;
  }

  /**
   * Validates the invocation state and logs the error.
   *
   * The recording schema has no place for a tool error, so nothing is
   * recorded here.
   */
  override async onToolErrorCallback({
    tool,
    toolContext,
    error,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    error: Error;
  }): Promise<Record<string, unknown> | undefined> {
    if (!readRecordingsConfig(toolContext)) {
      return undefined;
    }
    this.requireState(toolContext);

    logger.debug(`Tool error for tool ${tool.name}: ${error.message}`);
    return undefined;
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    const context = new Context({invocationContext});
    if (!readRecordingsConfig(context)) {
      return;
    }
    const state = this.requireState(context);

    try {
      for (const pending of state.pendingRecordingsOrder) {
        if (isComplete(pending)) {
          state.records.recordings.push(pending.recording);
        } else {
          logger.warn(
            `Incomplete ${pending.kind} recording for agent ${pending.recording.agentName}, skipping`,
          );
        }
      }

      await writeYamlFile(state.recordingsFile, state.records);
      logger.info(
        `Saved ${state.records.recordings.length} recordings to ${state.recordingsFile}`,
      );
    } catch (e: unknown) {
      logger.error(`Failed to save interactions: ${errorMessage(e)}`);
    } finally {
      this.invocationStates.delete(context.invocationId);
    }
  }

  private requireState(context: Context): InvocationRecordingState {
    const state = this.invocationStates.get(context.invocationId);
    if (!state) {
      throw new Error(STATE_NOT_INITIALIZED);
    }
    return state;
  }
}

/**
 * Reads the recorder's configuration out of session state.
 *
 * Returns `undefined` when recording is off, which is any state that does not
 * name both a directory and a user message index.
 */
function readRecordingsConfig(
  context: Context,
): ActiveRecordingsConfig | undefined {
  const config = context.state.get<RecordingsConfig>(RECORDINGS_CONFIG_KEY);
  if (!config?.dir || typeof config.user_message_index !== 'number') {
    return undefined;
  }
  return {
    dir: config.dir,
    userMessageIndex: config.user_message_index,
    streamingMode: config.streaming_mode ?? '',
  };
}

async function createInvocationState(
  config: ActiveRecordingsConfig,
): Promise<InvocationRecordingState> {
  const recordingsFile = recordingsFilePath(config.dir, config.streamingMode);
  return {
    userMessageIndex: config.userMessageIndex,
    recordingsFile,
    records: await loadRecordings(recordingsFile),
    pendingLlmRecordings: new Map(),
    pendingToolRecordings: new Map(),
    pendingRecordingsOrder: [],
  };
}

/** Names the fixture the given streaming mode reads and writes. */
function recordingsFilePath(dir: string, streamingMode: string): string {
  switch (streamingMode) {
    case StreamingMode.SSE:
      return path.join(dir, 'generated-recordings-sse.yaml');
    case StreamingMode.NONE:
      return path.join(dir, 'generated-recordings.yaml');
    default:
      throw new Error(`Unsupported streaming mode: ${streamingMode}`);
  }
}

/**
 * Reads the recordings already in `file`, so that recording one user message
 * does not erase the messages recorded before it.
 *
 * A fixture that cannot be read is reported and replaced by an empty set: the
 * run that is regenerating it must not abort because the old copy is corrupt.
 */
async function loadRecordings(file: string): Promise<Recordings> {
  if (!(await isFileExists(file))) {
    return {recordings: []};
  }
  try {
    return readRecordings(
      toCamelKeys(yaml.load(await fs.readFile(file, 'utf-8'))),
    );
  } catch (e: unknown) {
    logger.error(`Failed to load recordings from ${file}: ${errorMessage(e)}`);
    return {recordings: []};
  }
}

/**
 * Narrows a parsed fixture to {@link Recordings}.
 *
 * A mapping with no `recordings` key holds no recordings. adk-python writes
 * exactly that — `dump_pydantic_to_yaml` drops a field still at its default,
 * and `Recordings.recordings` defaults to an empty list — so an empty fixture
 * it produced is the document `{}`.
 */
function readRecordings(parsed: unknown): Recordings {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Recordings file must be a YAML mapping');
  }
  const recordings = 'recordings' in parsed ? parsed.recordings : [];
  if (!Array.isArray(recordings)) {
    throw new Error('The recordings key of a recordings file must be a list');
  }
  return {recordings: recordings as Recording[]};
}

/** Whether `pending` holds the entry a fixture recording needs. */
function isComplete(pending: PendingRecording): boolean {
  return pending.kind === 'llm'
    ? pending.responses.length > 0
    : pending.toolRecording.toolResponse !== undefined;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
