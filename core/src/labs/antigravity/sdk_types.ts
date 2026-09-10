/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A structural description of the Google Antigravity SDK surface this package
 * drives.
 *
 * There is no `@google/antigravity` package on npm, so nothing here can be
 * imported from the SDK. The types below describe the shape an adapter must
 * present instead, and `@google/adk` takes no dependency on the SDK: any object
 * with these members works.
 *
 * Field names are camelCase, the local convention, while enum values are the
 * SDK's own strings (`'TEXT_RESPONSE'`, `'create_or_resume'`) because those are
 * what an adapter puts on the wire.
 */

/** The high-level type of a trajectory step. */
export type AntigravityStepType =
  | 'TEXT_RESPONSE'
  | 'TOOL_CALL'
  | 'SYSTEM_MESSAGE'
  | 'COMPACTION'
  | 'FINISH'
  | 'THINKING'
  | 'UNKNOWN';

/** What produced a trajectory step. */
export type AntigravityStepSource = 'SYSTEM' | 'USER' | 'MODEL' | 'UNKNOWN';

/** The status of a trajectory step. */
export type AntigravityStepStatus =
  | 'ACTIVE'
  | 'DONE'
  | 'WAITING_FOR_USER'
  | 'ERROR'
  | 'CANCELED'
  | 'UNKNOWN';

/**
 * How a connection establishes its conversation.
 *
 * `'create_or_resume'` is the only mode that survives a store that is no longer
 * there; the others make a missing store a hard error.
 */
export type SessionContinuationMode =
  | 'resume'
  | 'create_or_resume'
  | 'create_only';

/** One tool call the Antigravity model issued. */
export interface AntigravityToolCall {
  /** The tool's name. A builtin's name, or a client tool's. */
  name: string;
  /** The call arguments. */
  args?: Record<string, unknown>;
  /** The call id, when the runtime assigned one. */
  id?: string;
}

/** The outcome of one tool call, as the post-tool-call hook receives it. */
export interface AntigravityToolResult {
  /** The name of the tool that ran. */
  name: string;
  /** The id of the call this answers. */
  id?: string;
  /** The tool's return value, as any JSON-serializable value. */
  result?: unknown;
  /** The failure message, when the call failed. */
  error?: string;
}

/**
 * One action in the Antigravity agent's trajectory.
 *
 * Only the fields this package reads are declared; an adapter carrying more of
 * the SDK's step (the trajectory ids, the depth, the target, the structured
 * output) extends this interface with them. Every field is optional where the
 * SDK gives it a default, and the converter reads a missing field as that
 * default (`''`, `0`, `[]`, `'UNKNOWN'`).
 */
export interface AntigravityStep {
  /** The step's position in the trajectory. */
  stepIndex?: number;
  /** What kind of step this is. */
  type?: AntigravityStepType;
  /** What produced the step. */
  source?: AntigravityStepSource;
  /** How the step is progressing. */
  status?: AntigravityStepStatus;
  /** The step's cumulative output. */
  content?: string;
  /** The output added since the previous update of this step. */
  contentDelta?: string;
  /** The reasoning added since the previous update of this step. */
  thinkingDelta?: string;
  /** The tool calls this step carries. */
  toolCalls?: AntigravityToolCall[];
  /** A short failure message, when the step failed. */
  error?: string;
  /**
   * Whether this step is a completed model response to the user, as opposed to
   * a partial streaming chunk.
   */
  isCompleteResponse?: boolean;
}

/**
 * A client-side tool the harness can call.
 *
 * The model reads {@link name} to call it and {@link description} to decide
 * whether to.
 */
export interface AntigravityTool {
  /** The name the model calls this tool by. */
  readonly name: string;
  /** What the tool does. The only thing the model reads when choosing it. */
  readonly description: string;
  /** Runs the tool and answers with its result. */
  run(request: string): Promise<string>;
}

