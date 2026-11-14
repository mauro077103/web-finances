# web-finances

Foro de inversores + **Mesa de Trading** con skills de Claude + **MetaTrader 5 en tiempo real**.
Funciona en ordenador y en móvil (se instala como app).

> **No es asesoramiento financiero.** La mayoría de quienes hacen trading pierden dinero.
> Empieza siempre con una **cuenta demo**. Por defecto nada puede operar en una cuenta real.

**¿Quieres el bot automático funcionando? Sigue la [Puesta en marcha](PUESTA-EN-MARCHA.md).** ¿Primera vez con la app? [Guía básica](GUIA-BASICA.md).

## Qué hay

| Parte | Qué hace |
| --- | --- |
| `index.html` | La app, con 3 pestañas: **Foro**, **Mesa de Trading** y **MetaTrader en vivo** |
| `trading-desk.js` | Mesa de Trading: lee los archivos `trader/*.json` que generan las skills de Claude |
| `mt5.js` | MetaTrader en vivo: cuenta, cotizaciones, gráfico de velas, órdenes y posiciones en tiempo real |
| `bridge/server.py` | Puente local (Python, sin dependencias) entre MetaTrader 5 y la app |
| `bridge/analysts.py` | Analistas (estrategias) y piloto automático: leen los precios en tiempo real y operan con tu riesgo |
| `bridge/enviar_senal.py` | Para que tus scripts o Claude envíen señales como "analistas externos" |
| `mt5/WebFinancesBridge.mq5` | Expert Advisor para MetaTrader 5 que envía los datos al puente |
| `manifest.webmanifest`, `sw.js`, `icons/` | Para instalarla como app en el móvil y el ordenador (PWA) |
| `.claude/skills/` | 116 skills de trading y finanzas para Claude Code (lista completa en [docs/SKILLS.md](docs/SKILLS.md)) |
| `.mcp.json` | Servidores MCP `fetch` y `time` para Claude Code |

```
MetaTrader 5 ──(EA, cada 250 ms)──► bridge/server.py ──(tiempo real, SSE)──► app en el ordenador
      ▲                                    │                              └► app en el móvil (WiFi)
      └──────── órdenes confirmadas ◄──────┘  valida: stop obligatorio, riesgo y lotes máximos
```

---

## Puesta en marcha

### 0. Requisitos

- **MetaTrader 5** (Windows; en macOS/Linux también funciona a través de la versión con Wine que distribuye MetaQuotes).
- **Python 3.8 o superior** en el mismo ordenador que MetaTrader. No hace falta instalar paquetes.
- El código de este repositorio en ese ordenador:

```bash
git clone https://github.com/mauro077103/web-finances.git
```

### 1. Probar primero sin MetaTrader (simulador)

```bash
cd web-finances
```

```bash
python3 bridge/server.py --demo
```

Abre la dirección que imprime (`http://127.0.0.1:8765/?token=…`). Verás precios moviéndose, gráfico,
y podrás abrir y cerrar operaciones simuladas. En Windows, si `python3` no existe, usa `py`.

### 2. Arrancar el puente para MetaTrader

```bash
python3 bridge/server.py --lan
```

- Imprime el **token** (se guarda en `bridge/.token`) y las direcciones para el ordenador y para el móvil.
- `--lan` permite entrar desde el móvil en la misma WiFi. Sin `--lan` solo se accede desde el propio ordenador.
- La primera vez, Windows puede pedir permiso de firewall para Python: acéptalo solo para **redes privadas**.

Opciones útiles:

| Opción | Para qué |
| --- | --- |
| `--max-risk 50` | Pérdida máxima por operación en el stop, en la divisa de la cuenta (por defecto 50) |
| `--max-volume 1.0` | Lotes máximos por orden inicial (también editable en la app) |
| `--max-orders-per-minute 6` | Freno contra clics repetidos |
| `--auto` | Arranca con el piloto automático **encendido** (opera solo con el comité) |
| `--allow-live` | Permite operar en cuentas **reales** (por defecto bloqueado) |
| `--port 8765` | Puerto |
| `--source python` | Alternativa al EA en Windows: usa el paquete oficial `pip install MetaTrader5` (añade `--allow-trading` para operar) |

