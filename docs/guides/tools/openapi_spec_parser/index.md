# OpenApiSpecParser

Reads an OpenAPI v3 document and returns one `ParsedOperation` per operation.
Reach for it when you want the parsed operations themselves — to filter them,
rename them, or read a response schema — instead of the finished toolset that
`OpenAPIToolset` builds.

## Introduction

`OpenAPIToolset` is the high-level path: it parses a specification and hands
you `RestApiTool` instances an agent can call. `OpenApiSpecParser` is the layer
below it. It does the reading and gives you the intermediate result, so you can
inspect or change an operation before a tool exists for it.

`parse` runs three steps over the document. It resolves every internal `$ref`,
it drops schema types that Gemini function calling does not accept, and it
walks the paths to build one `ParsedOperation` per method. The result matches
what adk-python's `OpenApiSpecParser` produces for the same document, so a
name, a parameter list or a response schema you read in one SDK is the same in
the other.

The parser handles only internal references. A `$ref` that does not start with
`#` throws `External references not supported`, so resolve or inline an
external document before you parse it.

## Get started

```ts
import {OpenApiSpecParser} from '@google/adk';

const petResponse = {
  '200': {
    description: 'A pet.',
    content: {'application/json': {schema: {$ref: '#/components/schemas/Pet'}}},
  },
};

const operations = new OpenApiSpecParser().parse({
  openapi: '3.0.0',
  info: {title: 'Pet Store', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  paths: {
    '/pets/{petId}': {
      get: {
        summary: 'Read one pet.',
        parameters: [
          {name: 'petId', in: 'path', required: true, schema: {type: 'string'}},
        ],
        responses: petResponse,
      },
    },
    '/pets/featured': {
      get: {summary: 'Read the featured pet.', responses: petResponse},
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        properties: {id: {type: 'string'}, name: {type: 'string'}},
      },
    },
  },
});

const [pet, featured] = operations;

pet.name; // 'pets_pet_id_get'
pet.endpoint.baseUrl; // 'https://api.example.com'
pet.parameters[0].name; // 'pet_id'
pet.returnValue?.paramSchema.properties?.name; // {type: 'string'}
pet.additionalContext; // {}
```

## What parse gives you

**A name for every operation.** An operation that declares an `operationId`
keeps it. An operation that omits one gets a name built from its path and its
method, in snake_case: `/pets/{petId}` with `get` becomes `pets_pet_id_get`.
adk-python builds the same name from the same document.

**The response schema, in `returnValue`.** The parser reads the lowest 2xx
response of the operation and takes the schema of its first media type. When
the operation declares no 2xx response, or that response carries no usable
schema, `paramSchema` is an empty object rather than absent. References inside
the response are already resolved, so you read the schema itself and not a
`$ref`.

**A place to put your own data, in `additionalContext`.** The parser
initialises it to `{}`. Nothing in the toolset reads it; it is yours to fill
before you build a tool, and it survives to whatever reads the
`ParsedOperation`.

**One subtree per use of a reference.** Two operations that reference the same
schema each get their own copy of it, so an edit to one operation's resolved
schema does not reach the other.

```ts
pet.returnValue!.paramSchema.properties!.name = {type: 'integer'};

featured.returnValue!.paramSchema.properties!.name; // still {type: 'string'}
```

## Naming a parameter

`OpenApiSpecParser` names an operation with the same algorithm adk-python
uses. It does **not** use that algorithm for parameter names: a parameter is
snake_cased by inserting an underscore before each uppercase letter, so
`petId` becomes `pet_id` but `pet.id` stays `pet.id`. Pass
`{preservePropertyNames: true}` to the constructor to keep the original name
from the document instead.
