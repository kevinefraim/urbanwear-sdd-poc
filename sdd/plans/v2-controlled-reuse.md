# Plan de implementación — V2 Reutilización controlada

1. Persistir los límites confirmados: tres usos totales y un uso por día calendario UTC por cupón y cliente.
2. Migrar el esquema de usos para permitir múltiples registros por cupón y cliente y almacenar un instante UTC de utilización consultable, preservando el historial V1 existente.
3. Mantener el contrato HTTP y validar dentro del checkout transaccional los límites total y diario antes de crear la orden.
4. Registrar únicamente aplicaciones exitosas, junto con la orden y el vaciado atómico del carrito.
5. Cubrir reutilización dentro y fuera del día, ambos límites, persistencia y la no penalización de intentos fallidos; ejecutar pruebas y comprobación de tipos.
