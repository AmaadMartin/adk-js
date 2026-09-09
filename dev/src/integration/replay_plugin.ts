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
import {Content, FunctionCall} from '@google/genai';
import {isDeepStrictEqual} from 'node:util';
import {loadRecordings, recordingsFilePath} from './recordings_loader.js';
import {ReplayConfigError, ReplayVerificationError} from './replay_errors.js';
import {Recording, ToolRecording} from './test_types.js';

export {
  isReplayConfigError,
  isReplayVerificationError,
  ReplayConfigError,
  ReplayVerificationError,
} from './replay_errors.js';

/** Session-state key a client writes to turn replay on for an invocation. */
const REPLAY_CONFIG_STATE_KEY = '_adk_replay_config';

/** The built-in tool whose recorded call also moves the agent. */
const TRANSFER_TO_AGENT_TOOL = 'transfer_to_agent';

const logger = getLogger();

/**
 * The replay config, as read out of session state. A client writes it as a
 * state delta, which nothing camelCases on the way in, so the keys are the
 * snake_case ones adk-python's conformance client writes.
 */
interface ReplayConfig {
  dir: string;
  userMessageIndex: number;
  /** Kept as read, so an unsupported mode is reported as configured. */
  streamingMode: string;
}

/** One invocation's replay cursor. */
interface InvocationReplayState {
  userMessageIndex: number;
  recordings: Recording[];
  /** Agent name to that agent's next tool replay index. */
  agentToolReplayIndices: Map<string, number>;
}

/** A recording carrying the plugin's own consumption marker. */
interface ConsumableRecording extends Recording {
  consumed?: boolean;
}

/**
 * Reads the replay config out of a session-state value.
 *
 * @returns undefined when replay is off. A config naming no directory or no
 *     user message index leaves the plugin inert rather than half-enabling
 *     replay.
 */
function readReplayConfig(raw: unknown): ReplayConfig | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const config: Record<string, unknown> = {...raw};
  const dir = config['dir'];
  const userMessageIndex = config['user_message_index'];
  if (typeof dir !== 'string' || !dir || typeof userMessageIndex !== 'number') {
    return undefined;
  }
  return {
    dir,
    userMessageIndex,
    streamingMode: String(config['streaming_mode']),
  };
}

/** The tool recordings this agent replays, in recorded order. */
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

