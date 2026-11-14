# Puesta en marcha del bot automático

Guía paso a paso para dejar funcionando el bot: **24 analistas votan en cada vela y, cuando el 75 % o más
están de acuerdo, el bot abre la operación solo, con stop loss y take profit**. Tú lo controlas desde el móvil.

Tiempo: unos **40 minutos** la primera vez. Después, 1 minuto cada día.

> **Siempre en cuenta DEMO** mientras lo pruebas. El bot no puede operar dinero real salvo que tú lo
> actives a propósito en dos sitios.

---

## Antes de empezar

Necesitas:

- [ ] Un **ordenador con Windows** que pueda quedarse encendido (el bot vive en el ordenador; el móvil es el mando).
- [ ] **MetaTrader 5** instalado, con una **cuenta demo** abierta (en MT5: *Archivo › Abrir una cuenta* › demo).
- [ ] El **móvil** conectado a la **misma WiFi** que el ordenador.

> **¿Es fin de semana?** Divisas, oro e índices están **cerrados** de viernes noche a domingo noche: no se
> mueven los precios y el bot no hace nada. Para probar en fin de semana usa **criptomonedas** (por ejemplo
> `BTCUSD`, si tu bróker las tiene en la demo) o el **simulador** del Paso 3.

---

## Paso 1. Instalar Python (solo la primera vez)

1. Entra en **python.org › Downloads** y descarga la versión para Windows.
2. Abre el instalador y, **antes de pulsar Install**, marca **"Add python.exe to PATH"**.
3. Pulsa **Install Now**.

## Paso 2. Descargar la app (solo la primera vez)

1. En GitHub, abre tu repositorio `mauro077103/web-finances`.
2. En el selector de rama (arriba a la izquierda) elige **`claude/relaxed-carson-vzdgku`**.
3. Botón verde **Code › Download ZIP**.
4. Descomprímelo en el **Escritorio**. Te queda la carpeta `web-finances`.

## Paso 3. Probar el bot con el simulador (5 minutos)

1. Abre la carpeta `web-finances`. Haz clic en la **barra de direcciones** de la ventana, escribe `cmd` y
   pulsa **Enter**. Se abre una ventana negra.
2. Escribe y pulsa **Enter**:

   ```bash
   py bridge\server.py --demo --auto
   ```

3. Copia la dirección que pone **Ordenador:** y ábrela en Chrome o Edge.
4. Verás **Piloto automático: ● ENCENDIDO**. Baja hasta **Analistas › Comité**: aparecen los votos de cada
   símbolo. En pocos minutos el bot abre operaciones solo (salen en **Posiciones abiertas** y en **Señales**).
5. Cuando lo hayas visto, en la ventana negra pulsa **Ctrl + C** para pararlo.

Si esto funciona, el bot está bien instalado. Ahora lo conectamos a MetaTrader.

## Paso 4. Arrancar el bot para MetaTrader

En la ventana negra (abierta como en el Paso 3) escribe:

```bash
py bridge\server.py --lan --auto
```

- Si Windows pregunta por el **firewall**, pulsa **Permitir** solo en **redes privadas**.
- Apunta el **Token** que aparece (también está en el archivo `bridge\.token`).
- **No cierres esta ventana.** Si se cierra, el bot se para.

## Paso 5. Instalar el robot en MetaTrader 5 (solo la primera vez)

1. En MetaTrader: **Archivo › Abrir carpeta de datos** › entra en **MQL5 › Experts** y copia ahí el archivo
   `mt5\WebFinancesBridge.mq5` de la carpeta de la app.
2. Pulsa **F4** (se abre MetaEditor), haz doble clic en `WebFinancesBridge.mq5` y pulsa **F7**.
   Abajo debe poner **0 errors**. *Si sale algún error, cópialo y pásamelo.*
3. En MetaTrader: **Herramientas › Opciones › Asesores Expertos**:
   - marca **Permitir WebRequest para las siguientes URL**;
   - añade `http://127.0.0.1:8765` y pulsa **Aceptar**.
4. Abre el **Navegador** (Ctrl + N) › **Asesores Expertos** y arrastra **WebFinancesBridge** a cualquier gráfico.
5. En la pestaña **Parámetros** rellena:

   | Parámetro | Qué poner |
   | --- | --- |
   | `Token` | El token del Paso 4 |
   | `Symbols` | Los símbolos que vigila el bot, por ejemplo `EURUSD,GBPUSD,XAUUSD,US500` (en fin de semana, `BTCUSD`). Vacío = los de Observación de Mercado |
   | `AllowTrading` | `true` (si no, el bot no puede operar) |
   | `MaxRiskPerTrade` | `50`: lo máximo que puede perder una operación. Es el último freno |
   | `MaxVolume` | `1.0`: lotes máximos por orden |
   | `AllowLiveAccount` | `false` (así nunca toca dinero real) |

6. Pulsa **Aceptar** y activa el botón **Algo Trading** de la barra de arriba (tiene que quedar en **verde**).
7. Abajo, en la pestaña **Expertos**, debe aparecer **web-finances: conectado con el puente**.

