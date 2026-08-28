# adkToMcpToolType and geminiToJsonSchema

Convert an ADK tool into an MCP tool descriptor, so an MCP server can advertise
ADK tools to any MCP host. Reach for these when you write the server side of
the Model Context Protocol.

## Introduction

Everything else MCP in ADK runs the other way. `MCPTool` and `MCPToolset`
consume a remote MCP server: they read a server's tool list and present each
tool to the model as an ADK tool. These two functions run the ADK to MCP
direction. You keep your tools in ADK, and you publish them over MCP.

`adkToMcpToolType` builds the `Tool` descriptor that an MCP `tools/list`
response carries: a name, a description, and an `inputSchema`. It reads the
tool's own `FunctionDeclaration`, so the schema an MCP host sees is the schema
the model sees. `geminiToJsonSchema` does the schema half of that job. The
`@google/genai` `Schema` type uses the OpenAPI dialect: an upper-case `type`
enum, a `nullable` flag, and stringified length bounds. JSON Schema uses none
of those, so the schema must be translated.

ADK has a second converter in the same direction,
`genaiSchemaToJsonSchema` in `core/src/utils/genai_schema_to_json.ts`. It
answers to a different contract: its output builds a Zod validator, so it
widens `nullable: true` into a `['string', 'null']` type union and drops
`format: 'enum'` and `example`. Use that one to validate a value. Use
`geminiToJsonSchema` to describe a tool to an MCP client.

## Get started

Declare a tool as usual, then convert it.

```typescript
import {FunctionTool, adkToMcpToolType} from '@google/adk';
import {z} from 'zod';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Returns the current weather for a city.',
  parameters: z.object({
    city: z.string().describe('The city to report on.'),
    units: z.enum(['metric', 'imperial']).optional(),
  }),
  execute: ({city}) => `It is sunny in ${city}.`,
});

const descriptor = adkToMcpToolType(getWeather);
```

`descriptor` is:

```json
{
  "name": "get_weather",
  "description": "Returns the current weather for a city.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "city": {"type": "string", "description": "The city to report on."},
      "units": {"type": "string", "enum": ["metric", "imperial"]}
    },
    "required": ["city"]
  }
}
```

Answer a `tools/list` request with it:

```typescript
import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [getWeather].map(adkToMcpToolType),
}));
```

`@modelcontextprotocol/sdk` is an optional peer dependency of `@google/adk`.
Install it to run the code above.

## Schema mapping

`geminiToJsonSchema` takes a genai `Schema` and returns a plain JSON Schema
document. It never changes the schema you pass in.

```typescript
import {geminiToJsonSchema} from '@google/adk';
import {Type} from '@google/genai';

geminiToJsonSchema({
  type: Type.ARRAY,
  items: {type: Type.STRING, maxLength: '32'},
  minItems: '1',
});
// {type: 'array', items: {type: 'string', maxLength: 32}, minItems: 1}
```

| Source                                                         | Result                                        |
| -------------------------------------------------------------- | --------------------------------------------- |
| `type: Type.STRING`                                            | `type: 'string'` — the enum name, lower-cased |
| no `type`, or `Type.TYPE_UNSPECIFIED`                          | `type: 'null'`                                |
| `nullable: true`                                               | `nullable: true`, and `type` is left alone    |
| `nullable: false`                                              | nothing                                       |
| `title`, `description`, `default`, `enum`, `format`, `example` | copied under the same name                    |
| `pattern`, `minLength`, `maxLength`                            | kept only on a `STRING` schema                |
| `minimum`, `maximum`                                           | kept only on a `NUMBER` or `INTEGER` schema   |
| `items`, `minItems`, `maxItems`                                | kept only on an `ARRAY` schema                |
| `properties`, `required`, `minProperties`, `maxProperties`     | kept only on an `OBJECT` schema               |
| `anyOf`                                                        | converted, whatever the `type`                |
| `propertyOrdering`                                             | dropped — it has no JSON Schema meaning       |

The bounds that genai stringifies (`minLength`, `maxLength`, `minItems`,
`maxItems`, `minProperties`, `maxProperties`) become numbers, because JSON
Schema requires numbers. `items`, `properties` and `anyOf` are converted
recursively.

A constraint that does not match the declared type is dropped, not passed
through. `{type: INTEGER, minLength: '2', minimum: 1}` becomes
`{type: 'integer', minimum: 1}`.

## Failure modes

`geminiToJsonSchema` throws a `TypeError` when the argument is not an object.
TypeScript already rejects most bad arguments, so this guard is for JavaScript
callers and for a schema loaded from JSON.

`adkToMcpToolType` throws a `TypeError` when the tool's parameters do not
describe an object. An MCP `inputSchema` must be an object schema, and a client
rejects anything else, so failing here beats sending a broken descriptor. A
document with no `type` at all is treated as an object schema and passes.

```typescript
// Throws: Tool "echo" declares parameters of type "string"; an MCP tool must
// declare an object schema.
adkToMcpToolType(toolWithStringParameters);
```

## Difference from adk-python

adk-python's `adk_to_mcp_tool_type` returns `inputSchema: {}` for a tool that
takes no parameters. The MCP TypeScript SDK types `inputSchema.type` as the
literal `'object'` and its `ToolSchema` validator rejects `{}`, so this port
returns `{type: 'object'}`. An MCP client reads both as the same unconstrained
object.