function verifyToolCall(
  recordedCall: FunctionCall | undefined,
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
 * Takes the agent's next tool recording and checks the live call against it.
 *
 * The index advances even when verification then fails, so a diverged run does
 * not re-offer the same recording.
 *
 * @throws ReplayVerificationError when the agent calls past the end of its
 *     recordings, or calls a different tool, or calls with different arguments.
 */
function verifyAndTakeNextToolRecording(
  state: InvocationReplayState,
  agentName: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): ToolRecording {
  const agentIndex = state.agentToolReplayIndices.get(agentName) ?? 0;
  const recordings = agentToolRecordings(state, agentName);
  if (agentIndex >= recordings.length) {
    throw new ReplayVerificationError(
      `Runtime sent more tool requests than expected for agent ` +
        `'${agentName}' at user_message_index ${state.userMessageIndex}. ` +
        `Expected ${recordings.length}, but got request at index ${agentIndex}`,
    );
  }
  state.agentToolReplayIndices.set(agentName, agentIndex + 1);
  const recording = recordings[agentIndex];
  verifyToolCall(recording.toolCall, toolName, toolArgs, agentName, agentIndex);
  return recording;
}

/**
 * Replays a recorded conformance run and verifies it against the recordings.
 *
 * The plugin runs in either of two modes:
 *
 * - **Injected**: the caller passes the recordings and the current user message
 *   index to the constructor. `TestRunner` uses this.
 * - **Session state**: a client writes `_adk_replay_config` into session state,
 *   naming the case directory, the user message index and the streaming mode.
 *   The plugin then loads the fixtures itself, once per invocation.
 *
 * With neither, the plugin is inert.
 *
 * Tool replay is strict. Each agent replays its own recordings for the
 * configured user message, in recorded order, and a divergence raises
 * {@link ReplayVerificationError}. The underlying tool still runs, so replay
 * exercises the tool's own code path; only its response is substituted.
 */
export class ReplayPlugin extends BasePlugin {
  /** Replay state per invocation id, so concurrent runs stay isolated. */
  private readonly invocationStates = new Map<string, InvocationReplayState>();

  /** The injected mode's cursor, rebuilt when the user message changes. */
  private injectedState?: InvocationReplayState;

  constructor(
    private recordings?: ConsumableRecording[],
    private context?: {userMessageIndex: number},
  ) {
    super('replay-plugin');
  }

  override async beforeRunCallback({
    invocationContext,
  }: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    const config = readReplayConfig(
      invocationContext.session.state[REPLAY_CONFIG_STATE_KEY],
    );
    if (!config) {
      return undefined;
    }
    const {recordings} = await loadRecordings(
      recordingsFilePath(config.dir, config.streamingMode),
    );
    this.invocationStates.set(invocationContext.invocationId, {
      userMessageIndex: config.userMessageIndex,
      recordings,
      agentToolReplayIndices: new Map(),
    });
    logger.debug(
      `Loaded replay state for invocation ${invocationContext.invocationId}: ` +
        `dir=${config.dir}, userMessageIndex=${config.userMessageIndex}, ` +
        `recordings=${recordings.length}`,
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
      return undefined;
    }
    const agentName = callbackContext.agentName;
    const index = recordings.findIndex(
      (r) =>
        r.userMessageIndex === context.userMessageIndex &&
        r.agentName === agentName &&
        r.llmRecording?.llmResponse &&
        !r.consumed,
    );

    if (index === -1) {
      throw new Error(
        `No LLM recording found for agent ${agentName} at turn ${context.userMessageIndex}`,
      );
    }

    const rec = recordings[index];
    rec.consumed = true;

    return rec.llmRecording!.llmResponse!;
  }

  override async beforeToolCallback(params: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
  }): Promise<Record<string, unknown> | undefined> {
    const state = this.replayStateFor(params.toolContext);
    if (!state) {
      return undefined;
    }
    const agentName = params.toolContext.invocationContext.agent?.name ?? '';
    const recording = verifyAndTakeNextToolRecording(
      state,
      agentName,
      params.tool.name,
      params.toolArgs,
    );

    // Replaying a sub-agent's own requests and responses is unimplemented on
    // both SDKs, so an AgentTool is verified and replayed but not run.
    if (!isAgentTool(params.tool)) {
      await params.tool.runAsync({
        args: params.toolArgs,
        toolContext: params.toolContext,
      });
    }
    const target = params.toolArgs['agentName'];
    if (
      params.tool.name === TRANSFER_TO_AGENT_TOOL &&
      typeof target === 'string'
    ) {
      params.toolContext.actions.transferToAgent = target;
    }

    logger.debug(
      `Verified and replaying tool response for agent ${agentName}: tool=${params.tool.name}`,
    );
    return recording.toolResponse?.response ?? {};
  }

  /**
   * The replay cursor this tool call reads from, or undefined when replay is
   * off.
   *
   * @throws ReplayConfigError when session state turns replay on but
   *     `beforeRunCallback` did not load the fixtures for this invocation.
   */
  private replayStateFor(context: Context): InvocationReplayState | undefined {
    if (!readReplayConfig(context.state.get(REPLAY_CONFIG_STATE_KEY))) {
      return this.injectedReplayState();
    }
    const state = this.invocationStates.get(context.invocationId);
    if (!state) {
      throw new ReplayConfigError(
        'Replay state not initialized. Ensure before_run created it.',
      );
    }
    return state;
  }

  /**
   * One plugin instance spans every user message in the injected mode, so the
   * cursor resets when the caller moves to the next message.
   */
  private injectedReplayState(): InvocationReplayState | undefined {
    const {recordings, context} = this;
    if (!recordings || !context) {
      return undefined;
    }
    if (this.injectedState?.userMessageIndex !== context.userMessageIndex) {
      this.injectedState = {
        userMessageIndex: context.userMessageIndex,
        recordings,
        agentToolReplayIndices: new Map(),
      };
    }
    return this.injectedState;
  }
}
