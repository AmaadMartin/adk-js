# PerTurnUserSimulatorQualityV1

`PerTurnUserSimulatorQualityV1` grades the simulated user, not the agent. It
checks that the conversation a user simulator produced kept to its scenario:
the opening turn repeats the starting prompt, every later turn follows the
conversation plan, and the conversation ends when it should. Reach for it
whenever you grade an agent on a scenario-driven eval case, so that a bad score
tells you which side went wrong.

## Introduction

A scenario-driven eval case has no pre-authored user turns. A `UserSimulator`
writes them from a `ConversationScenario` while the case runs, so the
conversation the agent is graded on is itself generated. Every other metric
reads that conversation as given. If the simulator invented a goal, answered a
question the plan never mentioned, or talked past the point where it should
have stopped, the agent is graded against a conversation nobody asked for and
the score means nothing.

This metric closes that hole. It reads the same `ConversationScenario` the
simulator read and grades each user turn against it. Run it beside your agent
metrics on the same eval case: a low simulator-quality score tells you to fix
the scenario or the simulator before you believe anything else the run
reported.

The first turn needs no model, because the starting prompt is fixed and the
turn either repeats it or does not. Every later turn goes to a judge model,
which answers with a critique naming the criteria the turn passed and a final
`is_valid` verdict. Repeated samples of one turn are folded by majority vote,
and a tie counts as invalid.

## Get started

```typescript
import {
  EvalStatus,
  PerTurnUserSimulatorQualityV1,
  type ConversationScenario,
  type Invocation,
} from '@google/adk';

const scenario: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan:
    'Book a one-way flight from SFO to LAX for next Tuesday. You prefer a' +
    ' morning flight and your budget is under $150. Confirm the booking once' +
    ' the agent finds a valid flight.',
};

/** The conversation your eval run recorded, one entry per turn. */
declare const invocations: Invocation[];

async function gradeTheSimulator(): Promise<void> {
  const evaluator = new PerTurnUserSimulatorQualityV1({
    evalMetric: {
      metricName: 'per_turn_user_simulator_quality_v1',
      criterion: {
        threshold: 0.8,
        stopSignal: '</finished>',
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 3},
      },
    },
  });

  const result = await evaluator.evaluateInvocations(
    invocations,
    undefined, // This metric never reads golden invocations.
    scenario,
  );

  if (result.overallEvalStatus !== EvalStatus.PASSED) {
    // `overallScore` is the fraction of turns the judge accepted, so the
    // agent's own scores for this case are not worth reading.
    throw new Error(`simulator quality ${result.overallScore}`);
  }
}
```

The evaluator resolves `judgeModelOptions.judgeModel` through `LLMRegistry`, so
a Gemini judge needs the credentials that model needs. Pass `judgeModel` to
grade with a model you built yourself, or with a fake in a test:

```typescript
import {PerTurnUserSimulatorQualityV1, type BaseLlm} from '@google/adk';

function evaluatorOver(judge: BaseLlm): PerTurnUserSimulatorQualityV1 {
  return new PerTurnUserSimulatorQualityV1({
    evalMetric: {
      metricName: 'per_turn_user_simulator_quality_v1',
      criterion: {threshold: 0.8, judgeModelOptions: {numSamples: 1}},
    },
    judgeModel: judge,
  });
}
```

## The criterion

The criterion is an `LlmBackedUserSimulatorCriterion`. A criterion of any other
shape, or none at all, is rejected by the constructor with an
`InputValidationError`.

| Field                          | Meaning                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `threshold`                    | The fraction of turns that must pass. The same threshold decides each individual turn.                                        |
| `stopSignal`                   | The text a simulated user writes to end the conversation. Defaults to `</finished>`. Set it to whatever your simulator emits. |
| `judgeModelOptions.judgeModel` | The judge. Defaults to `gemini-2.5-flash`.                                                                                    |
| `judgeModelOptions.numSamples` | How many times each turn is judged. Defaults to 5. Zero leaves every later turn `NOT_EVALUATED`.                              |

`judgeModelOptions.parallelismLimit` is read but not honoured here: the samples
are taken one after another, matching adk-python. `LlmAsJudge` does honour it.

## Reading the result

`perInvocationResults` carries exactly one entry per turn in
`actualInvocations`, in order. `overallScore` is the number of turns that
passed divided by the number of turns, and `overallEvalStatus` compares that
fraction against the threshold. An empty conversation is reported as
`NOT_EVALUATED` with no score.

After the per-turn pass, the metric asks the judge one more question: given the
whole conversation, should the simulated user have written the stop signal? A
failure there does not add a result. It replaces the last one, so the turn
where the conversation should have ended is the turn marked failed. Its
`actualInvocation.invocationId` is `stop_signal_proxy_invocation`, which is how
you tell a stop-signal failure from an ordinary one.

## Cost

One judge call per sample per turn, taken sequentially. A conversation of
`n` turns at `numSamples` samples costs `n * numSamples` serial calls: the
`n - 1` later turns plus the stop-signal turn. Lower `numSamples` for a long
conversation.

A judge call that fails is not caught. The rejection propagates out of
`evaluateInvocations`, so a run that loses its judge fails loudly rather than
reporting a score built from fewer samples than you asked for.
