# UrbanWear V0

```bash
pnpm install
pnpm reset:seed
pnpm start
```

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
