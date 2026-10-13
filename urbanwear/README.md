# UrbanWear V0

```bash
corepack pnpm install
corepack pnpm reset:seed
corepack pnpm start
```

El proyecto fija pnpm `12.3.4` mediante Corepack. Para ejecutar las pruebas de
forma reproducible, usar `corepack pnpm test`; una vez preparada esa versión,
Corepack no necesita consultar el registro para elegir una versión de pnpm.

Las siguientes variables de entorno hacen reproducibles las ejecuciones locales:

- `PORT` (valor predeterminado: `3000`)
- `DATABASE_PATH` (valor predeterminado: `urbanwear.db`)
- `TEST_NOW` (marca de tiempo fija opcional proporcionada por el reloj compartido de la aplicación)

Por ejemplo:

```powershell
$env:PORT = '3100'
$env:DATABASE_PATH = 'urbanwear-test.db'
$env:TEST_NOW = '2026-01-02T03:04:05.000Z'
pnpm reset:seed
pnpm start
```

`pnpm reset:seed` elimina la base de datos SQLite configurada (y sus archivos de diario) y vuelve a cargar los dos usuarios, las dos categorías y los cinco productos definidos para V0.
