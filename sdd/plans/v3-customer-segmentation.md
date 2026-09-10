# Plan de implementación — V3 Segmentación por cliente

1. Añadir una relación persistente entre cupones y usuarios permitidos, segura para bases V1/V2 ya existentes.
2. Extender el modelo y los endpoints de creación/consulta con `allowedUserIds`, validando IDs enteros existentes y eliminando duplicados.
3. Incorporar la comprobación de pertenencia en el checkout transaccional, sin alterar reglas de vigencia, límites, descuento o atomicidad.
4. Cubrir cupón general, acceso autorizado, rechazo de usuario no autorizado, validación, recuperación y compatibilidad de una base previa.
5. Ejecutar pruebas de regresión y comprobación estática de TypeScript.
