# SmartPetFeeder

Panel web para controlar y monitorear un alimentador automático desde una Raspberry Pi.

## Requisitos

- Raspberry Pi OS
- Node.js 18 o superior
- npm
- Hardware PCA9685 y GPIO configurado según `server.js`

## Instalación

```bash
git clone https://github.com/arnoldmtt3/SmartPetFeeder.git smartpetfeeder
cd smartpetfeeder
npm install
npm start
```

El servidor crea automáticamente `data/smartpetfeeder.db` y escucha en el puerto `3000`.

## Primer acceso

1. Inicia el servidor con `npm start`.
2. Busca en la terminal el mensaje `Código de configuración inicial`.
3. Abre `http://IP-DE-LA-RASPBERRY:3000/login`.
4. Ingresa el código mostrado, crea el usuario administrador y elige una contraseña de al menos 10 caracteres.

El usuario se guarda en SQLite. La contraseña **no se guarda en texto legible**: se almacena como un hash `scrypt` con una sal aleatoria. Las sesiones también se guardan en SQLite mediante el hash de un token aleatorio, expiran después de siete días y usan una cookie `HttpOnly` y `SameSite=Strict`.

Todos los controles, endpoints, video y conexiones WebSocket requieren una sesión válida. Después de cinco intentos incorrectos, el acceso queda bloqueado durante 15 minutos para esa dirección IP.

## Acceso mediante Cloudflare Tunnel

Crea una ruta de aplicación publicada con estos valores:

- Hostname: `alimentador.mismartpet.com`
- Tipo de servicio: `HTTP`
- URL del servicio: `localhost:3000`

No es necesario abrir el puerto 3000 en el router. Se recomienda mantener también Cloudflare Access como una segunda capa de protección.

## Datos persistentes

La base de datos se encuentra en:

```text
data/smartpetfeeder.db
```

Haz copias de seguridad de ese archivo para conservar el usuario, las sesiones, los horarios, la configuración y el historial de alimentación.
