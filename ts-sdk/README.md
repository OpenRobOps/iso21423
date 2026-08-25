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

## Installing (GitHub Packages)

The package is published to GitHub Packages under `@openrobops`. Consumers add a scope mapping:

```ini
# .npmrc
@openrobops:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` — required even for public packages. Then:

```sh
npm install @openrobops/iso21423 mqtt
```

`mqtt@^5` is a peer dependency: install it alongside, or inject your own `MqttTransport`.
Public npmjs publication is phase 2, at API stability (**ND-19**).

## Code style

Every non-trivial exported class, interface, function, and method carries a TSDoc (`/** ... */`)
comment stating what the signature alone can't — units, ordering, throw conditions, side effects.
Trivial members (simple getters, one-line delegations whose name says it all) stay bare. Spec
references (ISO clause numbers, ND-xx, D-xx) are kept verbatim wherever they already appear.
