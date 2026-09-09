# load_web_page

`loadWebPage` fetches a URL and returns the readable text of the page. Give it
to an agent when the agent must read a public web page that a search tool only
linked to.

## Introduction

An agent that fetches a URL chosen by a model is a server-side request forgery
(SSRF) risk. The model can name `http://169.254.169.254/`, and the process
would read the cloud metadata endpoint on the agent's behalf. `loadWebPage`
treats the URL as untrusted input and refuses any host that is not globally
routable.

Refusing a host requires resolving it first, and a name can resolve to a
different address the second time. `loadWebPage` therefore resolves the name
once, checks every answer, and then connects to one of those exact addresses.
The `Host` header and the TLS server name still carry the original hostname, so
the origin server sees a normal request.

Two limits are worth knowing before you rely on this. A proxy named by
`http_proxy`, `https_proxy` or `all_proxy` resolves the hostname itself, so on
that path only an IP-literal target is checked locally. A hostname that
resolves to a mix of blocked and public addresses is refused outright.

`loadWebPage` never throws for an expected failure. A bad scheme, a blocked
host, a timeout, a transport error or a non-200 status all return
`Failed to fetch url: <url>`, so a model receives a plain answer instead of an
exception.

## Get started

`LOAD_WEB_PAGE` is a ready-made tool. Add it to an agent:

```ts
import {LlmAgent, LOAD_WEB_PAGE} from '@google/adk';

const agent = new LlmAgent({
  name: 'researcher',
  model: 'gemini-2.5-flash',
  instruction: 'Answer from the pages the user links to.',
  tools: [LOAD_WEB_PAGE],
});
```

Call the function directly when you need the text in your own code:

```ts
import {loadWebPage} from '@google/adk';

const text = await loadWebPage('https://example.com/article');
```

## What the text looks like

The page is parsed as HTML5. Every text node is trimmed and joined with a
newline, in document order. `<script>`, `<style>`, `<noscript>` and comment
content is dropped, so page source does not reach the model. Lines of three
words or fewer are then removed, which drops most navigation and button labels.

## Configuration

`loadWebPage` takes one option:

```ts
const text = await loadWebPage('https://example.com/article', {
  timeoutMs: 5000,
});
```

`timeoutMs` bounds a single connection attempt and defaults to 30000. When a
hostname resolves to several addresses, each attempt gets the full budget.

The `http_proxy`, `https_proxy`, `all_proxy` and `no_proxy` environment
variables are honoured, in the spelling and precedence that `curl` uses. An
uppercase name wins over its lowercase twin. The value must be an `http:` or
`https:` URL; any other value is ignored and the request goes direct. For an
`https:` target the tool opens a `CONNECT` tunnel through the proxy and
validates the certificate against the original hostname.

## What is refused

| Input                                | Reason                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `file:///etc/passwd`                 | Only `http:` and `https:` are fetched.                                                                                              |
| `http://example.com:99999/`          | The port is outside 0-65535.                                                                                                        |
| `http://localhost:8080/`             | `localhost` and `*.localhost` are blocked.                                                                                          |
| `http://169.254.169.254/`            | Link-local, private, loopback, shared and reserved ranges are blocked.                                                              |
| `http://[64:ff9b::169.254.169.254]/` | An IPv6 address that wraps a blocked IPv4 address is blocked. NAT64, 6to4, IPv4-mapped and IPv4-compatible forms are all unwrapped. |
| A redirect to any of the above       | Redirects are never followed; a 3xx status returns the failure string.                                                              |
| A body above 10 MiB                  | The attempt is abandoned to bound memory.                                                                                           |

Every one of these returns `Failed to fetch url: <url>`.
