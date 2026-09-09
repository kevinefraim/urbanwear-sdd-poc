# UrbanWear V1 — Cupones de descuento

## Estado y alcance

Esta especificación reemplaza la exclusión de cupones de V0. Los comportamientos de V0 para usuarios, productos, carrito y checkout sin cupón continúan vigentes. No se incorporan frontend, autenticación, pagos ni otras promociones.

## Persistencia

- Un cupón tiene `code` único, `type`, `value`, `validFrom`, `validUntil`, `minimumAmount` y cero o más categorías aplicables.
- `type` acepta únicamente `percentage` o `fixed`.
- Se registra cada uso exitoso asociado al cupón, al cliente y a la orden.
- La combinación cupón-cliente es única: un cliente puede usar exitosamente un mismo cupón una vez; otros clientes pueden usarlo de forma independiente.

## API de cupones

### POST /coupons

Recibe todos los campos `code`, `type`, `value`, `validFrom`, `validUntil`, `minimumAmount` y `categoryIds`. Crea el cupón y devuelve `201` con su representación. El código debe ser único; los valores monetarios y el valor del cupón fijo son positivos (el mínimo puede ser cero); un cupón `percentage` debe tener un valor entre 1 y 100, ambos inclusive. Las fechas deben ser válidas y ordenadas, y todas las categorías indicadas deben existir.

Una lista vacía de categorías significa que el cupón puede descontar cualquier producto. Las fechas se guardan y comparan como instantes UTC con precisión de milisegundos; ambos límites de vigencia son inclusivos. En particular, un checkout realizado exactamente en `validUntil` puede aplicar el cupón.

### GET /coupons/:code

Devuelve `200` con el cupón y sus `categoryIds`, o `404` si el código no existe.

## Checkout

`POST /checkout/:userId` continúa aceptando un cuerpo vacío y conserva el flujo V0: valida el usuario y el carrito, crea la orden y vacía el carrito. Puede recibir opcionalmente `couponCode`.

Para aplicar un cupón, éste debe existir, estar vigente, no haber sido usado antes por el cliente y el subtotal completo del carrito (antes del descuento) debe alcanzar `minimumAmount`.

- Sin categorías, el importe elegible es todo el subtotal.
- Con `categoryIds`, el importe elegible es solo la suma de ítems de esas categorías; los otros ítems permanecen en el carrito y no reciben descuento.
- Si no hay ítems elegibles, el cupón no aplica.
- Un cupón `percentage` descuenta el porcentaje indicado del importe elegible.
- Un cupón `fixed` descuenta su valor, limitado al importe elegible.
- El descuento y el total se redondean a dos decimales y el total no puede ser negativo.

Cuando la aplicación es exitosa, la respuesta `201` incluye `subtotal`, `discount`, `total` y `couponCode` (además de los identificadores de orden y usuario existentes). El uso, la orden y el vaciado del carrito son atómicos. Un cupón rechazado no crea una orden ni modifica el carrito.
