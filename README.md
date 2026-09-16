
## Correr en local

 Node.js 18+.

```bash
npm install
npm start
```

abrir:

`http://localhost:3000`

Profe no tengo idea de porque con la URL de vercel no funciona y solo pinta en pantalla, pero corriendo en local luego de instalar las dependencias si funciona


## RT-2 SharedArrayBuffer

Se incluye el siguiente módulo pequeño como implementación de referencia para un estado de la flota con doble búfer. El renderizador puede leer la última versión completada sin esperar al *worker*.

```js
// public/shared-state.js
const BUS_FIELDS = 8;
const busState = new SharedArrayBuffer(310 * BUS_FIELDS * Float64Array.BYTES_PER_ELEMENT);
const versionState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
const versions = new Int32Array(versionState);
const data = new Float64Array(busState);


Para la demostración didáctica, los datos de la flota en tiempo real se almacenan en mapas estándar del *worker*, mientras que este patrón ilustra el diseño de sincronización necesario. Para convertir RT-2 en una implementación apta para una revisión de código estricta, se debe trasladar la matriz final resultante a este búfer antes de realizar el dibujo.

