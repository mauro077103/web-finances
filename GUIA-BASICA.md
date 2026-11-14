# Guía básica (paso a paso)

Esta guía es para **Windows** y no hace falta saber programar. Sigue los pasos en orden.

> Usa siempre una **cuenta DEMO** de MetaTrader mientras aprendes. La app no deja operar con dinero real
> salvo que tú lo actives a propósito.

---

## Parte 1: Preparar el ordenador (solo la primera vez)

### Paso 1. Instalar Python

1. Entra en **python.org** › **Downloads** y descarga la versión para Windows.
2. Abre el instalador y, **antes de pulsar Install**, marca la casilla **"Add python.exe to PATH"**.
3. Pulsa **Install Now** y espera a que termine.

### Paso 2. Descargar la app

1. Entra en tu repositorio de GitHub `mauro077103/web-finances`.
2. Arriba a la izquierda, en el selector de rama, elige **`claude/relaxed-carson-vzdgku`**.
3. Pulsa el botón verde **Code** › **Download ZIP**.
4. Descomprime el ZIP en el **Escritorio**. Te queda una carpeta, por ejemplo `web-finances`.

---

## Parte 2: Probarla sin MetaTrader (2 minutos)

1. Abre la carpeta `web-finances` del Escritorio.
2. Haz clic en la **barra de direcciones** de la ventana (donde pone la ruta), escribe `cmd` y pulsa **Enter**.
   Se abre una ventana negra.
3. Escribe esto y pulsa **Enter**:

   ```bash
   py bridge\server.py --demo
   ```

4. Aparece una línea **Ordenador: http://127.0.0.1:8765/?token=...**. Copia esa dirección y pégala en
   Chrome o Edge.
5. Entra en la pestaña **MetaTrader en vivo**. Verás precios simulados moviéndose. Puedes practicar
   abriendo y cerrando operaciones: **no es dinero real**.
6. Para pararlo, en la ventana negra pulsa **Ctrl + C**.

Si esto funciona, ya tienes lo difícil hecho.

---

## Parte 3: Conectarla a tu MetaTrader 5 (solo la primera vez)

### Paso 1. Arrancar el puente

En la ventana negra (como en la Parte 2), escribe:

```bash
py bridge\server.py --lan
```

Aparece un **Token**: una clave larga. **No cierres esta ventana**: si la cierras, la app deja de funcionar.

### Paso 2. Copiar el robot (EA) a MetaTrader

1. Abre **MetaTrader 5** con tu **cuenta demo**.
2. Menú **Archivo** › **Abrir carpeta de datos**.
3. Entra en **MQL5** › **Experts**.
4. Copia ahí el archivo `WebFinancesBridge.mq5`, que está en la carpeta `mt5` de la app.

### Paso 3. Compilarlo

1. En MetaTrader pulsa **F4**. Se abre MetaEditor.
2. A la izquierda, en **Experts**, haz doble clic en `WebFinancesBridge.mq5`.
3. Pulsa **F7** (Compilar). Abajo debe poner **0 errors**.
   *Si sale algún error, cópialo y pásamelo.*

### Paso 4. Dar permiso a MetaTrader

1. En MetaTrader: **Herramientas** › **Opciones** › pestaña **Asesores Expertos**.
2. Marca **"Permitir WebRequest para las siguientes URL"**.
3. Añade esta dirección y pulsa **Aceptar**:

   ```
   http://127.0.0.1:8765
   ```

### Paso 5. Poner el robot en un gráfico

1. En el panel **Navegador** (Ctrl + N), abre **Asesores Expertos**.
2. Arrastra **WebFinancesBridge** encima de cualquier gráfico.
3. En la pestaña **Parámetros**:
   - **Token**: pega el token que mostró la ventana negra.
   - **AllowTrading**: elige `false` si solo quieres ver datos, o `true` si quieres poder operar desde la app.
   - Deja el resto como está.
