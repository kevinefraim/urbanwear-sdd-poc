# UrbanWear V2 — Reutilización controlada de cupones

## Estado y alcance

Esta especificación reemplaza la regla V1 que permite un único uso exitoso de un mismo cupón por cliente. Los comportamientos de V1 para creación y consulta de cupones, vigencia, mínimo de compra, categorías aplicables, cálculo y redondeo de descuentos, y checkout sin cupón continúan vigentes. El contrato HTTP existente no cambia.

## Reutilización y persistencia

- Un cliente puede reutilizar un cupón en compras posteriores si no excede el límite total de usos por cupón y cliente ni el límite de usos del mismo cupón por cliente durante un día.
- El límite total es de tres usos exitosos por cupón y cliente.
- El límite diario es de un uso exitoso por cupón y cliente por día calendario UTC. Un día abarca desde `00:00:00.000Z` (inclusivo) hasta el siguiente límite de día (exclusivo).
- Se persiste cada uso exitoso, asociado al cupón, cliente, orden y momento de utilización. La persistencia debe admitir múltiples usos del mismo cupón por el mismo cliente.
- Un intento que no termina en un checkout válido no consume ninguno de los límites ni crea un registro de utilización, orden o modificación del carrito.
- El registro de uso, la orden y el vaciado del carrito continúan siendo atómicos.

Los límites son reglas internas de checkout: no se agregan campos a `POST /coupons`, ni se cambia ninguna ruta, solicitud o respuesta HTTP existente.
