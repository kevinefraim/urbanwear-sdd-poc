# UrbanWear POC — Trayectoria Prompt-Driven

Esta rama registra la trayectoria de desarrollo guiado por prompts de la POC
UrbanWear. Parte de la base V0 y evoluciona la funcionalidad de cupones a través
de las versiones V1 a V4, conservando principalmente el código implementado en
cada iteración como contexto para la siguiente.

## Contenido

- [`docs/`](docs/): especificación de producto y API de V0.
- [`urbanwear/`](urbanwear/): implementación en TypeScript/Express y pruebas
  automatizadas de la aplicación.

## Evolución

Los puntos de cada versión están identificados mediante etiquetas Git:

- `prompt-final-v1-first` y `prompt-final-v1-final`
- `prompt-final-v2-first` y `prompt-final-v2-final`
- `prompt-final-v3-first` y `prompt-final-v3-final`
- `prompt-final-v4-first` y `prompt-final-v4-final`

Las etiquetas `first` marcan el primer intento y las etiquetas `final`, el
estado final de cada versión.

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
ejecución local.
