# Node.js Version

This project targets **Node.js 20** — specifically 20.19 or newer.

Source: `README.md` line 55, which states "**Prerequisite:** ADK for TypeScript
requires Node.js 20.19 or newer."

Corroborated by `package.json` line 49, which pins `"@types/node": "^20.12.7"`.
Note that neither the root `package.json` nor any workspace package declares an
`engines` field, so the README is the authoritative statement.