## Paso 6. Abrir el mando en el móvil

1. En el móvil, abre en el navegador la dirección **Móvil:** que mostró la ventana negra
   (`http://192.168.x.x:8765/?token=...`).
2. Instálala como app:
   - **Android (Chrome):** menú **⋮ › Añadir a pantalla de inicio**.
   - **iPhone (Safari):** botón **Compartir › Añadir a pantalla de inicio**.
3. A partir de ahora basta con tocar el icono.

## Paso 7. Poner tu riesgo

En la app, apartado **Tu riesgo**. Para una cuenta demo de 10 000 te sugiero:

| Campo | Valor sugerido | Qué hace |
| --- | --- | --- |
| Riesgo por operación | `20` | Lo que pierdes si salta el stop de una operación |
| Pérdida máxima por operación | `50` | Techo de cualquier orden |
| Pérdida máxima del día | `60` | Al llegar, **el bot se apaga solo** hasta que lo enciendas |
| Posiciones abiertas a la vez | `3` | |
| Operaciones automáticas por día | `10` | |
| Mover el stop a la entrada al ganar 1R | ✔ | Protege la operación cuando ya va ganando |

Pulsa **Guardar riesgo**.

## Paso 8. Comprobar que está funcionando

- [ ] Arriba pone **MetaTrader conectado** y la etiqueta **DEMO**.
- [ ] **Piloto automático: ● ENCENDIDO**.
- [ ] En **Analistas › Comité de analistas**, cada símbolo pasa de *calentando* a mostrar **▲ compra % · ▼ venta %**.
- [ ] Cuando un lado llega al **75 %** aparece **CONSENSO COMPRA/VENTA**, la operación sale en **Señales** como
      **Ejecutada sola** y en MetaTrader verás la posición con su **SL** y su **TP**.

Ten paciencia: con velas de 5 minutos, el comité vota cada 5 minutos y el 75 % de acuerdo **no llega en cada
vela**. Puede pasar un buen rato sin operaciones; es normal.

---

## Uso diario

1. Enciende el ordenador y abre **MetaTrader 5** (el robot sigue en su gráfico; comprueba **Algo Trading** en verde).
2. En la carpeta `web-finances`, escribe `cmd` en la barra de direcciones y ejecuta:

   ```bash
   py bridge\server.py --lan --auto
   ```

3. Mira el móvil cuando quieras. Activa **🔔 Avisos** para recibir las operaciones.

## Cómo pararlo

| Quieres... | Haz esto |
| --- | --- |
| Que deje de abrir operaciones | En la app, **Apagar piloto** |
| Pararlo del todo | En la ventana negra, **Ctrl + C** |
| Freno de emergencia | En MetaTrader, apaga el botón **Algo Trading** |
| Cerrar una operación | En **Posiciones abiertas**, **Cerrar** |

Las operaciones que ya están abiertas **siguen en MetaTrader con su stop loss y take profit** aunque apagues el bot.

## Ajustar el bot (opcional)

En **Analistas › Comité de analistas**:

- **Votos a favor (%)**: 75 por defecto. Más alto = menos operaciones y más acuerdo.
- **Quórum**: mínimo de votos para decidir (8).
- **Stop (× ATR)** y **Take profit (R)**: a qué distancia van el stop y el objetivo.
- **Velas**: M5 por defecto. M1 opera más a menudo, M15 menos.
- **Analistas del comité**: desmarca los que no quieras que voten.

---

## Si algo falla

| Lo que ves | Qué hacer |
| --- | --- |
| `py` no se reconoce | Reinstala Python marcando **"Add python.exe to PATH"** |
| "Esperando al EA de MetaTrader" | MetaTrader abierto, robot en un gráfico y WebRequest permitido (Paso 5.3) |
| Error **4014** en Expertos | Falta el permiso WebRequest (Paso 5.3) |
| "Token incorrecto" / **HTTP 401** | Copia otra vez el token de `bridge\.token` en el robot |
| "Trading desactivado" | `AllowTrading = true` y **Algo Trading** en verde |
| El móvil no abre la app | Misma WiFi, bot arrancado con `--lan`, firewall permitido en redes privadas |
| El comité está "calentando" mucho rato | Mercado cerrado (fin de semana) o el símbolo no se mueve |
| Señal **Bloqueada** | Lee el motivo: ya hay posición en ese símbolo, máximo de posiciones, stop muy cerca, límite del día... |
| "Piloto automático apagado" con mensaje en naranja | Llegaste a la pérdida máxima del día. Se puede volver a encender mañana o a mano |

## Antes de pensar en dinero real

- Déjalo **varias semanas en demo** y apunta los resultados.
- Que el 75 % de los analistas esté de acuerdo **no garantiza ganar**: el bot no se ha probado con datos históricos.
- Para dinero real habría que activar **dos** cosas a propósito: `--allow-live` al arrancar y
  `AllowLiveAccount = true` en el robot. No lo hagas sin haberlo probado en demo.
