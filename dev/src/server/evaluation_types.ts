import {Content} from '@google/genai';

export interface Invocation {
  invocationId: string;
  userContent: Content;
  finalResponse?: Content;
  intermediateData?: Record<string, unknown>; // To store tool calls and responses, if any.
  creationTimestamp: number;
}

export interface SessionInput {
  appName: string;
  userId: string;
  state: Record<string, unknown>;
}

export interface EvalCase {
  evalId: string;
  conversation?: Invocation[];
  // If we support UserSimulator later, we can add conversationScenario.
  // For now, conversation is required.
  sessionInput?: SessionInput;
  creationTimestamp: number;
  // rubrics?: any[];
  // finalSessionState?: Record<string, any>;
}

export interface EvalSet {
  evalSetId: string;
  name: string;
  creationTimestamp: number;
  evalCases: EvalCase[];
  description?: string;
}

export interface EvalCaseResult {
  evalSetFile: string;
  evalSetId: string;
  evalId: string;
  finalEvalStatus: 'PASSED' | 'FAILED' | 'NOT_EVALUATED';
  overallEvalMetricResults: unknown[];
  evalMetricResultPerInvocation: unknown[];
  sessionId: string;
  sessionDetails?: Record<string, unknown>;
  userId: string;
}

export interface EvalSetResult {
  evalSetResultId: string;
  evalSetResultName: string;
  evalSetId: string;
  evalCaseResults: EvalCaseResult[];
  creationTimestamp: number;
}
