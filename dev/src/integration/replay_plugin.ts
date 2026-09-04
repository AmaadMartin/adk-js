/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BasePlugin,
  BaseTool,
  Context,
  getLogger,
  InvocationContext,
  isAgentTool,
  LlmRequest,
  LlmResponse,
} from '@google/adk';
import {Content} from '@google/genai';
import yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {isFileExists} from '../utils/file_utils.js';
import {
  parseRecordings,
  RecordedToolRecording,
  RecordingsFile,
} from './recordings_schema.js';
import {Recording} from './test_types.js';

/** Session-state key a client writes to turn config-driven replay on. */
export const REPLAY_CONFIG_STATE_KEY = '_adk_replay_config';

const NON_STREAMING_RECORDINGS_FILE = 'generated-recordings.yaml';
const STREAMING_RECORDINGS_FILE = 'generated-recordings-sse.yaml';

const logger = getLogger();

/**
 * The replay configuration a client writes into session state under
 * {@link REPLAY_CONFIG_STATE_KEY}.
 */
export interface ReplayConfig {
  /** Directory holding the recordings file for one conformance test case. */
  dir: string;
  /** Which user message of the case is being replayed. */
  userMessageIndex: number;
  /** Selects which of the two recordings files is authoritative. */
  streamingMode: 'sse' | 'none';
}

/**
 * The configuration as found in session state. The streaming mode stays
 * unchecked here so that an unsupported one is reported with the value read.
 */
interface StateReplayConfig extends Omit<ReplayConfig, 'streamingMode'> {
  streamingMode: unknown;
}

/** One invocation's replay cursors. */
interface InvocationReplayState {
  userMessageIndex: number;
  recordings: RecordingsFile;
  /** Agent name to that agent's next tool replay index. */
  agentToolReplayIndices: Map<string, number>;
}

/** Raised when a replayed run diverges from what was recorded. */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}

/** Whether `e` is a {@link ReplayVerificationError}. */
export function isReplayVerificationError(
  e: unknown,
): e is ReplayVerificationError {
  return e instanceof Error && e.name === 'ReplayVerificationError';
}

/** Raised when the replay configuration or its recordings cannot be used. */
export class ReplayConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReplayConfigError';
    Object.setPrototypeOf(this, ReplayConfigError.prototype);
  }
}

/** Whether `e` is a {@link ReplayConfigError}. */
export function isReplayConfigError(e: unknown): e is ReplayConfigError {
  return e instanceof Error && e.name === 'ReplayConfigError';
}

/**
 * Reads the replay configuration out of a session-state value.
 *
 * @param raw The value stored under {@link REPLAY_CONFIG_STATE_KEY}.
 * @return The configuration, or undefined when replay is off. A configuration
 *     naming no directory or no user message index leaves the plugin inert
 *     rather than half-enabling replay.
 */
function readReplayConfig(raw: unknown): StateReplayConfig | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const config = raw as Record<string, unknown>;
  const dir = config['dir'];
  const userMessageIndex = config['userMessageIndex'];
  if (typeof dir !== 'string' || !dir || typeof userMessageIndex !== 'number') {
    return undefined;
  }
  return {dir, userMessageIndex, streamingMode: config['streamingMode']};
}

/** The recordings file the configured streaming mode makes authoritative. */
function recordingsFileName(streamingMode: unknown): string {
  switch (streamingMode) {
    case 'sse':
      return STREAMING_RECORDINGS_FILE;
    case 'none':
      return NON_STREAMING_RECORDINGS_FILE;
    default:
      throw new Error(`Unsupported streaming mode: ${String(streamingMode)}`);
  }
}

/** Reads and validates the recordings the configuration points at. */
async function loadInvocationState(
  config: StateReplayConfig,
): Promise<InvocationReplayState> {
  const recordingsFile = path.join(
    config.dir,
    recordingsFileName(config.streamingMode),
  );
  if (!(await isFileExists(recordingsFile))) {
    throw new ReplayConfigError(`Recordings file not found: ${recordingsFile}`);
  }
  try {
    const contents = await fs.readFile(recordingsFile, 'utf-8');
    return {
      userMessageIndex: config.userMessageIndex,
      recordings: parseRecordings(yaml.load(contents)),
      agentToolReplayIndices: new Map(),
    };
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new ReplayConfigError(
      `Failed to load recordings from ${recordingsFile}: ${cause}`,
      {cause: e},
    );
  }
}

/**
 * Takes the recording an agent replays next and advances that agent's cursor.
 *
 * The cursor advances before the call is verified, matching adk-python: a
 * mismatch still consumes the recording.
 */
function takeNextToolRecording(
  state: InvocationReplayState,
  agentName: string,
): {recording: RecordedToolRecording; index: number} {
  const index = state.agentToolReplayIndices.get(agentName) ?? 0;
  const agentRecordings = state.recordings.recordings.flatMap((recording) =>
    recording.agentName === agentName &&
    recording.userMessageIndex === state.userMessageIndex &&
    recording.toolRecording
      ? [recording.toolRecording]
      : [],
  );
  if (index >= agentRecordings.length) {
    throw new ReplayVerificationError(
      `Runtime sent more tool requests than expected for agent ` +
        `'${agentName}' at userMessageIndex ${state.userMessageIndex}. ` +
        `Expected ${agentRecordings.length}, but got request at index ${index}`,
    );
  }
  state.agentToolReplayIndices.set(agentName, index + 1);
  return {recording: agentRecordings[index], index};
}

