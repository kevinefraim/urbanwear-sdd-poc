# UrbanWear SDD POC

Proof of concept for evolving an UrbanWear coupon API through a
specification-driven development (SDD) workflow.

## Contents

- [`docs/`](docs/): the V0 product and API specification.
- [`sdd/`](sdd/): specifications, implementation plans, and task breakdowns
  for coupon iterations V1 through V4.
- [`urbanwear/`](urbanwear/): the TypeScript/Express implementation and its
  automated tests.

## Run the application

From [`urbanwear/`](urbanwear/):

```bash
corepack pnpm install
corepack pnpm reset:seed
corepack pnpm start
```

Run the test suite with:

```bash
corepack pnpm test
```

See [`urbanwear/README.md`](urbanwear/README.md) for runtime configuration and
the complete local-development notes.