### 3. Instalar el EA en MetaTrader 5

1. En MT5: **Archivo › Abrir carpeta de datos**, entra en `MQL5/Experts` y copia ahí `mt5/WebFinancesBridge.mq5`.
2. Ábrelo con **MetaEditor** (botón IDE o F4) y pulsa **Compilar** (F7).
3. **Herramientas › Opciones › Asesores Expertos**: marca **Permitir WebRequest para las siguientes URL** y añade
   `http://127.0.0.1:8765`.
4. En el Navegador de MT5, arrastra **WebFinancesBridge** a cualquier gráfico. En la pestaña **Parámetros**:
   - `Token`: el que mostró el puente.
   - `Symbols`: déjalo vacío para usar la Observación de Mercado, o pon por ejemplo `EURUSD,XAUUSD,US500`.
   - `AllowTrading`: `false` para solo ver datos; `true` para poder enviar órdenes desde la app
     (y activa el botón **Algo Trading** de la barra de MT5).
   - `MaxRiskPerTrade` y `MaxVolume`: tus límites. El EA rechaza cualquier orden que los supere.
   - `AllowLiveAccount`: déjalo en `false` salvo que quieras operar dinero real.
5. En la pestaña **Expertos** de MT5 debe aparecer `web-finances: conectado con el puente`.

### 4. Abrir la app

- **Ordenador:** la dirección "Ordenador" que imprimió el puente.
- **Móvil (misma WiFi):** la dirección "Móvil" (`http://192.168.x.x:8765/?token=…`). Luego, en el menú del
  navegador, **Añadir a pantalla de inicio** (Android/Chrome) o **Compartir › Añadir a inicio** (iPhone/Safari).
- La app guarda el token; después basta con abrir el icono.

### 5. Desde fuera de casa (opcional)

No abras el puerto en el router. Usa una VPN privada, por ejemplo **Tailscale** (gratis para uso personal):
instálalo en el ordenador y en el móvil, arranca el puente con `--lan` y entra con la IP de Tailscale del ordenador.
Con `tailscale serve` o un túnel HTTPS (Cloudflare Tunnel), la app además se instala como PWA completa.
Cualquiera con el token puede operar tu cuenta: no lo compartas.

---

## Cómo se opera desde la app

1. Elige el símbolo en **Cotizaciones**.
2. Pon el **stop loss** (obligatorio) y, si quieres, el take profit.
3. Escribe cuánto estás dispuesto a perder (**Riesgo**) y pulsa **Lotes por riesgo**: calcula los lotes con el
   valor del tick que envía MetaTrader.
4. **Revisar** muestra el ticket en palabras (cuenta demo o REAL, lotes, stop, pérdida si salta) y pide confirmación.
5. La orden pasa tres controles: la app, el puente (`--max-risk`, `--max-volume`, demo/real, frecuencia) y el EA
   (`MaxRiskPerTrade`, `MaxVolume`, `AllowTrading`, `AllowLiveAccount`, lote mínimo y paso).
6. En **Posiciones abiertas** puedes cerrar o mover el stop a la entrada. Activa **🔔 Avisos** para recibir
   notificaciones de ejecuciones y rechazos.

"Tiempo real" significa los precios de tu bróker en MetaTrader, enviados cada 250 ms (ajustable con
`IntervalMs`). La app se actualiza unas 7 veces por segundo.

---

## Analistas y piloto automático

El puente es el **espacio de los analistas**: estrategias que leen cada precio que envía MetaTrader,
construyen sus velas en tiempo real y, al cerrar cada vela, pueden dar una señal con entrada, stop y
objetivo. Siguen funcionando aunque cierres la app o el móvil (mientras el puente y MetaTrader estén abiertos).

| Analista | Señal |
| --- | --- |
| **Comité de analistas** (conectado y en automático por defecto) | 24 analistas (tendencia, momento, ruptura, reversión, patrones) votan en cada vela; si **≥ 75 %** de los votos van al mismo lado (con al menos 8 votos), crea **stop loss** (1,5 × ATR) y **take profit** (2R) y opera |
| **Cruce de medias** | La media rápida cruza la lenta (9/21 por defecto) |
| **Ruptura de rango** | Una vela cierra fuera del máximo/mínimo de las últimas 20 |
| **Rebote RSI** | El RSI sale de sobreventa (30) o sobrecompra (70) |
| **Externos** | Cualquier script o Claude, con `bridge/enviar_senal.py` o `POST /api/signal` |

