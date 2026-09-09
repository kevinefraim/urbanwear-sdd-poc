# Plan de implementación — V1 Cupones

1. Extender el esquema SQLite con cupones, categorías aplicables y usos por cliente, conservando las tablas y el seed de V0.
2. Implementar creación y consulta de cupones con validaciones de contrato, incluido el rango inclusivo de 1 a 100 para porcentajes y límites de vigencia inclusivos; interpretar `validUntil` sin hora como el final de ese día UTC.
3. Extender el checkout transaccional para validar elegibilidad, calcular el descuento y registrar el uso exitoso.
4. Cubrir creación, consulta, reglas comerciales, reutilización y regresión de checkout sin cupón mediante pruebas internas.
5. Ejecutar pruebas y verificación de tipos; mantener esta documentación y la lista de tareas como estado final.
