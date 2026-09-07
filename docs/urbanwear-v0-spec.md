# UrbanWear V0

## Objetivo

Construir un backend mínimo para una tienda ficticia de calzado urbano.

Esta versión representa el estado inicial del sistema antes de incorporar
funcionalidades de cupones o promociones.

## Stack tecnológico

- Node.js
- TypeScript
- Express
- SQLite
- better-sqlite3

## Alcance funcional

El backend debe permitir trabajar con:

- usuarios;
- productos;
- categorías;
- carrito de compras;
- checkout simulado;
- órdenes.

## Entidades

### User

- id numérico
- name
- email

### Category

- id numérico
- name

### Product

- id numérico
- name
- price
- categoryId

### Cart

- asociado a un usuario

### CartItem

- productId
- quantity

### Order

- id
- userId
- subtotal
- total
- createdAt

## Endpoints mínimos

### Productos

GET /products

GET /products/:id

### Usuarios

POST /users

### Carrito

GET /cart/:userId

POST /cart/:userId/items

El body debe permitir indicar productId y quantity.

### Checkout

POST /checkout/:userId

El checkout debe:

1. obtener los productos del carrito;
2. calcular el subtotal;
3. crear una orden;
4. devolver subtotal y total;
5. vaciar el carrito.

En V0 subtotal y total deben ser iguales.

## Datos iniciales

El proyecto debe incluir un mecanismo reproducible de seed con:

- al menos 2 categorías;
- al menos 5 productos;
- al menos 2 usuarios.

## Tests internos

Agregar tests básicos para comprobar:

- listado de productos;
- agregado de productos al carrito;
- cálculo correcto del subtotal;
- creación de una orden;
- vaciado del carrito luego del checkout.

## Fuera de alcance

No implementar:

- cupones;
- promociones;
- autenticación;
- JWT;
- contraseñas;
- pagos reales;
- envíos;
- frontend;
- stock avanzado;
- panel administrativo;
- integraciones externas.

No agregar funcionalidades que no estén especificadas.
