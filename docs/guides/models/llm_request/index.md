# LlmRequest

`LlmRequest` is the object ADK builds for one model call. A request processor
or a tool receives it, adds an instruction or a tool declaration to it, and the
model implementation turns it into the provider call.

## Introduction

Several contributors write into the same request. Agent processors add the
agent instruction, and each tool adds its function declaration. Each
contributor sees only its own piece, so the request object owns the rules that
keep the result valid for the provider.

Two of those rules matter to anyone writing a tool or a processor.

The Gemini API accepts one system instruction, and it must be a string. Text
instructions are joined with a blank line between them.

The Gemini API also accepts at most one tool that carries function
declarations. A contributor that adds a declaration merges it into the existing
tool rather than adding a second one.

## Get started

A tool declares itself to the model by returning a `FunctionDeclaration`. The
base class writes it into the request for you.

```ts
import {BaseTool, RunAsyncToolRequest} from '@google/adk';
import {FunctionDeclaration, Type} from '@google/genai';

class WeatherTool extends BaseTool {
  constructor() {
    super({name: 'get_weather', description: 'Reads the local forecast.'});
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {city: {type: Type.STRING}},
        required: ['city'],
      },
    };
  }

  async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    return {forecast: `Sunny in ${String(args['city'])}.`};
  }
}
```

Give the tool to an `LlmAgent`. On every turn ADK builds one `LlmRequest` and
calls each tool's `processLlmRequest`. That merges the declaration into the
single `Tool` in `request.config.tools`, and registers the instance in
`request.toolsDict` under its name. Add a second tool and its declaration joins
the same `Tool`, because the Gemini API rejects a request carrying two of them.

Register two tools under one name and the second one wins. ADK logs a warning
naming the tool, because the first tool's declaration is still advertised to
the model while calls reach only the survivor.

## Instructions contributed by a tool

A tool sometimes needs to tell the model something, not only declare itself. It
adds the text through `appendDynamicInstructions` while the request is being
built. `LlmAgent` resolves the accumulator once every tool has run: it joins
the entries with a blank line, appends the result to the system instruction,
and empties the accumulator.

`load_artifacts` and `load_mcp_resource` contribute this way. Both describe a
resource set that only exists at request time, so neither can put its text in
the agent instruction.

Two properties follow from resolving after the tools rather than during them. A
tool does not need to know where instructions end up, so the routing can change
without touching the tool. And the resolution is idempotent, because the
accumulator is empty afterwards, so a second resolution cannot duplicate the
text.

## Failure modes

`config.systemInstruction` is typed `ContentUnion`, so it can already hold a
`Content` or a `Part[]`. ADK cannot append text to those, so it leaves the
value alone and logs a warning instead of stringifying it.
