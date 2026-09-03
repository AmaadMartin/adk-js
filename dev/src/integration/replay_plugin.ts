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
import {isDeepStrictEqual} from 'node:util';
import {loadRecordings} from '../conformance/recordings_loader.js';
import {ReplayConfigError, ReplayVerificationError} from './replay_errors.js';
import {Recording, ToolRecording} from './test_types.js';

export {ReplayConfigError, ReplayVerificationError} from './replay_errors.js';

/** Session state key carrying the replay configuration. */
const REPLAY_CONFIG_STATE_KEY = '_adk_replay_config';

const logger = getLogger();

/** The value stored under {@link REPLAY_CONFIG_STATE_KEY}. */
interface ReplayConfig {
  /** The conformance test case directory to replay. */
  dir: string;
  /** Which turn's recordings this invocation replays. */
  userMessageIndex: number;
  /** Raw value, so an unsupported mode is reported as it was configured. */
  streamingMode: string;
}

/** Replay state for one invocation, so concurrent runs stay isolated. */
interface InvocationReplayState {
  userMessageIndex: number;
  recordings: Recording[];
  /** Agent name to that agent's next tool replay index. */
  agentToolReplayIndices: Map<string, number>;
}

/** Recordings the conformance test runner hands to the constructor. */
interface InjectedRecordings {
  recordings: Recording[];
  context: {userMessageIndex: number};
}

/**
 * Reads the replay configuration, or `undefined` when replay is off.
 *
 * A partial configuration leaves the plugin inert instead of half-enabling
 * replay, matching adk-python's `_is_replay_mode_on`.
 */
function readReplayConfig(context: Context): ReplayConfig | undefined {
  const config = context.state.get<Record<string, unknown>>(
    REPLAY_CONFIG_STATE_KEY,
  );
  const dir = config?.['dir'];
  const userMessageIndex = config?.['userMessageIndex'];
  if (typeof dir !== 'string' || !dir || typeof userMessageIndex !== 'number') {
    return undefined;
  }
  return {
    dir,
    userMessageIndex,
    streamingMode: String(config['streamingMode']),
  };
}

/** The tool recordings this agent may replay, in recorded order. */
function agentToolRecordings(
  state: InvocationReplayState,
  agentName: string,
): ToolRecording[] {
  return state.recordings.flatMap((recording) =>
    recording.agentName === agentName &&
    recording.userMessageIndex === state.userMessageIndex &&
    recording.toolRecording
      ? [recording.toolRecording]
      : [],
  );
}

/** The recorded response for a live call that matches `recording`. */
function verifiedToolResponse(
  recording: ToolRecording,
  toolName: string,
  toolArgs: Record<string, unknown>,
  agentName: string,
  agentIndex: number,
): Record<string, unknown> {
  const recordedCall = recording.toolCall;
  if (recordedCall?.name !== toolName) {
    throw new ReplayVerificationError(
      `Tool name mismatch for agent '${agentName}' at index ${agentIndex}:
recorded: '${recordedCall?.name}'
current: '${toolName}'`,
    );
  }
  const recordedArgs = recordedCall.args ?? {};
  if (!isDeepStrictEqual(recordedArgs, toolArgs)) {
    throw new ReplayVerificationError(
      `Tool args mismatch for agent '${agentName}' at index ${agentIndex}:
recorded: ${JSON.stringify(recordedArgs)}
current: ${JSON.stringify(toolArgs)}`,
    );
  }
  const recordedResponse = recording.toolResponse?.response;
  if (!recordedResponse) {
    throw new ReplayVerificationError(
      `Tool recording for agent '${agentName}' at index ${agentIndex} holds` +
        ` no response for '${toolName}'`,
    );
  }
  return recordedResponse;
}

/**
 * Verifies the live call against the agent's next recording and returns its
 * recorded response.
 *
 * The agent's replay index advances even when verification fails, so a run
 * that already diverged does not re-offer the same recording.
 */