4. Pulsa **Aceptar**.
5. Si pusiste `AllowTrading = true`, activa también el botón **Algo Trading** de la barra superior de
   MetaTrader (tiene que quedar en verde).
6. Abajo, en la pestaña **Expertos**, debe aparecer: **web-finances: conectado con el puente**.

### Paso 6. Abrir la app

- **En el ordenador:** abre la dirección **Ordenador** que mostró la ventana negra.
- **En el móvil** (conectado a la **misma WiFi** que el ordenador): escribe en el navegador la dirección
  **Móvil** (`http://192.168.x.x:8765/?token=...`).
  Después pulsa **Añadir a pantalla de inicio** para tenerla como una app.

---

## Parte 4: Uso diario

Cada vez que quieras usarla:

1. Abre **MetaTrader 5**. El robot se queda en el gráfico de la última vez.
2. Abre la carpeta `web-finances`, escribe `cmd` en la barra de direcciones y ejecuta:

   ```bash
   py bridge\server.py --lan
   ```

3. Abre la app en el ordenador o el icono en el móvil.

### Para hacer una operación

1. En **Cotizaciones**, toca el símbolo, por ejemplo **EURUSD**.
2. Pon el **Stop loss**. Es obligatorio: es el precio al que la operación se cierra si va mal.
3. En **Riesgo**, escribe cuánto dinero aceptas perder como máximo, por ejemplo `20`, y pulsa **Lotes por riesgo**.
4. Pulsa **Revisar**, lee el resumen y **Confirma**.
5. La operación aparece en **Posiciones abiertas**. Desde ahí puedes **Cerrar** o mover el stop a la entrada.

### Para que opere solo (bot automático)

El bot es un **comité de 24 analistas** que votan en cada vela (cada 5 minutos). Cuando **el 75 % o más**
de los votos van al mismo lado (comprar o vender), el bot pone **stop loss** y **take profit** y abre la
operación **solo**, con el riesgo que tú elijas.

1. Arranca la ventana negra así (con `--auto` el bot empieza a operar solo):

   ```bash
   py bridge\server.py --lan --auto
   ```

2. En la app, en **Tu riesgo**, pon cuánto arriesgas por operación (por ejemplo `20`) y la **pérdida máxima
   del día** (por ejemplo `60`). Pulsa **Guardar riesgo**.
3. En **Analistas › Comité de analistas** ves los votos en vivo de cada símbolo. Puedes cambiar el 75 %,
   los símbolos (vacío = todos), las velas (M5 por defecto) y conectar o desconectar cada analista.
4. Arriba tienes **Apagar piloto** / **Encender piloto**. Se apaga solo si llegas a la pérdida máxima del día.

El bot vive en el **ordenador**, no en el móvil: el móvil es el mando. Mientras el ordenador, MetaTrader y la
ventana negra estén abiertos, opera aunque cierres el móvil. Para operar, el robot de MetaTrader necesita
**AllowTrading = true** y el botón **Algo Trading** en verde.

---

## Si algo falla

| Lo que ves | Qué hacer |
| --- | --- |
| `py` no se reconoce | Reinstala Python marcando **"Add python.exe to PATH"** |
| La app dice "esperando al EA" | Comprueba que MetaTrader está abierto y que el robot está en un gráfico |
| En Expertos aparece el error **4014** | Repite la Parte 3, Paso 4 (permiso WebRequest) |
| "Token incorrecto" | Vuelve a copiar el token de la ventana negra en el robot y en la app |
| "Trading desactivado" | Pon `AllowTrading = true` en el robot y activa **Algo Trading** |
| El móvil no abre la app | Misma WiFi; puente arrancado con `--lan`; acepta el aviso del **firewall** de Windows (redes privadas) |
| Un analista dice "calentando" | Está cargando velas; espera un poco |
| Señal "Bloqueada" | Lee el motivo (ya hay posición en ese símbolo, stop muy cerca, límite diario...) |
| "Orden rechazada por riesgo" | Acerca el stop o arriesga menos dinero |

¿Quieres más detalle? Mira el [README](README.md).
