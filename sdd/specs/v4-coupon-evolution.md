# UrbanWear V4 — Evolución de cupones

## Estado y alcance

Esta especificación incorpora la edición parcial y temporal de cupones existentes. Reemplaza la inmutabilidad de la configuración de cupones de V1-V3, pero conserva su identidad (`code`) y el historial de usos. Los comportamientos V0 y las reglas V1-V3 que no se modifican expresamente siguen vigentes.

## Configuración y persistencia

- Un cupón conserva su `code` único e inmutable y sus usos históricos; editarlo nunca crea otro cupón ni elimina usos.
- Además de `type`, `value`, `validFrom`, `validUntil`, `minimumAmount`, `categoryIds` y `allowedUserIds`, la configuración contiene `active` y `maxUsesPerUser`.
- Los cupones preexistentes son compatibles y se consideran inicialmente `active: true` y con `maxUsesPerUser: 3`, que era el límite total vigente de V2.
- Cada revisión persiste el parche parcial y su `effectiveFrom`. Puede haber más de una revisión futura para el mismo cupón. Para resolver la configuración se aplican los parches ya vigentes en orden de `effectiveFrom` y, ante igualdad, en orden de creación.

## PATCH /coupons/:code

- Acepta una modificación parcial de cualquiera de: `type`, `value`, `validFrom`, `validUntil`, `minimumAmount`, `categoryIds`, `allowedUserIds`, `active` y `maxUsesPerUser`. `code` no puede modificarse.
- `effectiveFrom` es opcional y aplica al parche completo. Si se omite, la revisión entra en vigor en el instante del reloj de la aplicación. Si es igual o anterior a ese instante, ya se considera vigente.
- Los valores modificados conservan las validaciones de creación: tipos de descuento, valor positivo y porcentaje entre 1 y 100, fechas válidas y ordenadas, mínimo no negativo, categorías y usuarios existentes; las listas eliminan duplicados. `active` es booleano y `maxUsesPerUser` es un entero positivo.
- Se rechazan cuerpos vacíos, campos no configurables o configuraciones resultantes inválidas, incluso si el parche volviera inválida una revisión posterior ya programada. Un cupón inexistente devuelve `404`.
- La respuesta exitosa y `GET /coupons/:code` exponen únicamente la configuración vigente, sin publicar revisiones programadas.

## Checkout y compatibilidad

- Al aplicar un cupón, checkout resuelve la configuración vigente en ese instante y conserva las reglas existentes de vigencia, segmentación, mínimo, categorías, descuento, redondeo y atomicidad.
- Un cupón con `active: false` no puede aplicarse.
- `maxUsesPerUser` reemplaza para ese cupón el límite total fijo de tres usos de V2; la regla V2 de como máximo un uso exitoso por cupón, cliente y día calendario UTC continúa vigente.
- Los cambios posteriores nunca alteran los usos ni las órdenes ya registradas. Un checkout rechazado continúa sin crear orden, uso ni modificar el carrito.
