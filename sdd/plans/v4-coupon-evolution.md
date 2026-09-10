# Plan de implementación — V4 Evolución de cupones

1. Migrar el esquema de forma compatible para añadir estado, límite configurable y revisiones parciales persistentes, conservando cupones y usos existentes.
2. Resolver la configuración de un cupón al instante solicitado aplicando revisiones vigentes en orden determinista.
3. Implementar `PATCH /coupons/:code` con validación parcial, validación de la configuración resultante y programación mediante `effectiveFrom`.
4. Usar la configuración resuelta durante checkout para estado activo y límite total, sin cambiar las reglas V1-V3 restantes.
5. Cubrir actualizaciones inmediatas, programadas acumuladas, validaciones, identidad/historial y regresión; ejecutar pruebas y TypeScript.