/** A hook reporting the result of a tool call that succeeded. */
export interface PostToolCallHook {
  /** Distinguishes this hook from {@link OnToolErrorHook}. */
  readonly kind: 'post_tool_call';
  /** Receives one successful tool result. */
  run(result: AntigravityToolResult): Promise<void>;
}

/** A hook reporting a tool call that failed. */
export interface OnToolErrorHook {
  /** Distinguishes this hook from {@link PostToolCallHook}. */
  readonly kind: 'on_tool_error';
  /**
   * Receives one tool failure.
   *
   * Returning a string replaces the message the model sees; returning
   * `undefined` leaves the harness's own message in place.
   */
  run(error: unknown): Promise<string | undefined>;
}

/** Either half of the tool-outcome hook pair. */
export type AntigravityHook = PostToolCallHook | OnToolErrorHook;

/** A tool failure carrying the metadata needed to correlate it with its call. */
export interface AntigravityToolExecutionError {
  /** The name of the tool that failed. */
  toolName: string;
  /** The id of the call that failed. */
  callId?: string;
  /** The failure message. */
  message: string;
}

/**
 * Whether `error` carries the tool name and call id a failure must have to be
 * paired with the call it answers.
 *
 * The hook signature is as broad as the SDK declares it, so anything can
 * arrive; only this shape is correlatable.
 */
export function isAntigravityToolExecutionError(
  error: unknown,
): error is AntigravityToolExecutionError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'toolName' in error &&
    typeof error.toolName === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/**
 * The Antigravity agent configuration this package reads and extends.
 *
 * Only the fields this package reads or writes are declared. An adapter that
 * needs more — system instructions, workspaces, policies — extends this
 * interface with them, and they are carried through untouched: the port copies
 * the config and appends to `tools` and `hooks`, and never touches policies,
 * capabilities or workspaces.
 */
export interface AntigravityAgentConfig {
  /** Which backend runs the harness. `'local'` runs it as a subprocess. */
  connection?: string;
  /** The tools the harness may call, by object or by builtin name. */
  tools?: Array<AntigravityTool | string>;
  /** The lifecycle hooks the harness reports to. */
  hooks?: AntigravityHook[];
  /** The conversation to resume. */
  conversationId?: string;
  /** How the connection establishes its conversation. */
  sessionContinuationMode?: SessionContinuationMode;
  /**
   * Where the harness keeps its trajectories.
   *
   * A local config without one mints a fresh temporary directory per
   * connection, so each turn writes somewhere the next turn will not look.
   */
  saveDir?: string;
}

/** An Antigravity configuration that runs the harness as a local subprocess. */
export interface LocalAntigravityAgentConfig extends AntigravityAgentConfig {
  connection: 'local';
}

/**
 * Whether `config` runs the harness locally.
 *
 * A discriminator rather than a class check: there is no SDK class to test
 * against here, and `instanceof` would in any case answer `false` across two
 * copies of one package in a single runtime.
 */
export function isLocalAntigravityConfig(
  config: AntigravityAgentConfig,
): config is LocalAntigravityAgentConfig {
  return config.connection === 'local';
}

/** The parts of an Antigravity `Conversation` that one ADK turn drives. */
export interface SdkConversation {
  /** The steps this conversation already holds. */
  readonly history: readonly AntigravityStep[];
  /** Sends the user's prompt into the conversation. */
  send(prompt: string): Promise<void>;
  /** Streams the steps the harness produces in answer. */
  receiveSteps(): AsyncIterable<AntigravityStep>;
}

/**
 * The parts of an Antigravity `Agent` that one ADK turn runs on.
 *
 * {@link connect} and {@link close} stand in for Python's `__aenter__` and
 * `__aexit__`.
 */
export interface SdkAgent {
  /** The conversation this agent is driving. */
  readonly conversation: SdkConversation;
  /** The id the runtime assigned this conversation, once it has published one. */
  readonly conversationId?: string;
  /** Connects to the harness and returns the connected agent. */
  connect(): Promise<SdkAgent>;
  /** Disconnects, reporting the failure that is unwinding the turn, if any. */
  close(error?: unknown): Promise<void>;
}
