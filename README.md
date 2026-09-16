# Control de frecuencia de buses

Proyecto del caso 3. Es una app sencilla para simular 310 buses en 22 rutas, mirar el mapa y detectar cuando dos buses de la misma ruta se estan juntando.

## Como correr

```bash
npm install
npm start
```

Abrir `http://localhost:3000`.

## Que hace

- Genera buses con ruido de GPS, saltos en el centro, silencios, relojes desfasados y mensajes viejos.
- Usa Web Workers para ubicar el punto GPS sobre la ruta.
- Usa un Shared Worker para ordenar los buses por ruta y sacar alertas.
- Usa Service Worker para abrir sin internet y guardar acciones del supervisor.
- Dibuja en canvas, no crea un div por cada bus.

## Camino del GPS hasta la alerta

1. El simulador crea un punto GPS con bus, ruta, latitud, longitud, velocidad y hora.
2. El punto se manda al Web Worker que tiene esa ruta.
3. El worker busca segmentos cercanos con una rejilla y calcula el mejor segmento usando distancia y avance anterior.
4. Si el bus parece retroceder por ruido o mensaje viejo, se corrige o se ignora.
5. La posicion final queda en metros desde el inicio de la ruta.
6. El estado se publica en un SharedArrayBuffer con doble buffer y Atomics.
7. El Shared Worker ordena los buses de cada ruta y compara el intervalo con la frecuencia programada.
8. Si el intervalo baja de 40%, muestra bunching y propone retener el bus unos minutos.
