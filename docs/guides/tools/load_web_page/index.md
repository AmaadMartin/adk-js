# loadWebPage

Fetches a URL and returns the readable text of the page. Reach for it when an
agent must read a public web page, and you want the fetch to be safe to hand to
a model.

## Introduction

A model chooses the URL, so the URL is attacker-influenced. A naive fetch tool
therefore lets a prompt reach anything the agent's host can reach: the cloud
metadata endpoint, a database admin port on `localhost`, an internal service on
a private address. This class of bug is Server-Side Request Forgery (SSRF).

`loadWebPage` closes that path in three steps. It rejects any scheme other than
`http` and `https`, and rejects `localhost` and `*.localhost`. It rejects an
address that is not globally routable, including an IPv6 address that wraps a
non-global IPv4 target — `64:ff9b::169.254.169.254` reaches the metadata
endpoint on a network with NAT64. It then pins the connection to an address that
passed vetting, so the name cannot resolve to something else between the check
and the connection.

Two properties follow from pinning at the socket layer rather than rewriting the
URL to the IP: the `Host` header and the TLS certificate check still use the
hostname the caller wrote. Redirects are never followed, because a redirect is a
second URL that the first one chose.

The tool never throws. Every failure returns `Failed to fetch url: <url>`, so a
model always receives a value it can act on.

## Get started

```ts
import {LlmAgent, LOAD_WEB_PAGE, loadWebPage} from '@google/adk';

// Call it directly.
const text = await loadWebPage('https://example.com/');

// Or let the model call it.
const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-flash-latest',
  instruction: 'Answer questions by reading the pages the user names.',
  tools: [LOAD_WEB_PAGE],
});
```

## Choosing between the two vetting paths

Address vetting needs a local DNS resolution, and a proxy resolves the name
remotely instead. The two cannot both hold, so the choice is explicit:

|                   | Direct (default)    | With `proxy`                      |
| ----------------- | ------------------- | --------------------------------- |
| Hostname target   | resolved and vetted | not vetted; the proxy resolves it |
| IP-literal target | vetted              | vetted                            |
| `localhost` names | rejected            | rejected                          |

`loadWebPage` never reads `http_proxy`, `https_proxy` or `no_proxy`. An
environment variable is machine-wide, and a machine-wide setting must not be
able to switch vetting off for every caller on the host. Pass the proxy per
call, and only for a call whose URL you trust:

```ts
await loadWebPage('https://internal.example/', {
  proxy: process.env['HTTPS_PROXY'],
});
```

An `http` target goes to the proxy in absolute form. An `https` target opens a
`CONNECT` tunnel and runs TLS inside it. A `socks5://` proxy is not supported.

`LOAD_WEB_PAGE`, the tool the model calls, takes no options, so a model-chosen
URL always follows the vetted direct path.

## Limits

The body is read into memory and is capped at 10 MiB; a larger response returns
the failure string rather than a truncated page. Entity decoding covers `&amp;`,
`&apos;`, `&gt;`, `&lt;`, `&nbsp;`, `&quot;` and the numeric forms (`&#8212;`,
`&#x2014;`); other named entities are left as written.

The tool needs Node built-ins (`node:http`, `node:https`, `node:dns`), so it
does not run in a browser bundle.
