# web-finances

Foro para que inversores hagan preguntas, con una **Mesa de Trading** integrada con las
skills de day trading de Claude ([day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill), MIT).

> **No es asesoramiento financiero.** La mayoría de quienes hacen day trading pierden dinero.
> La app solo lee y muestra datos: no puede enviar órdenes. Empieza siempre en paper trading.

## Qué hay

| Archivo | Qué es |
| --- | --- |
| `index.html` | La app: foro (Firebase) + pestaña **Mesa de Trading** |
| `trading-desk.js` | La Mesa de Trading, 100 % local, funciona sin Firebase |
| `.claude/skills/trader-*` | Las 11 skills de day trading, instaladas a nivel de proyecto |

## Las skills (Claude Code)

Abre Claude Code en esta carpeta y quedan disponibles: `/trader-scanner`, `/trader-news`,
`/trader-entry`, `/trader-exit`, `/trader-timemachine`, `/trader-budget`, `/trader-risk`,
`/trader-broker`, `/trader-alerts`, `/trader-analyst` y `/trader-pelosi`.
Necesitan Python 3.8+ y nada más. Todo lo que generan se guarda en `trader/` (ignorado por git).

Flujo de un trade:

```
scanner -> news -> entry -> exit -> timemachine -> budget -> risk -> broker
```

Antes de usar `/trader-news` o `/trader-analyst`, pon tu nombre y email en `trader/config.json`
(`"sec_user_agent"`) o en la variable `SEC_USER_AGENT`: la SEC lo exige.

## La Mesa de Trading

Lee los archivos que escriben las skills y los muestra:

- el flujo del trade con el siguiente paso y el comando para copiar en Claude;
- plan (entrada, stop, objetivo, R), señal de entrada y watchlist del escáner;
- la Máquina del tiempo: probabilidades objetivo/stop/ninguno, abanico de precios y el histórico;
- las órdenes propuestas con su veredicto de `/trader-risk` (empareja cada orden por la misma
  huella SHA-256 que usa `/trader-broker`, así que avisa si la orden cambió después de verificarla);
- alertas, precios, cartera, tus límites y el registro del bróker;
- avisos de incoherencia (p. ej. la Máquina del tiempo se ejecutó con otro plan);
- una calculadora de tamaño con los mismos cuatro límites que `/trader-budget`;
- **Compartir en el foro**: publica el plan (sin tu presupuesto ni tu cartera) en la categoría
  *Ideas de Trading*, con su tarjeta de probabilidades.

Para que lea `trader/` automáticamente, sírvela desde la raíz del proyecto:

```bash
python3 -m http.server 8000
```

y abre <http://localhost:8000>. También puedes elegir la carpeta `trader/` o arrastrar los `.json`.
El botón **Ver ejemplo (TSLA)** carga el trade de ejemplo del README de la skill.

## El foro (Firebase)

El foro usa Firebase Auth + Firestore. La configuración se toma de `__firebase_config`
(si el entorno la inyecta) o de `window.FIREBASE_CONFIG`, que puedes definir antes de los scripts:

```html
<script>window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "..." };</script>
```

Sin configuración, el foro se desactiva con un aviso y la Mesa de Trading sigue funcionando.
