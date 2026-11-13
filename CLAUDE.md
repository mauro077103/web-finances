# web-finances

- `index.html`: foro de inversores (Firebase, script `type="module"`) + pestaña Mesa de Trading.
- `trading-desk.js`: Mesa de Trading, sin dependencias. Lee los JSON que escriben las skills
  `/trader-*` (instaladas en `.claude/skills/`) en `trader/`. Detecta cada archivo por su contenido
  (`detectKind`), no por su nombre. Si cambias el formato que espera, revisa el script de la skill
  que lo escribe.
- `trader/` contiene datos personales (órdenes, límites, email SEC) y está en `.gitignore`.
- Nada en la app puede enviar órdenes. Las órdenes solo pasan por `/trader-broker`, tras
  `/trader-risk` PASS y el "sí" explícito del usuario. Paper trading por defecto.
- Todo texto de usuario o de Firestore se escapa con `esc()` antes de ir a `innerHTML`.
