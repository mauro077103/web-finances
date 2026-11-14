/*
 * Mesa de Trading
 * ----------------
 * Panel 100 % local que lee los archivos que escriben las skills /trader-* de Claude
 * (https://github.com/Jakeschincariol/day-trader-skill, instaladas en .claude/skills/)
 * dentro de la carpeta trader/ del proyecto:
 *
 *   trader/watchlist.json     /trader-scanner      setups encontrados
 *   trader/entry.json         /trader-entry        señal de entrada
 *   trader/plan.json          /trader-exit         entrada, stop, objetivo
 *   trader/timemachine.json   /trader-timemachine  10.000 simulaciones + histórico
 *   trader/orders.json        /trader-budget       orden bracket propuesta
 *   trader/state/risk.json    /trader-risk         veredictos PASS / BLOCK
 *   trader/state/broker.json  /trader-broker       aprobaciones, órdenes y ejecuciones
 *   trader/prices.json, trader/alerts.json, trader/state/alerts.json   /trader-alerts
 *   trader/config.json, trader/portfolio.json, trader/metrics.json
 *
 * Nada aquí envía órdenes a un bróker: la app solo lee y muestra. Las órdenes las
 * gestiona /trader-broker en Claude, siempre con tu "sí" explícito.
 */
(function () {
    'use strict';

    const STORE_KEY = 'tradingDesk.files.v1';

    // Clave lógica -> ruta dentro del proyecto (para cargar con fetch desde un servidor local).
    const PATHS = {
        watchlist: 'trader/watchlist.json',
        entry: 'trader/entry.json',
        plan: 'trader/plan.json',
        timemachine: 'trader/timemachine.json',
        orders: 'trader/orders.json',
        risk: 'trader/state/risk.json',
        broker: 'trader/state/broker.json',
        prices: 'trader/prices.json',
        alerts: 'trader/alerts.json',
        alertState: 'trader/state/alerts.json',
        config: 'trader/config.json',
        portfolio: 'trader/portfolio.json',
        metrics: 'trader/metrics.json',
        news: 'trader/state/news.json',
    };

    // El flujo de un trade, en el orden del README de la skill.
    const PIPELINE = [
        { cmd: 'trader-scanner', label: 'Escáner', key: 'watchlist', what: 'Busca setups (ruptura del rango de apertura, banderas, sobreventa).' },
        { cmd: 'trader-news', label: 'Noticias', key: 'news', what: 'Titulares y 8-K de tu watchlist.', optional: true },
        { cmd: 'trader-entry', label: 'Entrada', key: 'entry', what: 'Vigila el setup vela a vela y avisa del momento de entrar.' },
        { cmd: 'trader-exit', label: 'Salida', key: 'plan', what: 'Fija stop y objetivo antes de entrar.' },
        { cmd: 'trader-timemachine', label: 'Máquina del tiempo', key: 'timemachine', what: 'Repite la sesión 10.000 veces y el histórico del setup.' },
        { cmd: 'trader-budget', label: 'Tamaño', key: 'orders', what: 'Calcula acciones según tu pérdida máxima y escribe la orden bracket.' },
        { cmd: 'trader-risk', label: 'Riesgo', key: 'risk', what: 'PASS o BLOCK contra tus límites.' },
        { cmd: 'trader-broker', label: 'Bróker', key: 'broker', what: 'Muestra el ticket y solo envía con tu "sí" (paper por defecto).' },
    ];

    // Paleta (validada para daltonismo sobre el fondo oscuro): objetivo azul, stop naranja.
    const C = { target: '#60a5fa', stop: '#f97316', neither: '#64748b', band: '#60a5fa', text: '#e2e8f0', muted: '#94a3b8', grid: '#475569' };

    // Mismos campos que trader-risk/check.py y trader-broker/ticket.py usan para la huella de una orden.
    const ALPACA_FIELDS = ['symbol', 'side', 'qty', 'notional', 'type', 'time_in_force', 'limit_price',
        'stop_price', 'trail_price', 'trail_percent', 'extended_hours', 'client_order_id',
        'order_class', 'take_profit_limit_price', 'stop_loss_stop_price',
        'stop_loss_limit_price', 'advanced_instructions'];

    let files = {};          // clave -> { data, source, loadedAt }
    let isSample = false;
    let root = null;

    // ---------- utilidades ----------
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const fmt = (v, d = 2) => { const n = num(v); return n === null ? '—' : n.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }); };
    const usd = (v) => { const n = num(v); return n === null ? '—' : n.toLocaleString('es-ES', { style: 'currency', currency: 'USD' }); };
    const pct = (v, d = 1) => { const n = num(v); return n === null ? '—' : `${(n * 100).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d })} %`; };
    const get = (k) => files[k] ? files[k].data : null;
    const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

    function storageSave() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ files, isSample })); } catch (e) { /* almacenamiento no disponible o lleno */ }
    }
    function storageLoad() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            files = saved.files || {};
            isSample = Boolean(saved.isSample);
        } catch (e) { files = {}; }
    }

    // Identifica qué archivo es por su contenido (los nombres chocan: alerts.json vs state/alerts.json).
    function detectKind(data, path = '') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        const by = data.created_by;
        if (by === 'trader-scanner' || Array.isArray(data.hits)) return 'watchlist';
        if (by === 'trader-entry') return 'entry';
        if (by === 'trader-exit') return 'plan';
        if (by === 'trader-timemachine' || data.mc) return 'timemachine';
        if (Array.isArray(data.results) && ('pass' in data || 'block' in data)) return 'risk';
        if (Array.isArray(data.orders) && data.orders.some(o => o && o.status && o.at)) return 'broker';
        if (Array.isArray(data.orders)) return 'orders';
        if (Array.isArray(data.rules)) return 'alerts';
        if (data.rung) return 'alertState';
        if (data.prices && typeof data.prices === 'object') return 'prices';
        if (Array.isArray(data.companies)) return 'metrics';
        if (Array.isArray(data.positions) || ('cash' in data && Object.keys(data).length <= 3)) return 'portfolio';
        if ('max_loss_per_trade_usd' in data || 'budget' in data || 'flat_by' in data) return 'config';
        if (data.seen && data.ciks) return 'news';
        if (/state\/broker\.json$/.test(path) && Array.isArray(data.orders)) return 'broker';
        return null;
    }

    function addFile(data, source) {
        const kind = detectKind(data, source);
        if (!kind) return null;
        if (kind === 'timemachine' && data.mc) delete data.mc.sample_paths; // no se usan y ocupan mucho
        files[kind] = { data, source, loadedAt: new Date().toISOString() };
        return kind;
    }

    // ---------- carga de archivos ----------
    async function loadFileList(fileList) {
        const list = Array.from(fileList).filter(f => /\.json$/i.test(f.name));
        if (!list.length) { toast('No hay archivos .json en la selección.', 'error'); return; }
        if (isSample) { files = {}; isSample = false; }
        const loaded = [], skipped = [];
        for (const f of list) {
            const path = f.webkitRelativePath || f.name;
            try {
                const kind = addFile(JSON.parse(await f.text()), path);
                (kind ? loaded : skipped).push(path);
            } catch (e) { skipped.push(path); }
        }
        storageSave();
        render();
        toast(`Cargados ${loaded.length} archivo(s)${skipped.length ? `, ignorados ${skipped.length}` : ''}.`, loaded.length ? 'success' : 'error');
    }

    async function loadFromServer(silent) {
        if (!/^https?:$/.test(location.protocol)) {
            if (!silent) toast('Abre la app con un servidor local (python3 -m http.server) para leer ./trader/ automáticamente.', 'error');
            return;
        }
        const found = {};
        await Promise.all(Object.entries(PATHS).map(async ([key, path]) => {
            try {
                let tok = '';
                try { tok = localStorage.getItem('mt5.token') || ''; } catch (e) { /* sin almacenamiento */ }
                const r = await fetch(path, { cache: 'no-store', headers: tok ? { 'X-Token': tok } : {} });
                if (!r.ok) return;
                const data = await r.json();
                if (detectKind(data, path)) found[key] = { data, path };
            } catch (e) { /* no existe o no es JSON */ }
        }));
        const n = Object.keys(found).length;
        if (n) {
            files = {}; isSample = false;
            Object.values(found).forEach(f => addFile(f.data, f.path));
            storageSave();
            render();
        }
        if (!silent) toast(n ? `Leídos ${n} archivo(s) de ./trader/.` : 'No se encontró nada en ./trader/. Ejecuta primero las skills en Claude.', n ? 'success' : 'info');
    }

    function clearAll() {
        files = {}; isSample = false;
        storageSave();
        render();
    }

    // ---------- huella de orden (idéntica a trader-risk) ----------
    async function fingerprint(order) {
        const core = {};
        ALPACA_FIELDS.slice().sort().forEach(k => { if (order[k] !== undefined && order[k] !== null) core[k] = order[k]; });
        const blob = JSON.stringify(core);
        if (!(window.crypto && crypto.subtle)) return null;
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(blob));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }

    // ---------- avisos ----------
    function toast(msg, type = 'info') {
        const box = document.getElementById('message-box');
        if (!box) return;
        const el = document.createElement('div');
        el.className = `p-4 rounded-lg shadow-md mb-2 text-white ${type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-blue-600'}`;
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(() => el.remove(), 5000);
    }

    function copy(text) {
        const done = () => toast(`Copiado: ${text}`, 'success');
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(done, () => toast('No se pudo copiar.', 'error'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar.', 'error'); }
            ta.remove();
        }
    }

    // ---------- comprobaciones de coherencia entre archivos ----------
    function consistencyWarnings() {
        const w = [];
        const plan = get('plan'), tm = get('timemachine'), orders = get('orders'), entry = get('entry'), risk = get('risk');
        if (plan && tm && tm.plan && (tm.plan.symbol !== plan.symbol || num(tm.plan.entry) !== num(plan.entry) || num(tm.plan.stop) !== num(plan.stop) || num(tm.plan.target) !== num(plan.target))) {
            w.push('La Máquina del tiempo se ejecutó con otro plan. Vuelve a lanzar /trader-timemachine.');
        }
        if (plan && entry && entry.symbol !== plan.symbol) w.push(`La entrada es de ${entry.symbol} pero el plan es de ${plan.symbol}.`);
        if (plan && orders && Array.isArray(orders.orders)) {
            const bracket = orders.orders.find(o => o.plan);
            if (bracket && (bracket.symbol !== plan.symbol || num(bracket.plan.stop) !== num(plan.stop) || num(bracket.plan.target) !== num(plan.target))) {
                w.push('La orden de /trader-budget no coincide con el plan actual. Vuelve a lanzar /trader-budget.');
            }
        }
        if (risk && risk.date && risk.date !== todayNY()) w.push(`La verificación de riesgo es del ${risk.date}, no de hoy: /trader-broker no dará la orden por lista (READY) hasta repetir /trader-risk.`);
        if (plan && plan.date && plan.date !== todayNY()) w.push(`El plan es del ${plan.date}. Un day trade solo vale para su sesión.`);
        return w;
    }

    // ---------- render ----------
    function render() {
        if (!root) return;
        const loadedKeys = Object.keys(files);
        root.innerHTML = `
            <div class="rounded-lg border border-amber-700 bg-amber-900/30 p-3 text-amber-100 text-sm mb-6">
                <b>No es asesoramiento financiero.</b> La mayoría de quienes hacen day trading pierden dinero.
                Esta mesa solo <b>lee y muestra</b> lo que generan las skills de Claude; no puede enviar órdenes.
                Empieza siempre en <b>paper trading</b>.
            </div>

            <div id="desk-drop" class="desk-card mb-6">
                <h3>Cargar datos de <code>trader/</code></h3>
                <p class="text-sm text-slate-300 mb-3">Ejecuta las skills <code>/trader-*</code> en Claude Code dentro de este proyecto; escriben en <code>trader/</code>.
                Luego carga esa carpeta aquí (o arrastra los .json). Con un servidor local se lee sola.</p>
                <div class="flex flex-wrap gap-2">
                    <label class="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-3 rounded-lg">
                        Elegir carpeta trader/
                        <input type="file" id="desk-dir" class="hidden" webkitdirectory directory multiple>
                    </label>
                    <label class="cursor-pointer bg-slate-600 hover:bg-slate-500 text-white text-sm font-semibold py-2 px-3 rounded-lg">
                        Elegir archivos .json
                        <input type="file" id="desk-files" class="hidden" accept=".json,application/json" multiple>
                    </label>
                    <button type="button" data-act="fetch" class="bg-slate-600 hover:bg-slate-500 text-white text-sm font-semibold py-2 px-3 rounded-lg">Leer ./trader/</button>
                    <button type="button" data-act="sample" class="bg-slate-600 hover:bg-slate-500 text-white text-sm font-semibold py-2 px-3 rounded-lg">Ver ejemplo (TSLA)</button>
                    ${loadedKeys.length ? `<button type="button" data-act="clear" class="text-sm text-slate-300 hover:text-white py-2 px-3">Vaciar</button>` : ''}
                </div>
                ${isSample ? `<p class="mt-3 text-xs text-amber-200">Mostrando el ejemplo del README de la skill (TSLA, 19-oct-2026). Las bandas del gráfico son ilustrativas.</p>` : ''}
                ${loadedKeys.length ? `<p class="mt-3 text-xs text-slate-400">Cargado: ${loadedKeys.map(k => `<code>${esc(PATHS[k] || k)}</code>`).join(' · ')}</p>` : ''}
            </div>

            ${renderPipeline()}
            ${renderWarnings()}
            ${loadedKeys.length ? '' : `<p class="text-slate-400 mb-6">Todavía no hay datos. Pulsa <b>Ver ejemplo (TSLA)</b> para ver cómo se ve un trade completo.</p>`}

            <div class="grid gap-4 md:grid-cols-2">
                ${renderPlan()}
                ${renderEntry()}
            </div>
            ${renderTimeMachine()}
            <div class="grid gap-4 md:grid-cols-2 mt-4">
                ${renderOrders()}
                ${renderSizer()}
            </div>
            <div class="grid gap-4 md:grid-cols-2 mt-4">
                ${renderWatchlist()}
                ${renderAlerts()}
            </div>
            <div class="grid gap-4 md:grid-cols-2 mt-4">
                ${renderPortfolio()}
                ${renderConfig()}
            </div>
            ${renderBrokerLog()}
            ${renderMetrics()}
        `;
        wire();
        annotateRisk();
        drawFan();
    }

    function renderPipeline() {
        const nextIdx = PIPELINE.findIndex(s => !s.optional && !files[s.key]);
        return `
            <div class="desk-card mb-6">
                <h3>Flujo de un trade</h3>
                <ol class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    ${PIPELINE.map((s, i) => {
                        const done = Boolean(files[s.key]);
                        const next = i === nextIdx;
                        return `
                        <li class="rounded-lg p-3 border ${next ? 'border-blue-400 bg-slate-900/60' : 'border-slate-600'}">
                            <div class="flex items-center justify-between gap-2">
                                <span class="text-sm font-semibold ${done ? 'text-white' : 'text-slate-300'}">${i + 1}. ${esc(s.label)}</span>
                                <span class="text-xs ${done ? 'text-blue-300' : next ? 'text-amber-300' : 'text-slate-500'}">${done ? '✓ hecho' : next ? '→ siguiente' : s.optional ? 'opcional' : 'pendiente'}</span>
                            </div>
                            <p class="text-xs text-slate-400 mt-1">${esc(s.what)}</p>
                            <button type="button" data-copy="/${esc(s.cmd)}" class="mt-2 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-blue-300 rounded px-2 py-1" title="Copiar comando para Claude">/${esc(s.cmd)} ⧉</button>
                        </li>`;
                    }).join('')}
                </ol>
            </div>`;
    }

    function renderWarnings() {
        const w = consistencyWarnings();
        if (!w.length) return '';
        return `<div class="rounded-lg border border-orange-600 bg-orange-900/30 p-3 text-orange-100 text-sm mb-6">
            <b>Revisa antes de operar:</b><ul class="list-disc ml-5 mt-1">${w.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    }

    function stat(label, value, extra = '') {
        return `<div><div class="text-xs text-slate-400">${esc(label)}</div><div class="text-lg font-semibold text-white num">${value}</div>${extra ? `<div class="text-xs text-slate-400">${extra}</div>` : ''}</div>`;
    }

    function renderPlan() {
        const p = get('plan');
        if (!p) return `<div class="desk-card"><h3>Plan (stop y objetivo)</h3><p class="text-sm text-slate-400">Sin <code>trader/plan.json</code>. Ejecuta <code>/trader-exit</code>.</p></div>`;
        return `
            <div class="desk-card">
                <div class="flex items-start justify-between gap-2">
                    <h3>Plan · ${esc(p.symbol)} <span class="text-sm font-normal text-slate-400">${esc(p.setup || '')} · ${esc(p.date || '')}</span></h3>
                    <button type="button" data-act="share" class="text-xs bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg px-3 py-1.5">Compartir en el foro</button>
                </div>
                <div class="grid grid-cols-3 gap-3 mt-2">
                    ${stat('Entrada', fmt(p.entry), esc(p.entry_time || ''))}
                    ${stat('Stop', fmt(p.stop), esc(p.stop_label || ''))}
                    ${stat('Objetivo', fmt(p.target), esc(p.target_label || ''))}
                    ${stat('Riesgo/acción', fmt(p.risk_per_share))}
                    ${stat('Beneficio:riesgo', `${fmt(p.reward_risk, 1)}R`)}
                    ${stat('Cerrar antes de', esc(p.flat_by || '—'), 'hora de Nueva York')}
                </div>
                ${p.opening_range ? `<p class="text-xs text-slate-400 mt-3">Rango de apertura (${esc(p.opening_range.minutes)} min): ${fmt(p.opening_range.low)} – ${fmt(p.opening_range.high)}</p>` : ''}
                <p class="text-xs text-slate-500 mt-2">Un stop es un plan, no una garantía: un hueco o un mercado rápido puede ejecutarlo peor.</p>
            </div>`;
    }

    function renderEntry() {
        const e = get('entry');
        if (!e) return `<div class="desk-card"><h3>Señal de entrada</h3><p class="text-sm text-slate-400">Sin <code>trader/entry.json</code>. Ejecuta <code>/trader-entry</code>.</p></div>`;
        const labels = { triggered: ['Activada', 'bg-blue-600'], waiting: ['Esperando', 'bg-slate-600'], expired: ['Expirada', 'bg-orange-700'], 'no-data': ['Sin datos', 'bg-slate-700'] };
        const [txt, cls] = labels[e.status] || [e.status, 'bg-slate-600'];
        return `
            <div class="desk-card">
                <h3>Señal de entrada · ${esc(e.symbol)}</h3>
                <span class="inline-block text-xs font-bold text-white rounded-full px-2 py-1 ${cls}">${esc(txt)}</span>
                <div class="grid grid-cols-3 gap-3 mt-3">
                    ${stat('Precio', fmt(e.price), esc(e.time || ''))}
                    ${stat('Nivel', fmt(e.level))}
                    ${stat('Velas', esc(e.interval || '—'))}
                </div>
                ${e.reason ? `<p class="text-sm text-slate-300 mt-3">${esc(e.reason)}</p>` : ''}
                <p class="text-xs text-slate-500 mt-2">Comprobado: ${esc(e.checked_at || '—')} · fuente ${esc(e.source || '—')}</p>
            </div>`;
    }

    function renderTimeMachine() {
        const tm = get('timemachine');
        if (!tm || !tm.mc) return `<div class="desk-card mt-4"><h3>Máquina del tiempo</h3><p class="text-sm text-slate-400">Sin <code>trader/timemachine.json</code>. Ejecuta <code>/trader-timemachine</code> después de <code>/trader-exit</code>.</p></div>`;
        const mc = tm.mc, h = tm.history || {};
        const seg = [
            { k: 'Objetivo primero', v: num(mc.p_target) || 0, c: C.target },
            { k: 'Stop primero', v: num(mc.p_stop) || 0, c: C.stop },
            { k: 'Ninguno al cierre', v: num(mc.p_neither) || 0, c: C.neither },
        ];
        return `
            <div class="desk-card mt-4">
                <h3>Máquina del tiempo · ${esc(tm.plan && tm.plan.symbol || '')} <span class="text-sm font-normal text-slate-400">${esc(fmt(mc.replays, 0))} sesiones simuladas · semilla ${esc(mc.seed)}</span></h3>
                ${tm.verdict ? `<p class="text-white font-semibold mb-3">${esc(tm.verdict)}</p>` : ''}
                <div class="flex w-full h-4 rounded overflow-hidden gap-[2px] bg-slate-800" role="img" aria-label="${seg.map(s => `${s.k} ${pct(s.v)}`).join(', ')}">
                    ${seg.map(s => `<div title="${esc(s.k)}: ${pct(s.v)}" style="width:${(s.v * 100).toFixed(2)}%;background:${s.c}"></div>`).join('')}
                </div>
                <div class="flex flex-wrap gap-4 mt-2 text-sm text-slate-200">
                    ${seg.map(s => `<span class="flex items-center gap-2"><span class="inline-block w-3 h-3 rounded-sm" style="background:${s.c}"></span>${esc(s.k)} <b class="num">${pct(s.v)}</b></span>`).join('')}
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                    ${stat('Cierre mediano', fmt(mc.median_close), `p5 ${fmt(mc.p5_close)} · p95 ${fmt(mc.p95_close)}`)}
                    ${stat('Cierra en verde', pct(mc.p_green))}
                    ${stat('R medio', fmt(mc.avg_R, 3))}
                    ${stat('Sesiones base', esc(mc.pool_sessions ?? '—'), `${esc(mc.pool_from || '')} → ${esc(mc.pool_to || '')}`)}
                </div>
                <figure class="mt-4">
                    <figcaption class="text-sm text-slate-300 mb-1">Abanico de precios hasta el cierre (bandas p5–p95 y p25–p75, mediana)</figcaption>
                    <div id="tm-fan" class="relative w-full" style="height:240px"></div>
                </figure>
                ${h.triggered ? `
                <p class="text-sm text-slate-300 mt-4"><b>Histórico real:</b> en ${esc(h.sessions)} sesiones la regla se activó ${esc(h.triggered)} veces:
                    ${esc(h.target)} llegaron al objetivo, ${esc(h.stop)} al stop y ${esc(h.close)} a ninguno${num(h.avg_R) !== null ? ` (R medio ${fmt(h.avg_R, 3)})` : ''}.</p>` : ''}
                ${Array.isArray(tm.verdict_notes) && tm.verdict_notes.length ? `<ul class="list-disc ml-5 text-xs text-slate-400 mt-2">${tm.verdict_notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
                <p class="text-xs text-slate-500 mt-2">Es una simulación con los propios datos recientes de la acción, no una predicción.</p>
            </div>`;
    }

    // Gráfico de abanico en SVG con cruz y tooltip al pasar el ratón.
    function drawFan() {
        const host = document.getElementById('tm-fan');
        const tm = get('timemachine');
        if (!host || !tm || !tm.mc || !Array.isArray(tm.mc.bands) || tm.mc.bands.length < 2) { if (host) host.innerHTML = '<p class="text-xs text-slate-400">Sin bandas en el archivo.</p>'; return; }
        const bands = tm.mc.bands, times = tm.mc.band_times || bands.map((_, i) => String(i));
        const plan = tm.plan || {};
        const W = host.clientWidth || 600, H = 240, m = { l: 52, r: 74, t: 10, b: 24 };
        const levels = [num(plan.stop), num(plan.target), num(plan.entry)].filter(v => v !== null);
        const all = bands.flat().concat(levels);
        let lo = Math.min(...all), hi = Math.max(...all);
        const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
        const x = i => m.l + (i / (bands.length - 1)) * (W - m.l - m.r);
        const y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
        const area = (a, b) => bands.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[a]).toFixed(1)}`).join('') +
            bands.slice().reverse().map((r, j) => `L${x(bands.length - 1 - j).toFixed(1)},${y(r[b]).toFixed(1)}`).join('') + 'Z';
        const med = bands.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[2]).toFixed(1)}`).join('');
        const ticks = 4, yt = Array.from({ length: ticks + 1 }, (_, i) => lo + (hi - lo) * i / ticks);
        const xt = [0, Math.floor((bands.length - 1) / 2), bands.length - 1];
        const ref = (v, color, label) => v === null ? '' : `
            <line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 3"/>
            <text x="${W - m.r + 6}" y="${y(v) + 4}" font-size="11" fill="${C.text}">${esc(label)} ${fmt(v)}</text>`;
        host.innerHTML = `
            <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Abanico de precios simulados">
                ${yt.map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="0.5" opacity="0.5"/>
                    <text x="${m.l - 6}" y="${y(v) + 4}" font-size="10" fill="${C.muted}" text-anchor="end">${fmt(v)}</text>`).join('')}
                ${xt.map(i => `<text x="${x(i)}" y="${H - 6}" font-size="10" fill="${C.muted}" text-anchor="${i === 0 ? 'start' : i === bands.length - 1 ? 'end' : 'middle'}">${esc(times[i])}</text>`).join('')}
                <path d="${area(0, 4)}" fill="${C.band}" opacity="0.18"/>
                <path d="${area(1, 3)}" fill="${C.band}" opacity="0.35"/>
                <path d="${med}" fill="none" stroke="${C.band}" stroke-width="2"/>
                ${ref(num(plan.target), C.target, 'Obj.')}
                ${ref(num(plan.stop), C.stop, 'Stop')}
                ${ref(num(plan.entry), C.muted, 'Ent.')}
                <line id="tm-cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="${C.text}" stroke-width="1" opacity="0" />
                <rect id="tm-hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
            </svg>
            <div id="tm-tip" class="hidden absolute pointer-events-none bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 num"></div>`;
        const hit = host.querySelector('#tm-hit'), cross = host.querySelector('#tm-cross'), tip = host.querySelector('#tm-tip');
        const move = (ev) => {
            const r = hit.getBoundingClientRect();
            const px = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
            const i = Math.max(0, Math.min(bands.length - 1, Math.round(px / r.width * (bands.length - 1))));
            const b = bands[i];
            cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', '0.6');
            tip.innerHTML = `<b>${esc(times[i])}</b><br>Mediana ${fmt(b[2])}<br>50 %: ${fmt(b[1])} – ${fmt(b[3])}<br>90 %: ${fmt(b[0])} – ${fmt(b[4])}`;
            tip.classList.remove('hidden');
            const left = Math.min(x(i) + 10, W - 140);
            tip.style.left = `${left}px`; tip.style.top = `${m.t + 4}px`;
        };
        const leave = () => { cross.setAttribute('opacity', '0'); tip.classList.add('hidden'); };
        hit.addEventListener('mousemove', move); hit.addEventListener('touchmove', move, { passive: true });
        hit.addEventListener('mouseleave', leave); hit.addEventListener('touchend', leave);
    }

    function renderOrders() {
        const o = get('orders');
        if (!o || !Array.isArray(o.orders) || !o.orders.length) return `<div class="desk-card"><h3>Órdenes propuestas</h3><p class="text-sm text-slate-400">Sin <code>trader/orders.json</code>. Ejecuta <code>/trader-budget</code>.</p></div>`;
        return `
            <div class="desk-card">
                <h3>Órdenes propuestas ${o.paper === false ? '<span class="text-xs text-orange-300">(cuenta REAL)</span>' : '<span class="text-xs text-blue-300">(paper)</span>'}</h3>
                <div class="space-y-3">
                ${o.orders.map((ord, i) => `
                    <div class="rounded-lg bg-slate-800 p-3" data-order-idx="${i}">
                        <div class="flex items-center justify-between gap-2">
                            <span class="font-mono text-sm text-white">${esc(String(ord.side || '').toUpperCase())} ${esc(ord.qty || ord.notional && `$${ord.notional}` || '')} ${esc(ord.symbol)} · ${esc(ord.type)}${ord.limit_price ? ` @ ${esc(ord.limit_price)}` : ''}</span>
                            <span class="risk-badge text-xs font-bold rounded-full px-2 py-1 bg-slate-600 text-white">sin verificar</span>
                        </div>
                        ${ord.order_class === 'bracket' ? `<p class="text-xs text-slate-300 mt-1 num">Stop-loss ${esc(ord.stop_loss_stop_price)} · Take-profit ${esc(ord.take_profit_limit_price)}${ord.plan ? ` · pérdida máx. ${usd(ord.plan.max_loss)}` : ''}</p>` : ''}
                        ${ord.why ? `<p class="text-xs text-slate-400 mt-1">${esc(ord.why)}</p>` : ''}
                        <p class="risk-detail text-xs mt-1"></p>
                    </div>`).join('')}
                </div>
                <p class="text-xs text-slate-500 mt-3">Solo propuestas. Para enviar: <code>/trader-risk</code> y después <code>/trader-broker</code>, que te pedirá un "sí" explícito.</p>
            </div>`;
    }

    // Empareja cada orden con su veredicto de /trader-risk por huella (igual que /trader-broker).
    async function annotateRisk() {
        const o = get('orders'), risk = get('risk');
        if (!o || !Array.isArray(o.orders)) return;
        const results = risk && Array.isArray(risk.results) ? risk.results : [];
        const today = todayNY();
        for (let i = 0; i < o.orders.length; i++) {
            const el = root.querySelector(`[data-order-idx="${i}"]`);
            if (!el) continue;
            const badge = el.querySelector('.risk-badge'), detail = el.querySelector('.risk-detail');
            const fp = await fingerprint(o.orders[i]);
            const r = results.find(x => fp && x.fingerprint === fp);
            if (!risk) { detail.innerHTML = '<span class="text-slate-400">Sin trader/state/risk.json: ejecuta /trader-risk.</span>'; continue; }
            if (!r) {
                badge.textContent = 'no verificada'; badge.className = 'risk-badge text-xs font-bold rounded-full px-2 py-1 bg-orange-700 text-white';
                detail.innerHTML = '<span class="text-orange-200">Esta orden exacta no pasó por /trader-risk (cambió o no se verificó).</span>';
                continue;
            }
            const pass = r.verdict === 'PASS';
            const ready = pass && risk.date === today;
            badge.textContent = ready ? 'READY · PASS' : pass ? 'PASS (otro día)' : 'BLOCK';
            badge.className = `risk-badge text-xs font-bold rounded-full px-2 py-1 text-white ${ready ? 'bg-blue-600' : pass ? 'bg-slate-600' : 'bg-orange-700'}`;
            const reasons = (r.reasons || []).map(x => `<li>${esc(x)}</li>`).join('');
            const warns = (r.warnings || []).map(x => `<li>${esc(x)}</li>`).join('');
            detail.innerHTML = `${!pass && reasons ? `<ul class="list-disc ml-4 text-orange-200">${reasons}</ul>` : ''}${warns ? `<ul class="list-disc ml-4 text-amber-200">${warns}</ul>` : ''}<span class="text-slate-400">Verificado ${esc(risk.now_new_york || risk.date)} (NY) · huella ${esc(fp)}</span>`;
        }
    }

    // Calculadora rápida: los cuatro límites de /trader-budget (estimación; la cifra oficial la da la skill).
    function renderSizer() {
        const cfg = get('config') || {}, plan = get('plan') || {}, pf = get('portfolio');
        const v = (k, d) => (cfg[k] !== undefined && cfg[k] !== null ? cfg[k] : d);
        const field = (id, label, value, step = 'any') => `
            <label class="block text-xs text-slate-400">${esc(label)}
                <input id="${id}" type="number" step="${step}" min="0" value="${esc(value ?? '')}" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm num">
            </label>`;
        return `
            <div class="desk-card">
                <h3>Calculadora de tamaño</h3>
                <div class="grid grid-cols-2 gap-2">
                    ${field('sz-entry', 'Entrada', plan.entry)}
                    ${field('sz-stop', 'Stop', plan.stop)}
                    ${field('sz-budget', 'Presupuesto (USD)', v('budget', 5000))}
                    ${field('sz-cash', 'Efectivo disponible (USD)', pf && pf.cash !== undefined ? pf.cash : v('budget', 5000))}
                    ${field('sz-maxloss', 'Pérdida máx. por trade', v('max_loss_per_trade_usd', 50))}
                    ${field('sz-buffer', 'Colchón de efectivo %', v('cash_buffer_pct', 10))}
                    ${field('sz-maxpos', 'Posición máx. % presupuesto', v('max_position_pct', 75))}
                    ${field('sz-maxorder', 'Orden máx. (USD)', v('max_order_usd', 4000))}
                </div>
                <div id="sz-out" class="mt-3 text-sm"></div>
                <p class="text-xs text-slate-500 mt-2">Estimación con acciones enteras. La cifra oficial (y la orden) la da <code>/trader-budget</code>.</p>
            </div>`;
    }

    function computeSize() {
        const out = root.querySelector('#sz-out');
        if (!out) return;
        const g = id => num(root.querySelector(`#${id}`).value);
        const entry = g('sz-entry'), stop = g('sz-stop'), budget = g('sz-budget'), cash = g('sz-cash');
        const maxLoss = g('sz-maxloss'), buffer = g('sz-buffer') || 0, maxPos = g('sz-maxpos'), maxOrder = g('sz-maxorder');
        if (!entry || stop === null || !budget || !maxLoss) { out.innerHTML = '<span class="text-slate-400">Rellena entrada, stop, presupuesto y pérdida máxima.</span>'; return; }
        const risk = entry - stop;
        if (risk <= 0) { out.innerHTML = '<span class="text-orange-300">El stop debe estar por debajo de la entrada (solo largos).</span>'; return; }
        const limits = [
            ['pérdida máxima por trade', Math.floor(maxLoss / risk + 1e-9)],
            ['posición máxima', maxPos ? Math.floor(budget * maxPos / 100 / entry) : Infinity],
            ['orden máxima', maxOrder ? Math.floor(maxOrder / entry) : Infinity],
            ['efectivo tras el colchón', Math.floor(Math.max(0, (cash ?? budget) - budget * buffer / 100) / entry)],
        ];
        const [why, shares] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));
        if (limits[0][1] < 1) { out.innerHTML = `<span class="text-orange-300">Rechazado: con ${usd(risk)} de riesgo por acción ni 1 acción cabe en tu pérdida máxima de ${usd(maxLoss)}. Acerca el stop o salta el trade.</span>`; return; }
        if (shares < 1) { out.innerHTML = `<span class="text-orange-300">0 acciones: lo limita ${esc(why)}.</span>`; return; }
        out.innerHTML = `
            <div class="grid grid-cols-3 gap-3">
                ${stat('Acciones', fmt(shares, 0), `límite: ${esc(why)}`)}
                ${stat('Importe', usd(shares * entry))}
                ${stat('Pérdida en el stop', usd(shares * risk))}
            </div>`;
    }

    function renderWatchlist() {
        const w = get('watchlist');
        if (!w) return `<div class="desk-card"><h3>Watchlist del escáner</h3><p class="text-sm text-slate-400">Sin <code>trader/watchlist.json</code>. Ejecuta <code>/trader-scanner</code>.</p></div>`;
        const hits = Array.isArray(w.hits) ? w.hits : [];
        const names = { orb: 'Ruptura rango apertura', breakout_20d: 'Máximo 20 días', bull_flag: 'Bandera alcista', reclaim_ma20: 'Recupera MM20', oversold: 'Sobreventa', oversold_bounce: 'Rebote sobreventa' };
        return `
            <div class="desk-card">
                <h3>Watchlist del escáner <span class="text-sm font-normal text-slate-400">${esc(w.as_of || '')} · ${esc(hits.length)} de ${esc(w.scanned ?? '—')}</span></h3>
                ${hits.length ? `
                <div class="overflow-x-auto max-h-72">
                    <table class="w-full text-sm">
                        <thead class="text-xs text-slate-400 text-left"><tr><th class="py-1 pr-2">Ticker</th><th class="pr-2">Setup</th><th class="pr-2 text-right">Precio</th><th class="text-right">${w.mode === 'orb' ? '% sobre rango' : 'RSI'}</th></tr></thead>
                        <tbody>${hits.slice(0, 100).map(h => `
                            <tr class="border-t border-slate-600">
                                <td class="py-1 pr-2 font-semibold text-white">${esc(h.symbol)}</td>
                                <td class="pr-2 text-slate-300">${(h.setups || []).map(s => esc(names[s] || s)).join(', ')}</td>
                                <td class="pr-2 text-right num">${fmt(h.price)}</td>
                                <td class="text-right num">${w.mode === 'orb' ? `${fmt(h.pct_over)} %` : fmt(h.rsi, 1)}</td>
                            </tr>`).join('')}</tbody>
                    </table>
                </div>` : '<p class="text-sm text-slate-400">Sin resultados.</p>'}
                <p class="text-xs text-slate-500 mt-2">Un escaneo es una lista de gráficos que cumplen una regla, no una lista de compras.</p>
            </div>`;
    }

    function renderAlerts() {
        const a = get('alerts'), st = get('alertState') || {}, pr = get('prices');
        const rung = st.rung || {};
        const tipo = { above: 'por encima de', below: 'por debajo de', stop: 'stop', target: 'objetivo', pct_move: 'movimiento %', opening_bell: 'campana de apertura', time: 'hora' };
        const prices = pr && pr.prices ? Object.entries(pr.prices) : [];
        if (!a && !prices.length) return `<div class="desk-card"><h3>Alertas y precios</h3><p class="text-sm text-slate-400">Sin <code>trader/alerts.json</code>. Ejecuta <code>/trader-alerts</code> (por ejemplo, "vigila mi stop").</p></div>`;
        return `
            <div class="desk-card">
                <h3>Alertas y precios</h3>
                ${prices.length ? `<div class="flex flex-wrap gap-3 mb-3">${prices.map(([s, p]) => {
                    const d = pr.detail && pr.detail[s] || {};
                    const chg = num(d.prev_close) ? (num(p) / num(d.prev_close) - 1) : null;
                    return `<span class="text-sm"><b class="text-white">${esc(s)}</b> <span class="num">${fmt(p)}</span>${chg !== null ? ` <span class="text-xs text-slate-400 num">(${chg >= 0 ? '+' : ''}${pct(chg, 2)})</span>` : ''}</span>`;
                }).join('')}</div><p class="text-xs text-slate-500 -mt-2 mb-3">Cotizaciones con retraso · ${esc(pr.as_of || '')}</p>` : ''}
                ${a && Array.isArray(a.rules) ? `<ul class="space-y-1 text-sm">${a.rules.map(r => `
                    <li class="flex justify-between gap-2">
                        <span class="text-slate-300">${esc(r.symbol || '')} ${esc(tipo[r.type] || r.type)} ${r.price !== undefined ? `<span class="num">${fmt(r.price)}</span>` : ''}${r.pct !== undefined ? `${esc(r.pct)} %` : ''}${r.at ? esc(r.at) : ''} ${r.label ? `<span class="text-slate-400">(${esc(r.label)})</span>` : ''}</span>
                        <span class="text-xs ${rung[r.id] ? 'text-blue-300' : 'text-slate-500'}">${rung[r.id] ? '🔔 sonó' : 'armada'}</span>
                    </li>`).join('')}</ul>` : ''}
                <p class="text-xs text-slate-500 mt-2">Una alerta informa; nunca vende ni compra.</p>
            </div>`;
    }

    function renderPortfolio() {
        const pf = get('portfolio');
        if (!pf) return `<div class="desk-card"><h3>Cartera</h3><p class="text-sm text-slate-400">Sin <code>trader/portfolio.json</code>. Se crea cuando <code>/trader-broker</code> registra una ejecución.</p></div>`;
        const pos = Array.isArray(pf.positions) ? pf.positions : [];
        return `
            <div class="desk-card">
                <h3>Cartera</h3>
                ${stat('Efectivo', usd(pf.cash))}
                ${pos.length ? `<ul class="mt-3 text-sm space-y-1">${pos.map(p => `<li class="flex justify-between"><span class="text-white font-semibold">${esc(p.ticker || p.symbol)}</span><span class="num text-slate-300">${fmt(p.shares ?? p.qty, 0)} acciones</span></li>`).join('')}</ul>` : '<p class="text-sm text-slate-400 mt-2">Sin posiciones abiertas.</p>'}
            </div>`;
    }

    function renderConfig() {
        const c = get('config');
        if (!c) return `<div class="desk-card"><h3>Tus límites</h3><p class="text-sm text-slate-400">Sin <code>trader/config.json</code>. Pídele a Claude "set my rules" con <code>/trader-budget</code> (o copia <code>config.example.json</code>).</p></div>`;
        const rows = [
            ['Modo', c.paper === false ? '<span class="text-orange-300 font-semibold">REAL</span>' : 'Paper'],
            ['Bróker', esc(c.broker || '—')],
            ['Presupuesto', usd(c.budget)],
            ['Pérdida máx. por trade', usd(c.max_loss_per_trade_usd)],
            ['Pérdida máx. diaria', usd(c.max_daily_loss_usd)],
            ['Trades por día', esc(c.max_trades_per_day ?? '—')],
            ['Beneficio:riesgo mínimo', `${fmt(c.min_reward_risk, 1)}R`],
            ['Ventana de entrada (NY)', `${esc(c.no_entries_before || '—')} – ${esc(c.no_entries_after || '—')}`],
            ['Cerrar antes de', esc(c.flat_by || '—')],
            ['Margen / cortos / opciones', [c.allow_margin, c.allow_short, c.allow_options].map(b => (b ? 'sí' : 'no')).join(' / ')],
        ];
        return `
            <div class="desk-card">
                <h3>Tus límites <span class="text-sm font-normal text-slate-400">trader/config.json</span></h3>
                <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">${rows.map(([k, v]) => `<dt class="text-slate-400">${esc(k)}</dt><dd class="text-white text-right num">${v}</dd>`).join('')}</dl>
            </div>`;
    }

    function renderBrokerLog() {
        const b = get('broker');
        if (!b || !Array.isArray(b.orders) || !b.orders.length) return '';
        const names = { approved: 'aprobada', declined: 'rechazada', placed: 'enviada', denied: 'denegada', failed: 'falló', filled: 'ejecutada' };
        return `
            <div class="desk-card mt-4">
                <h3>Registro del bróker</h3>
                <ul class="text-sm space-y-1 max-h-60 overflow-y-auto">
                    ${b.orders.slice().reverse().slice(0, 50).map(r => `
                    <li class="flex justify-between gap-3 border-t border-slate-600 pt-1">
                        <span class="text-slate-300">${esc(r.plain || `${r.side} ${r.qty} ${r.symbol}`)}</span>
                        <span class="text-xs text-slate-400 whitespace-nowrap">${esc(names[r.status] || r.status)} · ${esc(String(r.at || '').replace('T', ' ').slice(0, 16))}</span>
                    </li>`).join('')}
                </ul>
            </div>`;
    }

    function renderMetrics() {
        const m = get('metrics');
        if (!m || !Array.isArray(m.companies) || !m.companies.length) return '';
        const p = v => (num(v) === null ? '—' : `${fmt(v, 1)} %`);
        return `
            <div class="desk-card mt-4">
                <h3>Resultados (SEC) <span class="text-sm font-normal text-slate-400">/trader-analyst · ${esc(m.as_of || '')}</span></h3>
                <div class="overflow-x-auto"><table class="w-full text-sm">
                    <thead class="text-xs text-slate-400 text-left"><tr><th class="py-1 pr-2">Ticker</th><th class="text-right pr-2">Ingresos a/a</th><th class="text-right pr-2">BPA a/a</th><th class="text-right pr-2">Margen op.</th><th class="text-right">Margen neto</th></tr></thead>
                    <tbody>${m.companies.map(c => `<tr class="border-t border-slate-600"><td class="py-1 pr-2 text-white font-semibold">${esc(c.ticker)}</td><td class="text-right pr-2 num">${p(c.revenue_growth_yoy)}</td><td class="text-right pr-2 num">${p(c.eps_growth_yoy)}</td><td class="text-right pr-2 num">${p(c.operating_margin)}</td><td class="text-right num">${p(c.net_margin)}</td></tr>`).join('')}</tbody>
                </table></div>
            </div>`;
    }

    // ---------- compartir en el foro ----------
    // Solo datos del plan y de las probabilidades; nada de tu presupuesto ni de tu cartera.
    function buildTrade() {
        const p = get('plan');
        if (!p) return null;
        const tm = get('timemachine');
        const sameTm = tm && tm.plan && tm.plan.symbol === p.symbol && num(tm.plan.stop) === num(p.stop) && num(tm.plan.target) === num(p.target);
        const t = {
            source: 'day-trader-skill',
            symbol: String(p.symbol || '').slice(0, 12),
            setup: String(p.setup || '').slice(0, 24),
            date: String(p.date || '').slice(0, 10),
            entry: num(p.entry), stop: num(p.stop), target: num(p.target),
            risk_per_share: num(p.risk_per_share), reward_risk: num(p.reward_risk),
            flat_by: String(p.flat_by || '').slice(0, 5),
            stop_label: String(p.stop_label || '').slice(0, 80),
            target_label: String(p.target_label || '').slice(0, 80),
        };
        if (sameTm && tm.mc) {
            t.odds = { p_target: num(tm.mc.p_target), p_stop: num(tm.mc.p_stop), p_neither: num(tm.mc.p_neither), replays: num(tm.mc.replays) };
            t.verdict = String(tm.verdict || '').slice(0, 300);
            if (tm.history && tm.history.triggered) t.history = { sessions: num(tm.history.sessions), triggered: num(tm.history.triggered), target: num(tm.history.target), stop: num(tm.history.stop), close: num(tm.history.close) };
        }
        return t;
    }

    function share() {
        const t = buildTrade();
        if (!t) { toast('Necesitas un plan (trader/plan.json) para compartir.', 'error'); return; }
        const title = `${t.symbol} ${t.setup ? t.setup.toUpperCase() + ' ' : ''}${t.date}: entrada ${fmt(t.entry)}, stop ${fmt(t.stop)}, objetivo ${fmt(t.target)}`;
        const lines = [
            `Plan generado con las skills de day trading de Claude${isSample ? ' (ejemplo del README)' : ''}.`,
            `Entrada ${fmt(t.entry)} · stop ${fmt(t.stop)} (${t.stop_label}) · objetivo ${fmt(t.target)} (${t.target_label}).`,
            `Riesgo por acción ${fmt(t.risk_per_share)} · ${fmt(t.reward_risk, 1)}R · cerrar antes de las ${t.flat_by} (NY).`,
        ];
        if (t.odds) lines.push(`Máquina del tiempo: objetivo primero ${pct(t.odds.p_target)}, stop primero ${pct(t.odds.p_stop)}, ninguno ${pct(t.odds.p_neither)}.`);
        if (t.verdict) lines.push(`Veredicto: ${t.verdict}`);
        lines.push('', '¿Qué opináis? (No es asesoramiento financiero.)');
        window.dispatchEvent(new CustomEvent('trading-desk:share', { detail: { trade: t, title, message: lines.join('\n') } }));
        if (window.__forumOffline) toast('El foro no está disponible (falta configurar Firebase).', 'error');
    }

    // HTML para mostrar un plan compartido en el foro. Los datos vienen de Firestore: todo se escapa / convierte a número.
    function tradeBadgeHtml(t) {
        if (!t || typeof t !== 'object') return '';
        return `<div class="flex flex-wrap items-center gap-2 mt-2 text-xs num">
            <span class="bg-blue-900 text-blue-200 font-bold rounded-full px-2 py-0.5">${esc(t.symbol)} ${esc(t.setup)}</span>
            <span class="text-slate-300">E ${fmt(t.entry)}</span><span style="color:${C.stop}">S ${fmt(t.stop)}</span><span style="color:${C.target}">O ${fmt(t.target)}</span>
            ${t.odds ? `<span class="text-slate-400">· objetivo 1º ${pct(t.odds.p_target, 0)} / stop 1º ${pct(t.odds.p_stop, 0)}</span>` : ''}
        </div>`;
    }

    function tradeDetailHtml(t) {
        if (!t || typeof t !== 'object') return '';
        const o = t.odds;
        const seg = o ? [[num(o.p_target) || 0, C.target, 'Objetivo primero'], [num(o.p_stop) || 0, C.stop, 'Stop primero'], [num(o.p_neither) || 0, C.neither, 'Ninguno']] : [];
        return `<div class="rounded-lg bg-slate-900/60 p-3 my-3">
            <div class="text-sm font-semibold text-white mb-2">${esc(t.symbol)} · ${esc(t.setup)} · ${esc(t.date)}</div>
            <div class="grid grid-cols-3 gap-2 text-sm num">
                <div><div class="text-xs text-slate-400">Entrada</div>${fmt(t.entry)}</div>
                <div><div class="text-xs text-slate-400">Stop</div>${fmt(t.stop)}</div>
                <div><div class="text-xs text-slate-400">Objetivo</div>${fmt(t.target)}</div>
            </div>
            <div class="text-xs text-slate-400 mt-2">Riesgo/acción ${fmt(t.risk_per_share)} · ${fmt(t.reward_risk, 1)}R · cerrar antes de ${esc(t.flat_by)} NY</div>
            ${o ? `<div class="flex w-full h-3 rounded overflow-hidden gap-[2px] bg-slate-800 mt-3">${seg.map(([v, c, k]) => `<div title="${esc(k)} ${pct(v)}" style="width:${(v * 100).toFixed(2)}%;background:${c}"></div>`).join('')}</div>
                <div class="flex flex-wrap gap-3 mt-1 text-xs text-slate-300">${seg.map(([v, c, k]) => `<span class="flex items-center gap-1"><span class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${c}"></span>${esc(k)} ${pct(v)}</span>`).join('')}</div>` : ''}
            ${t.verdict ? `<p class="text-xs text-slate-300 mt-2">${esc(t.verdict)}</p>` : ''}
        </div>`;
    }

    // ---------- ejemplo: el trade del README de la skill (TSLA, 19-oct-2026) ----------
    function sampleFiles() {
        const entry = 364.18, stop = 358.32, target = 370.04;
        const n = 70, times = [];
        for (let i = 0; i < n; i++) { const mins = 10 * 60 + 15 + i * 5; times.push(`${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`); }
        // Bandas ilustrativas que terminan en los percentiles de cierre del README.
        const bands = times.map((_, i) => {
            const s = Math.sqrt(i / (n - 1));
            return [entry - (entry - 355.54) * s, entry - (entry - 360.4) * s, entry + (364.36 - entry) * s, entry + (368.2 - entry) * s, entry + (373.54 - entry) * s].map(v => Math.round(v * 100) / 100);
        });
        const plan = {
            created_by: 'trader-exit', symbol: 'TSLA', side: 'buy', date: '2026-10-19', setup: 'orb',
            entry, entry_time: '10:15 AM', entry_bar: 8, interval: '5m',
            opening_range: { high: 362.18, low: 354.47, minutes: 15 },
            stop, stop_rule: 'or_mid', stop_label: 'opening-range midpoint',
            target, target_r: 1.0, target_label: '1R (one times the risk)',
            risk_per_share: 5.86, reward_risk: 1.0, flat_by: '15:55',
        };
        return {
            watchlist: { created_by: 'trader-scanner', mode: 'orb', as_of: '2026-10-19 10:15 ET', scanned: 231, hits: [
                { symbol: 'TSLA', setups: ['orb'], price: 364.18, at: '10:15 AM', or_high: 362.18, or_low: 354.47, pct_over: 0.55 }] },
            entry: { created_by: 'trader-entry', symbol: 'TSLA', setup: 'orb', side: 'buy', date: '2026-10-19', status: 'triggered',
                time: '10:15 AM', bar_start: '10:10', bar_index: 8, price: entry, level: 362.18, interval: '5m',
                opening_range: { high: 362.18, low: 354.47, minutes: 15 }, source: 'yahoo', checked_at: '2026-10-19T14:15:00Z',
                reason: 'the 10:10 bar closed above the range high' },
            plan,
            timemachine: { created_by: 'trader-timemachine', plan: { ...plan, from: 'trader/plan.json' },
                mc: { replays: 10000, seed: 19, bars_left: n - 1, p_target: 0.294, p_stop: 0.255, p_neither: 0.451, p_green: 0.5168,
                    median_close: 364.36, p5_close: 355.54, p95_close: 373.54, avg_R: 0.034, bands, band_times: times,
                    pool_sessions: 59, pool_from: '2026-07-27', pool_to: '2026-10-16' },
                history: { sessions: 59, triggered: 33, target: 13, stop: 15, close: 5 },
                verdict: 'Close to a coin flip: target first 29.4 % vs stop first 25.5 %.',
                verdict_notes: ['45.1 % of the replays hit neither by 4:00 PM; the price at 4:00 PM decides those.'] },
            orders: { created_by: 'trader-budget', status: 'proposed', paper: true, orders: [{
                symbol: 'TSLA', side: 'buy', qty: '8', type: 'market', time_in_force: 'day', order_class: 'bracket',
                take_profit_limit_price: '370.04', stop_loss_stop_price: '358.32',
                why: 'opening-range breakout on TSLA: 8 shares, bound by your $50 max loss per trade (8 x 5.86 = $46.88 at the stop)',
                plan: { entry, stop, target, risk_per_share: 5.86, max_loss: 46.88, setup: 'orb', entry_time: '10:15 AM', flat_by: '15:55' } }] },
            risk: { date: '2026-10-19', now_new_york: '2026-10-19 10:15', paper: true, pass: 1, block: 0, results: [{
                index: 1, symbol: 'TSLA', side: 'buy', kind: 'entry', amount: '8 shares', value_usd: 2913.44,
                stop, target, risk_per_share: 5.86, max_loss: 46.88, reward_risk: 1.0,
                fingerprint: 'c38dc9bf3e621b26', verdict: 'PASS', reasons: [], warnings: [] }] },
            alerts: { rules: [
                { id: 'opening-bell', type: 'opening_bell' },
                { id: 'tsla-plan-stop', symbol: 'TSLA', type: 'stop', price: stop, date: '2026-10-19' },
                { id: 'tsla-plan-target', symbol: 'TSLA', type: 'target', price: target, date: '2026-10-19' },
                { id: 'tsla-flat-by', symbol: 'TSLA', type: 'time', at: '15:55', label: 'flat by close', date: '2026-10-19' }] },
            prices: { as_of: '2026-10-19T14:52:30Z', source: 'yahoo', prices: { TSLA: 366.475 }, detail: { TSLA: { prev_close: 354.72 } } },
            config: { budget: 5000, cash_buffer_pct: 10, max_position_pct: 75, max_order_usd: 4000, max_loss_per_trade_usd: 50,
                max_daily_loss_usd: 150, max_trades_per_day: 3, min_reward_risk: 1.0, no_entries_before: '09:45', no_entries_after: '15:30',
                flat_by: '15:55', broker: 'alpaca', paper: true, allow_options: false, allow_margin: false, allow_short: false },
        };
    }

    function loadSample() {
        files = {};
        Object.entries(sampleFiles()).forEach(([k, data]) => { files[k] = { data, source: 'ejemplo', loadedAt: new Date().toISOString() }; });
        isSample = true;
        storageSave();
        render();
    }

    // ---------- eventos ----------
    function wire() {
        root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copy(b.dataset.copy)));
        root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
            const act = b.dataset.act;
            if (act === 'fetch') loadFromServer(false);
            else if (act === 'sample') loadSample();
            else if (act === 'clear') clearAll();
            else if (act === 'share') share();
        }));
        const dir = root.querySelector('#desk-dir'), fl = root.querySelector('#desk-files');
        if (dir) dir.addEventListener('change', e => loadFileList(e.target.files));
        if (fl) fl.addEventListener('change', e => loadFileList(e.target.files));
        root.querySelectorAll('[id^="sz-"]').forEach(i => i.addEventListener('input', computeSize));
        computeSize();
    }

    function wireDrop() {
        root.addEventListener('dragover', e => { e.preventDefault(); root.classList.add('drop-active'); });
        root.addEventListener('dragleave', e => { if (e.target === root) root.classList.remove('drop-active'); });
        root.addEventListener('drop', e => {
            e.preventDefault();
            root.classList.remove('drop-active');
            if (e.dataTransfer && e.dataTransfer.files.length) loadFileList(e.dataTransfer.files);
        });
    }

    const VIEWS = ['forum', 'desk', 'mt5'];
    function showView(view) {
        if (!VIEWS.includes(view)) view = 'forum';
        const notice = document.getElementById('forum-offline-notice');
        const offline = Boolean(window.__forumOffline);
        document.querySelectorAll('.view-tab').forEach(t => {
            const on = t.dataset.view === view;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        VIEWS.forEach(v => {
            const el = document.getElementById(`${v}-section`);
            if (el) el.classList.toggle('hidden', v !== view || (v === 'forum' && offline));
        });
        if (notice) notice.classList.toggle('hidden', view !== 'forum' || !offline);
        try { localStorage.setItem('tradingDesk.view', view); } catch (e) { /* sin almacenamiento */ }
        if (view === 'desk') drawFan(); // el ancho del gráfico depende de que esté visible
        window.dispatchEvent(new CustomEvent('view-change', { detail: view }));
    }

    let resizeTimer = null;
    function init() {
        root = document.getElementById('desk-section');
        if (!root) return;
        storageLoad();
        render();
        wireDrop();
        document.querySelectorAll('.view-tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
        let view = 'forum';
        try { view = localStorage.getItem('tradingDesk.view') || 'forum'; } catch (e) { /* sin almacenamiento */ }
        showView(window.__forumOffline && view === 'forum' ? 'desk' : view);
        window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawFan, 150); });
        loadFromServer(true); // si la app se sirve desde la raíz del proyecto, lee ./trader/ sola
    }

    window.TradingDesk = { showView, tradeBadgeHtml, tradeDetailHtml, loadSample, reload: () => loadFromServer(false), getPlan: () => get('plan') };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
