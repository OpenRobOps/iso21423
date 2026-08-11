# @openrobops/iso21423 — TypeScript SDK

TypeScript SDK implementing **ISO 21423** (Industrial mobile robots: communications and
interoperability, MQTT + JSON). See the [repository root README](../README.md) for the standard
overview and design docs.

## Requirements

- Node.js >= 22 (see `.nvmrc`)

## Setup

```sh
nvm use
npm install
```

## Common tasks

| Task | Command |
|---|---|
| Build (dual ESM + CJS + `.d.ts`) | `npm run build` |
| Run tests | `npm test` |
| Run tests in watch mode | `npm run test:watch` |
| Type-check without emitting | `npm run typecheck` |
| Lint | `npm run lint` |

Build output goes to `dist/`.

## Layout

- `src/` — SDK source
- `test/` — Vitest test suites
- `dist/` — build output (generated, gitignored)
