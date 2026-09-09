# UrbanWear V0

```bash
corepack pnpm install
corepack pnpm reset:seed
corepack pnpm start
```

El proyecto fija pnpm `12.3.4` mediante Corepack. Para ejecutar las pruebas de
forma reproducible, usar `corepack pnpm test`; una vez preparada esa versión,
Corepack no necesita consultar el registro para elegir una versión de pnpm.

The following environment variables make local runs reproducible:

- `PORT` (default: `3000`)
- `DATABASE_PATH` (default: `urbanwear.db`)
- `TEST_NOW` (optional fixed timestamp provided by the shared application clock)

For example:

```powershell
$env:PORT = '3100'
$env:DATABASE_PATH = 'urbanwear-test.db'
$env:TEST_NOW = '2026-01-02T03:04:05.000Z'
pnpm reset:seed
pnpm start
```

`pnpm reset:seed` removes the configured SQLite database (and its SQLite journal files) and reloads the two users, two categories, and five products defined for V0.
