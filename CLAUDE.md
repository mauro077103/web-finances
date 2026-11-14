# web-finances

- `index.html`: foro de inversores (Firebase, script `type="module"`) + pestañas Mesa de Trading y MetaTrader.
- `trading-desk.js`: Mesa de Trading, sin dependencias. Lee los JSON que escriben las skills
  `/trader-*` (en `.claude/skills/`) en `trader/`. Detecta cada archivo por su contenido
  (`detectKind`), no por su nombre. Si cambias el formato que espera, revisa el script de la skill
  que lo escribe.
- `mt5.js`: pestaña MetaTrader en vivo. Habla con `bridge/server.py` por SSE (`/api/stream`) y POST
  (`/api/order`, `/api/close`, `/api/modify`, `/api/bars`), con el token en `X-Token`.
- `bridge/server.py`: puente (solo stdlib). Fuentes `ea` (por defecto), `python` (paquete MetaTrader5)
  y `demo` (simulador). El EA habla con `/mt5/push`, `/mt5/result`, `/mt5/bars`; los comandos al EA van
  en texto plano `ORDER;id;...` (ver `ea_line`). Si cambias ese formato, cambia también `HandleCommand`
  en `mt5/WebFinancesBridge.mq5`.
- `bridge/analysts.py`: analistas (estrategias) que viven en el puente, construyen velas con los ticks en
  tiempo real y emiten señales al cierre de vela; piloto automático (`AnalystDesk`). Analistas externos
  envían señales por `POST /api/signal` (`bridge/enviar_senal.py`). La app los conecta/desconecta y edita el
  riesgo (`/api/desk/analyst`, `/api/desk/settings`, `/api/desk/auto`), guardado en `bridge/settings.json`.
- `bridge/committee.py`: comité de 24 analistas que votan cada vela (+1/-1/0); con ≥ umbral (75 %) de los votos
  emitidos y quórum, da la señal con SL = N×ATR y TP = R×SL. Externos votan con `POST /api/vote`.
- Seguridad, mantenla así: stop loss obligatorio; riesgo y lotes máximos validados en el puente y otra
  vez en el EA (el techo del EA no se cambia desde la app); cuentas reales bloqueadas salvo `--allow-live` y
  `AllowLiveAccount=true`; el EA no opera salvo `AllowTrading=true`. Las órdenes manuales se confirman en la
  app; las automáticas solo salen con el piloto encendido desde la app (con confirmación), de analistas en
  modo "automatico", y pasan por `validate_order`. El piloto arranca apagado salvo `--auto` (decisión
  explícita al arrancar) y se apaga solo al alcanzar la pérdida máxima del día. El puente solo sirve los archivos de la app
  (nunca `bridge/`, `.git`, `.claude`) y `trader/` exige token.
- `trader/`, `bridge/.token` y `bridge/settings.json` contienen datos personales y están en `.gitignore`.
- Todo texto de usuario, de Firestore o de MetaTrader se escapa con `esc()` antes de ir a `innerHTML`.
- Prueba rápida: `python3 bridge/server.py --demo` y abrir la URL que imprime.
