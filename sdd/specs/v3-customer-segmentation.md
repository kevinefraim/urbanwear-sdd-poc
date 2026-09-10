# UrbanWear V3 — Segmentación por cliente

## Estado y alcance

Esta especificación incorpora segmentación de cupones por cliente. Reemplaza únicamente la elegibilidad V1/V2 que hasta ahora era igual para todos los clientes. Permanecen vigentes la creación y consulta de cupones, vigencia, mínimo de compra, categorías aplicables, cálculo y redondeo de descuentos, checkout sin cupón, reutilización máxima de tres usos por cupón y cliente y un uso por día calendario UTC.

## Persistencia y API

- Un cupón puede tener cero o más `allowedUserIds`, que referencian usuarios existentes y no se repiten.
- `POST /coupons` acepta opcionalmente `allowedUserIds` como una lista de IDs enteros de usuarios existentes. Su omisión o una lista vacía crea un cupón general, sin segmentación.
- `GET /coupons/:code` y la respuesta exitosa de creación incluyen `allowedUserIds`. Para cupones generales el valor es una lista vacía.
- Los cupones y bases de datos existentes continúan siendo compatibles: los cupones sin asociaciones de usuarios son generales.

## Elegibilidad y checkout

- Al aplicar un cupón segmentado, el `userId` del checkout debe estar en `allowedUserIds`.
- Un cupón general (sin usuarios permitidos) puede ser usado por cualquier cliente, sujeto a todas las reglas V1/V2 que continúan vigentes.
- La segmentación se valida dentro de la misma transacción que las restantes reglas de cupón. Un rechazo por segmentación no crea uso u orden ni modifica el carrito.
