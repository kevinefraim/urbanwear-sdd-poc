# UrbanWear SDD POC

Prueba de concepto para evolucionar una API de cupones de UrbanWear mediante
un flujo de desarrollo guiado por especificaciones (SDD).

## Contenido

- [`docs/`](docs/): la especificación de producto y API de V0.
- [`sdd/`](sdd/): especificaciones, planes de implementación y desglose de
  tareas para las iteraciones de cupones V1 a V4.
- [`urbanwear/`](urbanwear/): la implementación en TypeScript/Express y sus
  pruebas automatizadas.

## Ejecutar la aplicación

Desde [`urbanwear/`](urbanwear/):

```bash
corepack pnpm install
corepack pnpm reset:seed
corepack pnpm start
```

Ejecutar la suite de pruebas con:

```bash
corepack pnpm test
```

Ver [`urbanwear/README.md`](urbanwear/README.md) para la configuración de
ejecución y las notas completas de desarrollo local.
