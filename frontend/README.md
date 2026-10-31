# DiCE-IFC — front end

The Next.js 16 app of [DiCE-IFC](https://github.com/jose-granja/2026-DiCE-IFC).
What it does, how to run it and how to configure it are in the
[repository README](../README.md).

Before changing code, read [`AGENTS.md`](AGENTS.md): the privacy rules every
module follows, the Next.js 16 conventions, and the design notes and pitfalls of
each module.

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck && npm run lint && npm test
npm run test:e2e     # Playwright, against a production build
```
