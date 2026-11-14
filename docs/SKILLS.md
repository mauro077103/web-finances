# Skills de Claude Code instaladas

Este proyecto incluye skills de Claude Code en `.claude/skills/`. Cada carpeta es una skill con su `SKILL.md`. Se invocan con `/<nombre>` dentro de Claude Code, o Claude las carga solo cuando la petición encaja con su descripción.

- **Skills de terceros añadidas en esta instalación:** 105, de 5 repositorios.
- **Skills que ya estaban:** las 11 `trader-*` de day-trader-skill. No se han tocado y no se describen aquí.
- **Tamaño de `.claude/skills/`:** unos 9,1 MB de contenido (unos 12-13 MB en disco), incluidas las `trader-*`.
- **Licencias:** en `.claude/skills/LICENSES/`. Todos los repositorios usados son MIT, salvo stock-checker, que no tiene licencia (ver la sección [stock-checker](#5-stock-checker-gracefullightstock-checker-carpeta-agents-commit-6ebf9be)).

> **Importante: ninguna de estas skills opera por sí sola.** Ninguna de las 105 skills nuevas envía, modifica ni cancela órdenes en un bróker. Producen análisis, informes, screenings, cálculos de tamaño de posición, planes de trade o JSON de órdenes *propuestas*. Las que leen una cuenta de Alpaca (`portfolio-manager` y el adaptador de inventario de `parabolic-short-trade-planner`) solo hacen peticiones GET de lectura. `mt5-robot-tester` solo lanza el *Strategy Tester* de MetaTrader 5, que hace backtests y no opera en real. La única skill del proyecto que puede mandar una orden a un bróker sigue siendo la `trader-broker` que ya estaba. Para eso necesita que configures el MCP de Alpaca, que **no** está en `.mcp.json`, y pide tu "sí" explícito antes de cada orden. Nada de esto es asesoramiento financiero.

## Requisitos comunes

| Requisito | Para qué |
|---|---|
| `python3` (≥3.10) y `pip install -r .claude/skills/<skill>/requirements.txt` | Skills con carpeta `scripts/` (sobre todo claude-trading-skills) |
| `pip install yfinance pandas numpy` | Skills de finance-skills basadas en Yahoo Finance |
| `uv` / `uvx` | Servidores MCP (`fetch`, `time`), `stock-analysis` (usa `uv run` con dependencias en línea) |
| `FMP_API_KEY` | [Financial Modeling Prep](https://site.financialmodelingprep.com/): muchos screeners de claude-trading-skills (con el plan gratuito algunos endpoints van limitados) |
| `FINVIZ_API_KEY` | FinViz Elite. Es opcional en la mayoría de los casos; sin ella se usa la web pública |
| `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` (+ `ALPACA_PAPER=true`) | Solo lectura de cartera o inventario de cortos en Alpaca |
| `FINTEL_API_KEY`, `ADANOS_API_KEY`, `FXMACRODATA_API_KEY` | Una skill cada una (ver tablas) |
| WebSearch / WebFetch de Claude | Las skills sin scripts (ai-trading-claude, maia, varias de análisis) buscan los datos en la web |

Las claves van en variables de entorno o en un `.env` local que no se sube al repositorio. **Nunca** deben ir en `.mcp.json` ni en los `SKILL.md`.

---

## 1. maia-skill (Hainrixz/maia-skill) — MIT

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/investment-analysis` | Análisis multiagente (cripto, acciones, divisas y materias primas) adaptado a tu perfil de riesgo. Genera un informe interactivo bilingüe EN/ES con un descargo educativo. | WebSearch/WebFetch (CoinGecko, Yahoo y Frankfurter, sin clave); Node.js ≥18 para el dashboard Next.js (`npm install` la primera vez) o python3 para el HTML de respaldo. Opcionales: `FINNHUB_API_KEY` y `POLYGON_API_KEY` |

Notas: la skill escribe sus informes e historial en `~/.claude/cache/tododeia` (fuera del repositorio, a propósito) y levanta un servidor local en el puerto 3420 (o en 8420-8425). Se quitaron las imágenes de `docs/` y los JSON de ejemplo del dashboard.

## 2. ai-trading-claude (zubair-trabzada/ai-trading-claude) — MIT

Todas funcionan con WebSearch y no necesitan claves de API. Escriben ficheros `TRADE-*.md` en el directorio actual.

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/trade` | Orquestador: enruta `/trade <comando>` a las subskills | Nada |
| `/trade-analyze` | Análisis completo con 5 subagentes en paralelo y una puntuación compuesta de 0 a 100 | Nada (usa subagentes) |
| `/trade-quick` | Ficha rápida de un valor en unos 60 segundos | Nada |
| `/trade-technical` | Análisis técnico: tendencia, indicadores, patrones, soportes y resistencias | Nada |
| `/trade-fundamental` | Análisis fundamental: valoración, crecimiento, márgenes, balance y foso competitivo | Nada |
| `/trade-sentiment` | Sentimiento de noticias, redes, analistas, insiders e interés en corto | Nada |
| `/trade-sector` | Rotación sectorial y momentum por sectores | Nada |
| `/trade-compare` | Comparativa cara a cara de dos tickers | Nada |
| `/trade-thesis` | Tesis de inversión con casos alcista y bajista, catalizadores y entrada/salida | Nada |
| `/trade-options` | Ideas de estrategias con opciones según la volatilidad implícita y la vista direccional | Nada |
| `/trade-portfolio` | Análisis de cartera y propuestas de rebalanceo | Nada |
| `/trade-risk` | Riesgo y tamaño de posición (Kelly, porcentaje fijo, ajustado por volatilidad) | Nada |
| `/trade-screen` | Screener por estrategia o con criterios en lenguaje natural | Nada |
| `/trade-earnings` | Análisis previo a resultados y movimiento esperado | Nada |
| `/trade-watchlist` | Watchlist puntuada con alertas de niveles y catalizadores | Nada |
| `/trade-report-pdf` | Une los `TRADE-*.md` en un informe PDF | `pip install reportlab` (script en `trade/scripts/`) |

Cambios locales: se añadió el frontmatter (`name` y `description`) a 6 `SKILL.md` que no lo tenían (`trade`, `trade-earnings`, `trade-portfolio`, `trade-report-pdf`, `trade-screen` y `trade-watchlist`). También se cambió la ruta del script del PDF de `~/.claude/skills/trade/scripts` a `.claude/skills/trade/scripts`, y ahora se le pasa el JSON como argumento. Sin ese argumento, el script generaba un PDF de demostración. Los 5 "agents" del repositorio no se instalaron porque `trade-analyze` lanza subagentes genéricos.

No confundas `trade-risk` (análisis de riesgo de un valor) con la `trader-risk` que ya estaba (control de límites antes de enviar una orden).

## 3. claude-trading-skills (tradermonty/claude-trading-skills) — MIT

Se instalaron 70 de las 74 skills. Los requisitos de Python de cada skill están en su `requirements.txt`.

### Mercado y régimen

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/market-breadth-analyzer` | Salud de la amplitud del mercado: puntuación 0-100 con los CSV públicos de TraderMonty | requests |
| `/uptrend-analyzer` | Diagnóstico del mercado con el Uptrend Ratio Dashboard | requests |
| `/breadth-chart-analyst` | Interpreta los gráficos de amplitud (S&P 500 200MA y Uptrend Ratio) | numpy, opencv-python-headless, Pillow |
| `/market-top-detector` | Riesgo de techo de mercado (días de distribución, deterioro de líderes, rotación defensiva) | `FMP_API_KEY`, pandas-market-calendars, yfinance |
| `/ftd-detector` | Detecta Follow-Through Days (O'Neil) que confirman suelos | `FMP_API_KEY` |
| `/ibd-distribution-day-monitor` | Cuenta los días de distribución IBD en QQQ/SPY | `FMP_API_KEY`, PyYAML |
| `/macro-regime-detector` | Cambios de régimen macro (1-2 años) a partir de ratios entre activos | `FMP_API_KEY` (opcional) y yfinance |
| `/market-environment-analysis` | Informe del entorno global: índices, divisas, materias primas y rendimientos | pandas-market-calendars y WebSearch |
| `/us-market-bubble-detector` | Riesgo de burbuja (marco Minsky/Kindleberger) | WebSearch |
| `/exposure-coach` | Resumen de postura: techo de exposición neta y si se permiten entradas nuevas | Salidas de otras skills; `FMP_API_KEY` opcional |
| `/crypto-regime-analyzer` | Régimen del mercado cripto, 0-100 (CoinGecko y funding de Binance) | requests (sin clave) |
| `/sector-analyst` | Rotación sectorial y fase del ciclo (CSV público) | requests |
| `/theme-detector` | Temas de mercado en tendencia entre sectores | yfinance, finvizfinance, pandas; FMP y Finviz opcionales |
| `/market-news-analyst` | Impacto de las noticias recientes en acciones y materias primas | WebSearch |
| `/scenario-analyzer` | Escenarios a 18 meses a partir de un titular | WebSearch |
| `/stanley-druckenmiller-investment` | Sintetiza 8 skills previas en una postura al estilo Druckenmiller | Salidas de otras skills |
| `/economic-calendar-fetcher` | Calendario económico (bancos centrales, empleo, IPC, PIB) | `FMP_API_KEY` |
| `/fxmacrodata-calendar` | Calendario macro oficial de FXMacroData para filtrar riesgo de eventos | `FXMACRODATA_API_KEY` |
| `/earnings-calendar` | Próximas publicaciones de resultados en EE. UU. | `FMP_API_KEY` |
| `/downtrend-duration-analyzer` | Histograma HTML de la duración de las correcciones por sector y capitalización | `FMP_API_KEY`, pandas, numpy |
| `/data-quality-checker` | Revisa la calidad de los datos en artículos de mercado antes de publicarlos (escalas, fechas, cifras) | Nada |

### Screeners y análisis de valores

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/canslim-screener` | Screener CANSLIM (O'Neil) | `FMP_API_KEY`, beautifulsoup4, lxml |
| `/vcp-screener` | Patrones VCP de Minervini en el S&P 500 | `FMP_API_KEY` |
| `/pead-screener` | Deriva tras resultados (PEAD) en valores con gap alcista | `FMP_API_KEY` |
| `/earnings-trade-analyzer` | Puntúa la reacción tras resultados con 5 factores | `FMP_API_KEY`, pandas-market-calendars |
| `/finviz-screener` | Construye y abre URLs de FinViz a partir de lenguaje natural | `FINVIZ_API_KEY` opcional (Elite) |
| `/value-dividend-screener` | Dividendos de calidad con valoración razonable | `FMP_API_KEY`; Finviz opcional |
| `/dividend-growth-pullback-screener` | Crecimiento de dividendo con retroceso temporal (RSI) | `FMP_API_KEY`; Finviz opcional |
| `/us-undervalued-growth-screener` | Screener GARP autónomo del mercado de EE. UU. con verificación de fuentes | `FMP_API_KEY` (muchas llamadas) |
| `/us-stock-analysis` | Análisis completo de un valor (fundamental, técnico y comparativo) | WebSearch |
| `/technical-analyst` | Análisis técnico de gráficos semanales (acciones, índices, cripto y forex) | `FMP_API_KEY` opcional |
| `/institutional-flow-tracker` | Cambios de propiedad institucional (13F) | `FMP_API_KEY` |
| `/pair-trade-screener` | Pares cointegrados para arbitraje estadístico | `FMP_API_KEY`, numpy, pandas, scipy, statsmodels |
| `/options-strategy-advisor` | Black-Scholes, griegas y simulación de P/L de estrategias | numpy, scipy |
| `/cot-contrarian-detector` | Posicionamiento especulativo extremo en el COT de la CFTC (Shapiro) | `FMP_API_KEY` |
| `/news-reaction-failure-analyzer` | Mercado que no reacciona a noticias favorables (paso 2 de Shapiro) | `FMP_API_KEY` |
| `/contrarian-setup-gate` | Une los 3 veredictos contrarian en una sola decisión | Salidas de otras skills |
| `/parabolic-short-trade-planner` | Detecta subidas parabólicas y prepara planes condicionales de corto | `FMP_API_KEY`; Alpaca opcional (solo lectura) |
| `/breakout-trade-planner` | Planes de ruptura estilo Minervini a partir del VCP (JSON compatible con Alpaca, **sin enviarlo**) | pandas-market-calendars |
| `/stockbee-20pct-study` | Estudio diario de movimientos de ±20 % al estilo Stockbee | `FMP_API_KEY` |
| `/stockbee-episodic-pivot-analyzer` | Episodic Pivots de día 1 (resultados, M&A, FDA…) | `FMP_API_KEY` |
| `/stockbee-exhaustion-hammer-screener` | Martillos de agotamiento vendedor | `FMP_API_KEY` |
| `/stockbee-momentum-burst-screener` | Momentum Bursts de corto plazo | `FMP_API_KEY`, pandas-market-calendars |
| `/stockbee-setup-fluency-trainer` | Libro de setups con resultados a 3 y 5 días (MFE y MAE) | `FMP_API_KEY` |

### Gestión de riesgo, cartera y disciplina

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/position-sizer` | Tamaño de posición por riesgo en largos de acciones | Nada |
| `/futures-position-sizer` | Número de contratos de futuros con multiplicador y tick verificados | Nada |
| `/pre-trade-discipline-gate` | Checklist antes de cada orden manual (bloquea trades sin plan o sobredimensionados) | PyYAML |
| `/drawdown-circuit-breaker` | Decide si se permite riesgo nuevo hoy según el drawdown de la cuenta | pandas-market-calendars, PyYAML |
| `/portfolio-manager` | Análisis de cartera leyendo posiciones de Alpaca (solo lectura) | `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` o el MCP de Alpaca |
| `/trader-memory-core` | Registro del ciclo de vida de cada tesis, de la idea al postmortem | PyYAML |
| `/weekly-performance-digest` | Resumen semanal: win rate, expectativa, R y MAE/MFE | PyYAML |
| `/trade-performance-coach` | Coaching sobre tu historial de operaciones | PyYAML |
| `/signal-postmortem` | Resultado posterior de las señales (falsos positivos, oportunidades perdidas) | `FMP_API_KEY` |
| `/kanchi-dividend-sop` | Procedimiento de inversión por dividendos estilo Kanchi | `FMP_API_KEY` |
| `/kanchi-dividend-review-monitor` | Disparadores de revisión de una cartera de dividendos (sin vender automáticamente) | Nada |
| `/kanchi-dividend-us-tax-accounting` | Fiscalidad de dividendos en EE. UU. y ubicación por tipo de cuenta | Nada |

### Investigación de estrategias y backtesting

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/backtest-expert` | Guía para hacer backtests rigurosos y de estrés | Nada |
| `/manifoldbt-backtester` | Backtest declarativo con el motor manifoldbt (Rust) | `pip install manifoldbt`, pandas |
| `/residual-edge-analyzer` | Separa el edge residual de la exposición a factores (OLS y HAC) | Nada |
| `/strategy-pivot-designer` | Propone cambios de estrategia cuando el ajuste de parámetros se estanca | PyYAML |
| `/trade-hypothesis-ideator` | Genera hipótesis de trading verificables | PyYAML |
| `/edge-candidate-agent` | Tickets de investigación de edge a partir de datos EOD | numpy, pandas, PyYAML; `uv` para validar |
| `/edge-hint-extractor` | Extrae pistas de edge de observaciones y noticias | PyYAML |
| `/edge-concept-synthesizer` | Convierte pistas en conceptos de edge reutilizables | PyYAML |
| `/edge-strategy-designer` | Convierte conceptos en borradores de estrategia | PyYAML |
| `/edge-strategy-reviewer` | Revisa los borradores de estrategia | PyYAML |
| `/edge-signal-aggregator` | Agrega y ordena señales de varias skills de edge | PyYAML |
| `/edge-pipeline-orchestrator` | Orquesta todo el pipeline de edge | PyYAML |
| `/mt5-robot-tester` | Lanza backtests de Expert Advisors de MetaTrader 5 con el Strategy Tester y saca un ranking | MetaTrader 5 (`terminal64.exe`, Windows) |
| `/trading-skills-navigator` | Recomienda qué skill de esta colección usar para cada objetivo | PyYAML |

Notas: se quitaron los tests, las imágenes de ejemplo (`sector-analyst` y `breadth-chart-analyst`) y algunos JSON de ejemplo grandes que no se usaban. Las rutas entre skills de `edge-pipeline-orchestrator` siguen funcionando, porque resuelve `.claude/skills/<skill>`.

## 4. finance-skills (himself65/finance-skills) — MIT

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/yfinance-data` | Datos de Yahoo Finance: cotizaciones, históricos, estados financieros, opciones, dividendos | yfinance |
| `/earnings-preview` | Briefing antes de resultados: consenso, historial de sorpresas y precios objetivo | yfinance |
| `/earnings-recap` | Resumen de los últimos resultados: EPS real frente a estimado y reacción del precio | yfinance |
| `/estimate-analysis` | Revisiones de estimaciones de analistas y dispersión | yfinance |
| `/company-valuation` | Valoración DCF, por múltiplos y SOTP, con sensibilidad WACC/g | yfinance, numpy, pandas |
| `/stock-correlation` | Correlaciones, beta y pares relacionados entre valores | yfinance, pandas, numpy |
| `/stock-liquidity` | Liquidez: spreads, ADTV, impacto de mercado y Amihud | yfinance, pandas, numpy |
| `/etf-premium` | Prima o descuento de un ETF frente al NAV y su descomposición (gamma, arbitraje) | yfinance, pandas, numpy |
| `/options-payoff` | Gráfico interactivo del payoff de estrategias con opciones (Black-Scholes) | Nada (yfinance opcional para el spot) |
| `/sepa-strategy` | Método SEPA de Minervini: trend template, VCP y pivots | yfinance |
| `/saas-valuation-compression` | Compresión de múltiplos ARR entre rondas de una SaaS privada | WebSearch |
| `/finance-sentiment` | Sentimiento de Reddit, X, noticias y Polymarket (API de Adanos) | `ADANOS_API_KEY` |
| `/fintel-data` | Interés en corto, 13F, insiders y precios objetivo de Fintel (solo GET) | `FINTEL_API_KEY` |
| `/hormuz-strait` | Estado del Estrecho de Ormuz (petroleros, Brent, seguros) | `curl` (sin clave) |
| `/hyperliquid-reader` | Datos de mercado de Hyperliquid (funding, OI, libro de órdenes), solo lectura | Node ≥24 con `npm install -g @jackwener/opencli` y el plugin `hyperliquid` (paquetes de terceros, revísalos antes de instalarlos) |
| `/tradingview-mcp` | Lecturas técnicas, scans y futuros de TradingView a través de un servidor MCP | **Servidor MCP de terceros no configurado** (`atilaahmettaner/tradingview-mcp`). La skill no hace nada hasta que se añada a mano |

Nota: varias de estas skills incluyen comandos `` !`...` `` que Claude Code ejecuta al cargar la skill. Son comprobaciones inofensivas (si `yfinance` está instalado, si existe la variable de la clave), pero se ejecutan solas.

## 5. stock-checker (gracefullight/stock-checker, carpeta `.agents`, commit 6ebf9be)

> ⚠️ **Sin licencia.** El repositorio no tiene un fichero LICENSE ni campo `license`, así que no hay nada que copiar en `LICENSES/`. Ambas skills vienen de terceros: `stock-analysis` es de udiedrichsen y se publicó en clawdbot/skills; `backtesting-trading-strategies` declara MIT y autor Jeremy Longshore en su frontmatter. Revisa los derechos antes de redistribuirlas.

| Skill | Para qué sirve | Necesita |
|---|---|---|
| `/stock-analysis` | Puntuación de acciones y cripto en 8 dimensiones (resultados, fundamentales, analistas, sentimiento, riesgo geopolítico). También gestiona carteras | `uv` (instala yfinance, pandas, fear-and-greed, edgartools y feedparser con `uv run`). Guarda las carteras en `~/.clawdbot/skills/stock-analysis/portfolios.json`, fuera del repositorio |
| `/backtesting-trading-strategies` | Backtest de 8 estrategias (SMA, RSI, MACD…) con métricas y optimización de parámetros | pandas, numpy, yfinance, matplotlib |

Cambio local: en `stock-analysis/scripts/portfolio.py` se cambió `except OSError, json.JSONDecodeError:` por `except (OSError, json.JSONDecodeError):`. La forma sin paréntesis solo es válida desde Python 3.14.

---

## Excluidas y por qué

| Origen | Skill(s) | Motivo |
|---|---|---|
| finance-skills | `social-readers` (twitter-reader, linkedin-reader, discord-reader, telegram-reader, opencli-reader, yc-reader) | Leen Twitter/X, LinkedIn, Discord y Telegram con las cookies de sesión del usuario |
| finance-skills | `tradingview-reader` | Mismo problema que las anteriores: cierra y relanza la app de escritorio de TradingView con `--remote-debugging-port=9222` y lee sus cookies de sesión por CDP. Ese puerto deja la sesión iniciada a merced de cualquier proceso local. Además, solo funciona en macOS y necesita `npm install -g` de un paquete de terceros |
| finance-skills | `skill-creator` | Choca con la `skill-creator` que ya existe |
| finance-skills | `generative-ui`, `startup-analysis` | No son de mercados ni de trading (diseño de UI genérico y análisis de startups, VC y ofertas de empleo) |
| claude-trading-skills | `skill-designer`, `skill-idea-miner`, `skill-integration-tester`, `dual-axis-skill-reviewer` | Meta-skills de desarrollo de skills. Además, `skill-idea-miner` lee los logs de sesión de `~/.claude/projects/` y llama al CLI `claude` |
| stock-checker | `yahoo-finance` | No funciona: su comando `yf` no viene en la carpeta. También indica instalar `uv` con `curl … \| sh` y enlazar el script en `/usr/local/bin` |
| stock-checker | `Financial Data Fetcher`, `trading-analysis` | Solo documentación: los scripts a los que remiten (`scripts/fetch_data.py` y el generador de informes) no están. `trading-analysis` pide además `ANTHROPIC_API_KEY` en `.env` |
| stock-checker | `oma-*` (≈37 skills: pm, debug, qa, scm, db, frontend, backend, design, market, etc.), `_shared`, `biome-validator`, `typescript-type-expert` | Flujo de trabajo de desarrollo genérico, no finanzas. `oma-market` hace estudios de mercado de producto (SWOT, Porter), no de mercados financieros. Los dos últimos son enlaces simbólicos rotos a `/Users/gracefullight/...` |
| ai-trading-claude | `agents/*.md`, `install.sh` | El instalador escribe en `~/.claude/` del usuario; aquí se instaló a mano en el proyecto. Los agentes no hacen falta |
| maia-skill | `install.sh`, `docs/` (imágenes) | El instalador clona en `~/.claude/plugins` y hace `npm install`; aquí se copió a mano |

No se ha encontrado ningún indicio de malware: ni exfiltración de variables o claves, ni `curl | bash` en los scripts, ni código remoto evaluado, ni blobs ofuscados, ni persistencia (crontab o launchd) en lo instalado, ni instrucciones para saltarse al usuario o enviar órdenes reales sin confirmación. El `NOTICE` de maia-skill lleva una marca de agua invisible (caracteres de ancho cero) que codifica `er-805c9b73`, el id del autor. Es inofensiva.

---

## Servidores MCP (`.mcp.json`)

Son servidores de referencia de [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers). Se han añadido solo los que aportan algo a la app:

| Servidor | Lanzamiento | Para qué | Necesita |
|---|---|---|---|
| `fetch` | `uvx mcp-server-fetch` | Descargar páginas web y convertirlas a Markdown (noticias, filings, documentación de APIs) | `uv`/`uvx` y Python. Sin claves. Respeta `robots.txt` y rechaza direcciones privadas por defecto |
| `time` | `uvx mcp-server-time` | Hora actual y conversión de zonas horarias (p. ej. Madrid ↔ Nueva York para las sesiones de mercado) | `uv`/`uvx`. Sin claves. Usa la zona del sistema; se puede fijar con `--local-timezone=Europe/Madrid` en `args` |

No se añadieron `filesystem` ni `git`, porque Claude Code ya tiene esas capacidades. Tampoco `memory`, `sequentialthinking` ni `everything` (este último es un servidor de pruebas). El `.mcp.json` no contiene secretos. Claude Code pedirá aprobar los servidores del proyecto la primera vez.
