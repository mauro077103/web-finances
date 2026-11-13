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
- Seguridad, mantenla así: stop loss obligatorio; riesgo y lotes máximos validados en el puente y otra
  vez en el EA; cuentas reales bloqueadas salvo `--allow-live` y `AllowLiveAccount=true`; el EA no opera
  salvo `AllowTrading=true`; toda orden se confirma en la app. El puente solo sirve los archivos de la app
  (nunca `bridge/`, `.git`, `.claude`) y `trader/` exige token.
- `trader/` y `bridge/.token` contienen datos personales y están en `.gitignore`.
- Todo texto de usuario, de Firestore o de MetaTrader se escapa con `esc()` antes de ir a `innerHTML`.
- Prueba rápida: `python3 bridge/server.py --demo` y abrir la URL que imprime.