/** Checks that the live tool call is exactly the one that was recorded. */
function verifyToolCallMatch(
  recordedCall: RecordedToolRecording['toolCall'],
  toolName: string,
  toolArgs: Record<string, unknown>,
  agentName: string,
  agentIndex: number,
): void {
  if (recordedCall?.name !== toolName) {
    throw new ReplayVerificationError(
      `Tool name mismatch for agent '${agentName}' at index ${agentIndex}:
recorded: '${recordedCall?.name}'
current: '${toolName}'`,
    );
  }
  if (!isDeepStrictEqual(recordedCall.args, toolArgs)) {
    throw new ReplayVerificationError(
      `Tool args mismatch for agent '${agentName}' at index ${agentIndex}:
recorded: ${JSON.stringify(recordedCall.args)}
current: ${JSON.stringify(toolArgs)}`,
    );
  }
}

/**
 * Replays recorded agent interactions.
 *
 * The plugin has two modes. Constructed with recordings it replays them
 * directly, which is what `TestRunner` does. Constructed with no arguments it
 * reads {@link ReplayConfig} out of session state, loads the recordings itself
 * and verifies every tool call against them, which is the mode adk-python's
 * `ReplayPlugin` provides. With neither, the plugin stays inert.
 */
export class ReplayPlugin extends BasePlugin {
  private readonly invocationStates = new Map<string, InvocationReplayState>();

  constructor();
  constructor(recordings: Recording[], context: {userMessageIndex: number});
  constructor(
    private recordings?: Recording[],
    private context?: {userMessageIndex: number},
  ) {
    super('replay-plugin');
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    if (this.recordings) {
      return undefined;
    }
    const config = readReplayConfig(
      invocationContext.session.state[REPLAY_CONFIG_STATE_KEY],
    );
    if (!config) {
      return undefined;
    }
    const state = await loadInvocationState(config);
    this.invocationStates.set(invocationContext.invocationId, state);
    logger.debug(
      `Loaded replay state for invocation ${invocationContext.invocationId}: ` +
        `dir=${config.dir}, userMessageIndex=${config.userMessageIndex}, ` +
        `recordings=${state.recordings.recordings.length}`,
    );
    return undefined;
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    if (this.invocationStates.delete(invocationContext.invocationId)) {
      logger.debug(
        `Cleaned up replay state for invocation ${invocationContext.invocationId}`,
      );
    }
  }

  override async beforeModelCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const {recordings, context} = this;
    if (!recordings || !context) {
      // Config mode replays tools only; adk-python's ReplayPlugin has no model
      // callback, and its recordings hold a list of responses rather than one.
      return undefined;
    }
    const agentName = callbackContext.agentName;
    const index = recordings.findIndex(
      (r) =>
        r.userMessageIndex === context.userMessageIndex &&
        r.agentName === agentName &&
        r.llmRecording?.llmResponse &&
        // replay internal flag to mark event as consumed
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No LLM recording found for agent ${agentName} at turn ${context.userMessageIndex}`,
      );
    }

    const rec = recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    return rec.llmRecording!.llmResponse!;
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const {recordings, context} = this;
    if (!recordings || !context) {
      return this.replayFromConfig(params);
    }
    const agentName = params.toolContext.invocationContext.agent?.name ?? '';
    const toolName = params.tool.name;

    const index = recordings.findIndex(
      (r) =>
        r.userMessageIndex === context.userMessageIndex &&
        r.agentName === agentName &&
        r.toolRecording?.toolCall?.name === toolName &&
        !(r as unknown as {_consumed: boolean})._consumed,
    );

    if (index === -1) {
      throw new Error(
        `No tool recording found for agent ${agentName}, tool ${toolName} at turn ${context.userMessageIndex}`,
      );
    }

    const rec = recordings[index];
    (rec as unknown as {_consumed: boolean})._consumed = true;

    // Handle side effects for built-in tools that modify EventActions
    if (toolName === 'transfer_to_agent') {
      params.toolContext.actions.transferToAgent = params.toolArgs[
        'agentName'
      ] as string;
    }

    // The response from a tool call is a plain object.
    const response = rec.toolRecording!.toolResponse!.response;
    if (response instanceof Map) {
      return Object.fromEntries(response);
    }
    return response;
  }

  /**
   * Verifies one tool call against the recordings loaded for its invocation,
   * runs the real tool, and substitutes the recorded response.
   */
  private async replayFromConfig(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const {tool, toolArgs, toolContext} = params;
    if (!readReplayConfig(toolContext.state.get(REPLAY_CONFIG_STATE_KEY))) {
      return undefined;
    }
    const state = this.invocationStates.get(toolContext.invocationId);
    if (!state) {
      throw new ReplayConfigError(
        'Replay state not initialized. Ensure beforeRunCallback created it.',
      );
    }
    const agentName = toolContext.agentName;
    const {recording, index} = takeNextToolRecording(state, agentName);
    verifyToolCallMatch(
      recording.toolCall,
      tool.name,
      toolArgs,
      agentName,
      index,
    );

    // adk-python does not replay an AgentTool's own request and response, so
    // running it would drive a sub-agent that has no recordings of its own.
    if (!isAgentTool(tool)) {
      await tool.runAsync({args: toolArgs, toolContext});
    }

    const response = recording.toolResponse?.response;
    if (response === undefined) {
      throw new ReplayConfigError(
        `Recorded call to '${tool.name}' for agent '${agentName}' at index ` +
          `${index} has no response`,
      );
    }
    logger.debug(
      `Verified and replaying tool response for agent ${agentName}: tool=${tool.name}`,
    );
    return response;
  }
}