En la pestaña **MetaTrader en vivo**:

1. **Analistas**: marca **Conectado**, escribe los símbolos (`EURUSD, XAUUSD`), elige velas (M1, M5, M15)
   y el modo: **Solo avisos** (te avisa y con **Al ticket** la ejecutas tú) o **Automático**.
2. **Tu riesgo**: riesgo por operación (dinero o % del balance), pérdida máxima por operación, lotes
   máximos, **pérdida máxima del día**, posiciones a la vez, operaciones por día, distancia mínima del
   stop y mover el stop a la entrada al ganar 1R. Se guarda en el puente (`bridge/settings.json`).
3. **Encender piloto**: muestra un resumen y pide confirmación. A partir de ahí los analistas en
   automático operan solos: el puente calcula los lotes con tu riesgo y la orden pasa los mismos
   controles que una manual, y otra vez los del EA.

Para que opere solo desde el arranque, sin tocar la app: `python3 bridge/server.py --lan --auto`.
Votar en el comité desde Claude o un script (cuenta como un analista más):
`python3 bridge/enviar_senal.py --analista claude --simbolo EURUSD --lado buy --votar --minutos 60`.

Seguridad: el piloto **arranca apagado** salvo con `--auto`; se **apaga solo** al llegar a la
pérdida máxima del día; una posición por símbolo; solo cuentas demo salvo `--allow-live`; y el techo de
`MaxRiskPerTrade`/`MaxVolume` del EA no se puede subir desde la app. **Desconectar** cierra la app, no los analistas.

Señal externa (por ejemplo, desde Claude tras `/trader-exit`):

```bash
python3 bridge/enviar_senal.py --analista claude --simbolo EURUSD --lado buy --sl 1.0820 --tp 1.0900 --motivo "Ruptura"
```

```bash
python3 bridge/enviar_senal.py --analista claude --plan trader/plan.json --simbolo TSLA
```

El analista externo aparece en la app desconectado hasta que lo conectes.

---

## Skills de Claude Code

Abre Claude Code en esta carpeta y tendrás 116 skills: las 11 `/trader-*` de day trading (escáner,
noticias, entrada, salida, máquina del tiempo, tamaño, riesgo, bróker, alertas, analista, Pelosi) y 105
más de análisis técnico, fundamental, screeners, régimen de mercado, opciones, dividendos, etc.
La tabla completa, con qué necesita cada una (por ejemplo `FMP_API_KEY`), está en [docs/SKILLS.md](docs/SKILLS.md).
Ninguna puede operar por sí sola.

Las skills `/trader-*` escriben en `trader/`; la pestaña **Mesa de Trading** lo lee (con el puente
arrancado, automáticamente) y su plan se puede pasar al ticket de MetaTrader con **Usar plan de la Mesa**.

## El foro (Firebase)

El foro usa Firebase Auth + Firestore. La configuración se toma de `__firebase_config` o de
`window.FIREBASE_CONFIG`:

```html
<script>window.FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "..." };</script>
```

Sin configuración, el foro muestra un aviso y las otras dos pestañas funcionan igual.

## Problemas frecuentes

| Síntoma | Solución |
| --- | --- |
| En Expertos: `WebRequest no permitido` (error 4014) | Añade `http://127.0.0.1:8765` en Herramientas › Opciones › Asesores Expertos |
| `HTTP 401` en Expertos o "Token incorrecto" en la app | Copia de nuevo el token de `bridge/.token` |
| La app dice "esperando al EA" | El EA no está en un gráfico, o MT5 está cerrado, o el puerto no coincide |
| "Trading desactivado" | `AllowTrading=true` en el EA y botón **Algo Trading** activado |
| El móvil no carga | Misma WiFi, puente con `--lan`, permiso del firewall para redes privadas |
| Orden rechazada por riesgo | Acerca el stop o reduce lotes; o sube `--max-risk` y `MaxRiskPerTrade` |