function takeVerifiedToolResponse(
  state: InvocationReplayState,
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Record<string, unknown> {
  const index = state.agentToolReplayIndices.get(agentName) ?? 0;
  const recordings = agentToolRecordings(state, agentName);
  if (index >= recordings.length) {
    throw new ReplayVerificationError(
      `Runtime sent more tool requests than expected for agent '${agentName}'` +
        ` at user_message_index ${state.userMessageIndex}.` +
        ` Expected ${recordings.length}, but got request at index ${index}`,
    );
  }
  state.agentToolReplayIndices.set(agentName, index + 1);
  return verifiedToolResponse(
    recordings[index],
    toolName,
    toolArgs,
    agentName,
    index,
  );
}

/**
 * Replays a recorded conformance run and fails when the run drifts from it.
 *
 * Ported from adk-python's `src/google/adk/cli/plugins/replay_plugin.py`. The
 * plugin accepts two configurations:
 *
 * - Session state. `new ReplayPlugin()` reads `_adk_replay_config` from the
 *   session and loads the recordings from disk itself.
 * - Injected. `new ReplayPlugin(recordings, context)` replays an in-memory
 *   array, which is what `TestRunner` does.
 *
 * Both walk each agent's tool recordings in recorded order and throw
 * {@link ReplayVerificationError} when the live call does not match.
 */
export class ReplayPlugin extends BasePlugin {
  private readonly injected?: InjectedRecordings;
  private readonly invocationStates = new Map<string, InvocationReplayState>();
  /** LLM recordings already replayed, so each is served once. */
  private readonly consumedLlmRecordings = new WeakSet<Recording>();

  constructor();
  constructor(recordings: Recording[], context: {userMessageIndex: number});
  constructor(recordings?: Recording[], context?: {userMessageIndex: number}) {
    super('replay-plugin');
    if (recordings && context) {
      this.injected = {recordings, context};
    }
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const context = new Context({invocationContext});
    const state = await this.buildInvocationState(context);
    if (state) {
      this.invocationStates.set(context.invocationId, state);
      logger.debug(
        `Loaded replay state for invocation ${context.invocationId}:` +
          ` userMessageIndex=${state.userMessageIndex},` +
          ` recordings=${state.recordings.length}`,
      );
    }
    return undefined;
  }

  override async afterRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<void> {
    const {invocationId} = invocationContext;
    if (this.invocationStates.delete(invocationId)) {
      logger.debug(`Cleaned up replay state for invocation ${invocationId}`);
    }
  }

  override async beforeModelCallback({
    callbackContext,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const injected = this.injected;
    if (!injected) {
      // adk-python replays LLM responses from its flow rather than from this
      // plugin, so the session-state mode leaves the model call alone.
      return undefined;
    }

    const agentName = callbackContext.agentName;
    const recording = injected.recordings.find(
      (r) =>
        r.userMessageIndex === injected.context.userMessageIndex &&
        r.agentName === agentName &&
        r.llmRecording?.llmResponse &&
        !this.consumedLlmRecordings.has(r),
    );

    if (!recording) {
      throw new Error(
        `No LLM recording found for agent ${agentName} at turn ${injected.context.userMessageIndex}`,
      );
    }

    this.consumedLlmRecordings.add(recording);
    return recording.llmRecording!.llmResponse!;
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
    if (!this.injected && !readReplayConfig(toolContext)) {
      return undefined;
    }

    const state = this.invocationStates.get(toolContext.invocationId);
    if (!state) {
      throw new ReplayConfigError(
        'Replay state not initialized. Ensure beforeRunCallback created it.',
      );
    }

    const agentName = toolContext.agentName;
    const response = takeVerifiedToolResponse(
      state,
      agentName,
      tool.name,
      toolArgs,
    );

    if (!isAgentTool(tool)) {
      // Only the response is substituted: the tool still runs, so one that
      // mutates EventActions behaves as it did during recording. An AgentTool
      // is the exception, because running it re-drives a sub-agent whose own
      // requests and responses this plugin does not replay.
      await tool.runAsync({args: toolArgs, toolContext});
    }

    logger.debug(
      `Replaying tool response for agent ${agentName}: tool=${tool.name}`,
    );
    return response;
  }

  /** Builds this invocation's replay state, or `undefined` if replay is off. */
  private async buildInvocationState(
    context: Context,
  ): Promise<InvocationReplayState | undefined> {
    if (this.injected) {
      return {
        userMessageIndex: this.injected.context.userMessageIndex,
        recordings: this.injected.recordings,
        agentToolReplayIndices: new Map(),
      };
    }
    const config = readReplayConfig(context);
    if (!config) {
      return undefined;
    }
    const {recordings} = await loadRecordings(config.dir, config.streamingMode);
    return {
      userMessageIndex: config.userMessageIndex,
      recordings,
      agentToolReplayIndices: new Map(),
    };
  }
}
