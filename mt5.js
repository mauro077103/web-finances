/*
 * MetaTrader en vivo
 * ------------------
 * Se conecta al puente local (bridge/server.py) por Server-Sent Events y muestra en tiempo real
 * lo que envía MetaTrader 5: cuenta, cotizaciones, gráfico de velas y posiciones. Las órdenes
 * manuales se confirman aquí; el puente las valida (stop obligatorio, riesgo y volumen máximos)
 * y el EA de MetaTrader las vuelve a validar antes de enviarlas al bróker.
 *
 * Los analistas viven en el puente (bridge/analysts.py) y leen los precios en tiempo real. Desde
 * aquí se conectan/desconectan, se ajusta el riesgo y se enciende el piloto automático, que solo
 * opera con los analistas en modo "Automático" y dentro de esos límites.
 */
(function () {
    'use strict';

    const LS = { base: 'mt5.base', token: 'mt5.token', symbol: 'mt5.symbol', tf: 'mt5.tf', risk: 'mt5.risk' };
    const TFS = ['M1', 'M5', 'M15', 'H1', 'D1'];
    const TF_SEC = { M1: 60, M5: 300, M15: 900, H1: 3600, D1: 86400 };
    const COL = { up: '#60a5fa', down: '#f97316', sl: '#f97316', tp: '#60a5fa', entry: '#94a3b8', grid: '#334155', text: '#94a3b8', price: '#e2e8f0' };

    let root = null;
    let es = null;
    let state = null;
    let prevBid = {};
    let selected = null;
    let tf = 'M1';
    let bars = [];
    let barsKey = '';
    let side = 'buy';
    let otype = 'market';
    let chartHover = null;
    let rafPending = false;
    let deskRev = -1;
    let userClosed = false;

    // ---------- utilidades ----------
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const lsGet = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
    const money = (v, cur) => { const n = num(v); if (n === null) return '—'; try { return n.toLocaleString('es-ES', { style: 'currency', currency: cur || 'USD' }); } catch (e) { return n.toFixed(2); } };
    const signed = (v, cur) => { const n = num(v); if (n === null) return '—'; return (n > 0 ? '+' : '') + money(n, cur); };
    const px = (v, d) => { const n = num(v); return n === null || n === 0 ? '—' : n.toFixed(d ?? 5); };
    const symInfo = (s) => state && state.symbols ? state.symbols.find(x => x.s === s) : null;
    const $ = (sel) => root.querySelector(sel);

    function toast(msg, type = 'info') {
        const box = document.getElementById('message-box');
        if (!box) return;
        const el = document.createElement('div');
        el.className = `p-4 rounded-lg shadow-md mb-2 text-white max-w-xs ${type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-blue-600'}`;
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(() => el.remove(), 6000);
    }

    function notify(title, body) {
        try {
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'icons/icon-192.png' });
            if (navigator.vibrate) navigator.vibrate(120);
        } catch (e) { /* sin notificaciones */ }
    }

    function defaultBase() {
        // Si la app la sirve el propio puente, la base es el mismo origen.
        if (/^https?:$/.test(location.protocol) && location.port === '8765') return location.origin;
        return lsGet(LS.base, /^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8765');
    }
    const base = () => lsGet(LS.base, defaultBase()).replace(/\/+$/, '');
    const token = () => lsGet(LS.token, '');

    async function api(path, body) {
        const r = await fetch(base() + path, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', 'X-Token': token() },
            body: body ? JSON.stringify(body) : undefined,
        });
        let data = null;
        try { data = await r.json(); } catch (e) { /* sin cuerpo */ }
        if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
        return data;
    }

    // ---------- conexión ----------
    function disconnect() {
        userClosed = true;
        if (es) { es.close(); es = null; }
        state = null;
        deskRev = -1;
        renderAll();
        setStatus('off', 'Desconectado de la app (el puente y sus analistas siguen funcionando)');
    }

    async function connect() {
        userClosed = false;
        if (es) { es.close(); es = null; }
        deskRev = -1;
        state = null;
        setStatus('connecting', 'Conectando…');
        if (!token()) { setStatus('off', 'Falta el token'); renderAll(); return; }
        try {
            const ping = await fetch(base() + '/api/ping', { cache: 'no-store' }).then(r => r.json());
            if (!ping.ok) throw new Error('sin respuesta');
            const auth = await fetch(base() + '/api/state', { headers: { 'X-Token': token() }, cache: 'no-store' });
            if (auth.status === 401) { setStatus('off', 'Token incorrecto'); renderAll(); return; }
        } catch (e) {
            setStatus('off', `No se encuentra el puente en ${base()}`);
            renderAll();
            return;
        }
        es = new EventSource(`${base()}/api/stream?token=${encodeURIComponent(token())}`);
        es.addEventListener('state', (e) => { onState(JSON.parse(e.data)); });
        es.addEventListener('bars', (e) => onBars(JSON.parse(e.data)));
        es.addEventListener('result', (e) => onResult(JSON.parse(e.data)));
        es.addEventListener('signal', (e) => onSignal(JSON.parse(e.data)));
        es.onerror = () => { if (!userClosed) setStatus('connecting', 'Reconectando…'); };
    }

    function onState(s) {
        const first = !state;
        state = s;
        if (!selected || !symInfo(selected)) {
            const saved = lsGet(LS.symbol, '');
            selected = symInfo(saved) ? saved : (s.symbols[0] && s.symbols[0].s) || null;
            if (selected) requestBars();
        }
        if (s.connected) setStatus('on', s.source === 'demo' ? 'Simulador conectado' : 'MetaTrader conectado');
        else setStatus('connecting', s.source === 'ea' ? 'Puente listo · esperando al EA de MetaTrader' : 'Esperando datos…');
        if (first) renderAll(); else renderLive();
        if (selected && bars.length) liveCandle();
    }

    function onBars(b) {
        if (!b || b.symbol !== selected || b.tf !== tf) return;
        bars = (b.bars || []).map(x => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] }));
        barsKey = `${b.symbol}|${b.tf}`;
        drawChart();
    }

    function onResult(r) {
        const ok = r.status === 'done';
        const what = r.kind === 'order' ? `${String(r.side || '').toUpperCase()} ${r.volume} ${r.symbol}` : r.kind === 'close' ? `Cerrar #${r.ticket}` : r.kind === 'modify' ? `Modificar #${r.ticket}` : r.kind === 'bars' ? null : 'Operación';
        if (what === null) return;
        toast(`${what}: ${ok ? 'hecho' : 'rechazado'} · ${r.message || ''}`, ok ? 'success' : 'error');
        notify(`web-finances · ${ok ? 'OK' : 'Rechazada'}`, `${what} ${r.message || ''}`);
    }

    function onSignal(g) {
        if (g.kind === 'halt') { toast(g.message, 'error'); notify('web-finances · piloto automático apagado', g.message); return; }
        if (g.status === 'ignorada') return;
        const what = `${g.analyst_name}: ${g.side === 'buy' ? 'COMPRA' : 'VENTA'} ${g.symbol}`;
        const type = g.status === 'enviada' ? 'success' : g.status === 'bloqueada' ? 'error' : 'info';
        toast(`${what} · ${g.message || ''}`, type);
        notify(`web-finances · señal ${g.status}`, `${what} SL ${g.sl}${g.tp ? ` TP ${g.tp}` : ''}`);
    }

    function requestBars() {
        if (!selected || !token()) return;
        bars = [];
        barsKey = '';
        drawChart();
        api('/api/bars', { symbol: selected, tf, count: 200 }).catch(e => toast(`Velas: ${e.message}`, 'error'));
    }

    // Actualiza la última vela con el precio en vivo (bid).
    function liveCandle() {
        const s = symInfo(selected);
        if (!s || !bars.length || barsKey !== `${selected}|${tf}`) return;
        const p = num(s.bid);
        if (p === null) return;
        const step = TF_SEC[tf];
        const t = Math.floor((num(s.t) ? s.t / 1000 : Date.now() / 1000) / step) * step;
        const last = bars[bars.length - 1];
        if (tf !== 'D1' && t > last.t) {
            bars.push({ t, o: p, h: p, l: p, c: p });
            if (bars.length > 600) bars.shift();
        } else {
            last.c = p; last.h = Math.max(last.h, p); last.l = Math.min(last.l, p);
        }
        scheduleDraw();
    }

    function scheduleDraw() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; drawChart(); });
    }

    // ---------- render ----------
    function setStatus(kind, text) {
        const dot = root && $('#mt-dot'), label = root && $('#mt-status');
        if (!dot) return;
        dot.style.background = kind === 'on' ? '#60a5fa' : kind === 'connecting' ? '#facc15' : '#64748b';
        label.textContent = text;
    }

    function renderAll() {
        if (!root) return;
        const connected = Boolean(state);
        root.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div class="flex items-center gap-2 min-w-0">
                    <span id="mt-dot" class="inline-block w-3 h-3 rounded-full flex-none" style="background:#64748b"></span>
                    <span id="mt-status" class="text-sm text-slate-300 truncate">Desconectado</span>
                    <span id="mt-acctbadge"></span>
                </div>
                <div class="flex gap-2">
                    <button type="button" data-mt="notif" class="text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-lg px-3 py-2">🔔 Avisos</button>
                    <button type="button" data-mt="settings" class="text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-lg px-3 py-2">⚙ Conexión</button>
                    ${state ? '<button type="button" data-mt="disconnect" class="text-xs bg-slate-700 hover:bg-slate-600 text-white rounded-lg px-3 py-2">Desconectar</button>' : ''}
                </div>
            </div>

            <form id="mt-settings" class="${connected && token() ? 'hidden' : ''} desk-card mb-4 space-y-3">
                <h3>Conectar con MetaTrader</h3>
                <p class="text-sm text-slate-300">Arranca el puente en tu ordenador (<code>python3 bridge/server.py</code>) y abre la dirección que muestra
                   (ya incluye el token). Si ya la abriste, basta con pegar aquí el token.</p>
                <div class="grid gap-3 sm:grid-cols-2">
                    <label class="block text-xs text-slate-400">Dirección del puente
                        <input id="mt-base" type="url" value="${esc(base())}" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm" autocomplete="off">
                    </label>
                    <label class="block text-xs text-slate-400">Token
                        <input id="mt-token" type="password" value="${esc(token())}" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm" autocomplete="off">
                    </label>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-lg">Conectar</button>
                    <a href="#mt-howto" class="text-sm text-blue-300 hover:text-blue-200 py-2">¿Cómo se pone en marcha?</a>
                </div>
            </form>

            <div id="mt-account" class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4"></div>
            <div id="mt-auto" class="mb-4"></div>

            <div class="grid gap-4 lg:grid-cols-3">
                <div class="desk-card lg:col-span-1 order-2 lg:order-1">
                    <h3>Cotizaciones</h3>
                    <div class="overflow-y-auto" style="max-height:420px">
                        <table class="w-full text-sm">
                            <thead class="text-xs text-slate-400 text-left sticky top-0 bg-slate-700">
                                <tr><th class="py-1">Símbolo</th><th class="text-right">Bid</th><th class="text-right">Ask</th><th class="text-right">Día</th></tr>
                            </thead>
                            <tbody id="mt-quotes"></tbody>
                        </table>
                    </div>
                </div>
                <div class="lg:col-span-2 order-1 lg:order-2 space-y-4">
                    <div class="desk-card">
                        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
                            <h3 class="mb-0" id="mt-chart-title">Gráfico</h3>
                            <div class="flex gap-1" role="group" aria-label="Temporalidad">
                                ${TFS.map(t => `<button type="button" data-tf="${t}" class="text-xs rounded px-2 py-1 ${t === tf ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-600'}">${t}</button>`).join('')}
                            </div>
                        </div>
                        <div id="mt-chart-wrap" class="relative w-full" style="height:320px">
                            <canvas id="mt-chart" class="w-full h-full block" aria-label="Gráfico de velas en tiempo real"></canvas>
                            <div id="mt-chart-tip" class="hidden absolute top-1 left-2 text-xs text-slate-200 bg-slate-900/90 rounded px-2 py-1 pointer-events-none" style="font-variant-numeric:tabular-nums"></div>
                        </div>
                    </div>
                    ${renderTicketShell()}
                </div>
            </div>

            <div class="desk-card mt-4">
                <h3>Posiciones abiertas</h3>
                <div class="overflow-x-auto"><table class="w-full text-sm">
                    <thead class="text-xs text-slate-400 text-left"><tr>
                        <th class="py-1 pr-2">Símbolo</th><th class="pr-2">Tipo</th><th class="pr-2 text-right">Lotes</th>
                        <th class="pr-2 text-right">Apertura</th><th class="pr-2 text-right">Actual</th><th class="pr-2 text-right">SL</th>
                        <th class="pr-2 text-right">TP</th><th class="pr-2 text-right">Resultado</th><th></th></tr></thead>
                    <tbody id="mt-positions"></tbody>
                </table></div>
            </div>

            ${renderDeskShell()}

            <div class="desk-card mt-4">
                <h3>Actividad</h3>
                <ul id="mt-log" class="text-xs space-y-1 max-h-48 overflow-y-auto"></ul>
            </div>

            ${renderHowTo()}

            <dialog id="mt-confirm" class="rounded-xl bg-slate-800 text-slate-100 p-0 w-[min(92vw,420px)] backdrop:bg-black/60">
                <form method="dialog" class="p-5 space-y-3">
                    <h3 class="text-lg font-bold text-white">Confirmar orden</h3>
                    <div id="mt-confirm-body" class="text-sm"></div>
                    <div class="flex gap-2 pt-2">
                        <button value="cancel" class="flex-1 bg-slate-600 hover:bg-slate-500 text-white font-semibold py-2 rounded-lg">Cancelar</button>
                        <button value="ok" id="mt-confirm-ok" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg">Enviar</button>
                    </div>
                </form>
            </dialog>
        `;
        wire();
        deskRev = -1;
        renderLive();
        drawChart();
        setStatus(state ? (state.connected ? 'on' : 'connecting') : 'off',
            state ? (state.connected ? (state.source === 'demo' ? 'Simulador conectado' : 'MetaTrader conectado') : 'Esperando a MetaTrader…') : (token() ? 'Desconectado' : 'Sin configurar'));
    }

    function renderTicketShell() {
        return `
            <form id="mt-ticket" class="desk-card space-y-3" autocomplete="off">
                <div class="flex items-center justify-between gap-2">
                    <h3 class="mb-0">Nueva orden <span id="mt-ticket-sym" class="text-blue-300"></span></h3>
                    <button type="button" data-mt="useplan" class="text-xs text-blue-300 hover:text-blue-200">Usar plan de la Mesa</button>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <button type="button" data-side="buy" class="side-btn rounded-lg py-2 font-bold">Comprar <span class="block text-xs font-normal" id="mt-ask">—</span></button>
                    <button type="button" data-side="sell" class="side-btn rounded-lg py-2 font-bold">Vender <span class="block text-xs font-normal" id="mt-bid">—</span></button>
                </div>
                <div class="grid grid-cols-3 gap-2 text-xs">
                    ${[['market', 'A mercado'], ['limit', 'Limitada'], ['stop', 'Stop']].map(([v, l]) => `<button type="button" data-otype="${v}" class="otype-btn rounded py-1">${l}</button>`).join('')}
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <label class="block text-xs text-slate-400" id="mt-price-wrap">Precio
                        <input id="mt-price" type="number" step="any" inputmode="decimal" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm">
                    </label>
                    <label class="block text-xs text-slate-400">Stop loss *
                        <input id="mt-sl" type="number" step="any" inputmode="decimal" required class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm">
                    </label>
                    <label class="block text-xs text-slate-400">Take profit
                        <input id="mt-tp" type="number" step="any" inputmode="decimal" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm">
                    </label>
                    <label class="block text-xs text-slate-400">Riesgo (divisa)
                        <input id="mt-risk" type="number" step="any" min="0" inputmode="decimal" value="${esc(lsGet(LS.risk, '50'))}" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm">
                    </label>
                    <label class="block text-xs text-slate-400">Lotes
                        <input id="mt-vol" type="number" step="any" min="0" inputmode="decimal" class="mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm">
                    </label>
                    <div class="flex items-end">
                        <button type="button" data-mt="calcvol" class="w-full text-xs bg-slate-600 hover:bg-slate-500 text-white rounded-md py-2">Lotes por riesgo</button>
                    </div>
                </div>
                <div id="mt-ticket-info" class="text-xs text-slate-300 min-h-[1.25rem]"></div>
                <button type="submit" id="mt-send" class="w-full text-white font-bold py-3 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed">Revisar orden</button>
                <p id="mt-trade-off" class="text-xs text-amber-200"></p>
            </form>`;
    }

    function renderHowTo() {
        return `
            <details id="mt-howto" class="desk-card mt-4">
                <summary class="cursor-pointer font-bold text-white">Cómo ponerlo en marcha (MetaTrader 5, ordenador y móvil)</summary>
                <ol class="list-decimal ml-5 mt-3 space-y-2 text-sm text-slate-300">
                    <li>En el ordenador donde tienes MetaTrader 5: <code>python3 bridge/server.py --lan</code>. Muestra la dirección y el token.</li>
                    <li>Copia <code>mt5/WebFinancesBridge.mq5</code> en <i>Archivo › Abrir carpeta de datos › MQL5/Experts</i> y compílalo en MetaEditor (F7).</li>
                    <li>En MT5: <i>Herramientas › Opciones › Asesores Expertos</i> → marca <i>Permitir WebRequest</i> y añade <code>http://127.0.0.1:8765</code>.</li>
                    <li>Arrastra el EA a cualquier gráfico y pega el token. Para operar desde aquí: <code>AllowTrading=true</code> y el botón <i>Algo Trading</i> activado. Las cuentas reales siguen bloqueadas salvo <code>AllowLiveAccount=true</code> y el puente con <code>--allow-live</code>.</li>
                    <li>Para que opere solo: en <i>Analistas</i> conecta uno en modo <i>Automático</i>, ajusta <i>Tu riesgo</i> y pulsa <i>Encender piloto</i>.</li>
                    <li>En el móvil (misma WiFi) abre la dirección "Móvil" que imprime el puente y usa <i>Añadir a pantalla de inicio</i>.</li>
                </ol>
                <p class="text-xs text-slate-400 mt-3">¿Sin MetaTrader a mano? <code>python3 bridge/server.py --demo</code> arranca un simulador con precios en vivo.</p>
            </details>`;
    }

    // Partes que cambian varias veces por segundo.
    function renderLive() {
        if (!root || !$('#mt-account')) return;
        const s = state || {};
        const a = s.account || null, cur = a && a.currency;
        $('#mt-acctbadge').innerHTML = a ? (a.demo
            ? '<span class="text-xs font-bold rounded-full px-2 py-0.5 bg-slate-600 text-white">DEMO</span>'
            : '<span class="text-xs font-bold rounded-full px-2 py-0.5 bg-red-600 text-white">CUENTA REAL</span>') : '';
        $('#mt-account').innerHTML = a ? [
            ['Balance', money(a.balance, cur)], ['Equity', money(a.equity, cur)],
            ['Resultado abierto', signed(a.profit, cur)], ['Margen', money(a.margin, cur)], ['Margen libre', money(a.free_margin, cur)],
        ].map(([k, v]) => `<div class="desk-card py-2"><div class="text-xs text-slate-400">${k}</div><div class="text-base sm:text-lg font-semibold text-white num">${v}</div></div>`).join('')
            : '';

        // cotizaciones: la tabla se construye cuando cambia la lista y luego solo se actualizan celdas
        // (reconstruirla varias veces por segundo haría perder clics).
        const syms = s.symbols || [];
        const tbody = $('#mt-quotes');
        const key = syms.map(q => q.s).join('|');
        if (tbody.dataset.key !== key || !syms.length) {
            tbody.dataset.key = key;
            tbody.innerHTML = syms.map(q => `<tr data-sym="${esc(q.s)}" class="border-t border-slate-600 cursor-pointer hover:bg-slate-600">
                <td class="py-1.5 font-semibold text-white">${esc(q.s)}</td>
                <td class="text-right num" data-c="bid"></td><td class="text-right num" data-c="ask"></td>
                <td class="text-right num text-xs text-slate-300" data-c="chg"></td></tr>`).join('')
                || `<tr><td colspan="4" class="py-3 text-slate-400">${state ? 'Sin símbolos todavía.' : 'Conecta con el puente para ver precios.'}</td></tr>`;
        }
        syms.forEach(q => {
            const tr = tbody.querySelector(`tr[data-sym="${CSS.escape(q.s)}"]`);
            if (!tr) return;
            const d = num(q.d) ?? 5, b = num(q.bid);
            const dir = prevBid[q.s] === undefined || b === prevBid[q.s] ? 0 : b > prevBid[q.s] ? 1 : -1;
            prevBid[q.s] = b;
            const chg = num(q.prev) && b ? (b / q.prev - 1) * 100 : null;
            const bidCell = tr.querySelector('[data-c="bid"]');
            bidCell.textContent = `${px(q.bid, d)} ${dir > 0 ? '▲' : dir < 0 ? '▼' : ''}`.trim();
            if (dir) bidCell.style.color = dir > 0 ? COL.up : COL.down;
            tr.querySelector('[data-c="ask"]').textContent = px(q.ask, d);
            tr.querySelector('[data-c="chg"]').textContent = chg === null ? '—' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} %`;
            tr.classList.toggle('bg-slate-800', q.s === selected);
        });

        // ticket
        const q = symInfo(selected);
        $('#mt-ticket-sym').textContent = selected || '';
        $('#mt-chart-title').textContent = selected ? `${selected} · ${tf}` : 'Gráfico';
        $('#mt-ask').textContent = q ? px(q.ask, q.d) : '—';
        $('#mt-bid').textContent = q ? px(q.bid, q.d) : '—';
        root.querySelectorAll('.side-btn').forEach(b => {
            const on = b.dataset.side === side;
            b.className = `side-btn rounded-lg py-2 font-bold text-white ${on ? (b.dataset.side === 'buy' ? 'bg-blue-600' : 'bg-orange-600') : 'bg-slate-800 hover:bg-slate-600'}`;
        });
        root.querySelectorAll('.otype-btn').forEach(b => {
            b.className = `otype-btn rounded py-1 ${b.dataset.otype === otype ? 'bg-slate-500 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-600'}`;
        });
        $('#mt-price-wrap').classList.toggle('opacity-40', otype === 'market');
        $('#mt-price').disabled = otype === 'market';
        const send = $('#mt-send');
        send.className = `w-full text-white font-bold py-3 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${side === 'buy' ? 'bg-blue-600 hover:bg-blue-700' : 'bg-orange-600 hover:bg-orange-700'}`;
        send.textContent = `Revisar ${side === 'buy' ? 'compra' : 'venta'}${selected ? ` de ${selected}` : ''}`;
        const ea = s.ea || {};
        const off = !state ? 'Sin conexión con el puente.'
            : !s.connected ? 'MetaTrader no está enviando datos (¿EA en un gráfico y WebRequest permitido?).'
                : !ea.trading ? 'El trading está desactivado en MetaTrader: activa AllowTrading en el EA y el botón Algo Trading.' : '';
        send.disabled = Boolean(off) || !selected;
        $('#mt-trade-off').textContent = off;
        ticketInfo();

        // posiciones: misma idea, filas fijas por ticket y celdas que se actualizan
        const pos = s.positions || [];
        const pbody = $('#mt-positions');
        const pkey = pos.map(p => `${p.ticket}:${p.sl}:${p.tp}:${p.vol}`).join('|');
        if (pbody.dataset.key !== pkey || !pos.length) {
            pbody.dataset.key = pkey;
            pbody.innerHTML = pos.length ? pos.map(p => {
                const d = (symInfo(p.s) || {}).d ?? 5;
                return `<tr class="border-t border-slate-600" data-ticket="${esc(p.ticket)}">
                    <td class="py-1.5 pr-2 font-semibold text-white">${esc(p.s)}</td>
                    <td class="pr-2" style="color:${p.type === 'buy' ? COL.up : COL.down}">${p.type === 'buy' ? 'Compra' : 'Venta'}</td>
                    <td class="pr-2 text-right num">${esc(p.vol)}</td>
                    <td class="pr-2 text-right num">${px(p.open, d)}</td>
                    <td class="pr-2 text-right num" data-c="price"></td>
                    <td class="pr-2 text-right num">${px(p.sl, d)}</td>
                    <td class="pr-2 text-right num">${px(p.tp, d)}</td>
                    <td class="pr-2 text-right num font-semibold" data-c="profit"></td>
                    <td class="text-right whitespace-nowrap">
                        <button type="button" data-be="${esc(p.ticket)}" class="text-xs bg-slate-600 hover:bg-slate-500 text-white rounded px-2 py-1 mr-1" title="Mover el stop al precio de entrada">SL→entrada</button>
                        <button type="button" data-close="${esc(p.ticket)}" class="text-xs bg-slate-900 hover:bg-black text-white rounded px-2 py-1">Cerrar</button>
                    </td></tr>`;
            }).join('') : `<tr><td colspan="9" class="py-3 text-slate-400">Sin posiciones abiertas.</td></tr>`;
        }
        pos.forEach(p => {
            const tr = pbody.querySelector(`tr[data-ticket="${CSS.escape(String(p.ticket))}"]`);
            if (!tr) return;
            const d = (symInfo(p.s) || {}).d ?? 5, pr = num(p.profit);
            tr.querySelector('[data-c="price"]').textContent = px(p.price, d);
            tr.querySelector('[data-c="profit"]').textContent = pr === null ? '—' : `${pr > 0 ? '▲ ' : pr < 0 ? '▼ ' : ''}${signed(pr, cur)}`;
        });

        // actividad
        const cmds = s.commands || [];
        const st = { pending: 'pendiente', sent: 'enviada a MT5', done: 'hecha', rejected: 'rechazada', expired: 'caducada' };
        $('#mt-log').innerHTML = cmds.filter(c => c.kind !== 'bars').map(c => `
            <li class="flex justify-between gap-2 border-t border-slate-600 pt-1">
                <span class="text-slate-300">#${esc(c.id)} ${c.origin ? `<span class="text-blue-300">[${esc(String(c.origin).replace('auto:', 'auto · '))}]</span> ` : ''}${c.kind === 'order' ? `${esc(String(c.side).toUpperCase())} ${esc(c.volume)} ${esc(c.symbol)} SL ${esc(c.sl)}${c.tp ? ` TP ${esc(c.tp)}` : ''}` : c.kind === 'close' ? `Cerrar #${esc(c.ticket)}` : `Modificar #${esc(c.ticket)}`}
                    ${c.message ? `<span class="text-slate-400">· ${esc(c.message)}</span>` : ''}</span>
                <span class="${c.status === 'done' ? 'text-blue-300' : c.status === 'rejected' || c.status === 'expired' ? 'text-orange-300' : 'text-slate-400'} whitespace-nowrap">${esc(st[c.status] || c.status)}</span>
            </li>`).join('') || '<li class="text-slate-400">Nada todavía.</li>';

        renderDesk();
    }

    // ---------- analistas, riesgo y piloto automático ----------
    const SIG_STATUS = { enviada: 'Ejecutada sola', aviso: 'Aviso', bloqueada: 'Bloqueada', ignorada: 'Ignorada' };
    const inputCls = 'mt-1 w-full rounded-md bg-slate-800 border-slate-600 text-white text-sm';

    function renderDeskShell() {
        return `
            <div class="grid gap-4 lg:grid-cols-2 mt-4">
                <div class="desk-card">
                    <h3>Analistas</h3>
                    <p class="text-xs text-slate-400 mb-3">Viven en el puente y leen los precios de MetaTrader en tiempo real, aunque cierres la app.
                       Conéctalos y elige si solo te avisan o si operan solos con el piloto automático.</p>
                    <div id="mt-analysts" class="space-y-3"></div>
                </div>
                <div class="desk-card">
                    <h3>Tu riesgo</h3>
                    <form id="mt-riskform" class="space-y-3" autocomplete="off"></form>
                </div>
            </div>
            <div class="desk-card mt-4">
                <h3>Señales de los analistas</h3>
                <ul id="mt-signals" class="text-sm space-y-2 max-h-96 overflow-y-auto"></ul>
            </div>`;
    }

    // Se reconstruye solo cuando cambia la configuración en el puente y no estás escribiendo en ella.
    function renderDesk() {
        const d = state && state.desk;
        const box = $('#mt-analysts'), form = $('#mt-riskform');
        if (!box || !form) return;
        renderAutoBar(d);
        if (!d) {
            box.innerHTML = `<p class="text-sm text-slate-400">${state ? 'Este puente no tiene analistas: actualízalo.' : 'Conecta con el puente.'}</p>`;
            form.innerHTML = '';
            $('#mt-signals').innerHTML = '';
            deskRev = -1;
            return;
        }
        const editing = (box.contains(document.activeElement) || form.contains(document.activeElement)) && document.activeElement.tagName === 'INPUT';
        if (d.rev !== deskRev && !editing) {
            deskRev = d.rev;
            box.innerHTML = d.analysts.map(analystHtml).join('');
            form.innerHTML = riskFormHtml(d.settings);
        }
        // estado de cada analista
        d.analysts.forEach(a => {
            const el = box.querySelector(`[data-astatus="${CSS.escape(a.id)}"]`);
            if (!el) return;
            const st = Object.entries(a.status || {});
            el.innerHTML = !a.enabled ? 'Desconectado' : a.kind === 'external' ? 'Conectado · esperando señales por /api/signal'
                : !st.length ? '<span class="text-orange-300">Conectado, pero sin símbolos: añade alguno.</span>'
                    : st.map(([sym, v]) => `<span class="inline-block mr-3"><b class="text-slate-200">${esc(sym)}</b> ${esc(v || '…')}</span>`).join('');
        });
        const ea = (state && state.ea) || {};
        const cap = $('#mt-ea-cap');
        if (cap) cap.textContent = ea.max_risk != null ? `Techo en MetaTrader (EA): ${money(ea.max_risk, state.account && state.account.currency)} y ${ea.max_volume} lotes por orden. Para subirlo, cambia MaxRiskPerTrade y MaxVolume en el EA.` : '';
        // señales
        const list = $('#mt-signals');
        const sigs = d.signals || [];
        const skey = sigs.map(g => `${g.id}:${g.status}`).join('|');
        if (list.dataset.key !== skey) {
            list.dataset.key = skey;
            list.innerHTML = sigs.map(signalHtml).join('') || '<li class="text-slate-400 text-sm">Aún no hay señales. Conecta algún analista con símbolos.</li>';
        }
    }

    function renderAutoBar(d) {
        const el = $('#mt-auto');
        if (!el) return;
        if (!d) { el.innerHTML = ''; return; }
        const s = d.settings, cur = state.account && state.account.currency;
        const autos = d.analysts.filter(a => a.enabled && a.mode === 'automatico').length;
        const eq = num(state.account && state.account.equity), start = num(d.day && d.day.start_equity);
        const dayPl = eq !== null && start !== null ? eq - start : null;
        const riskTxt = s.risk_mode === 'percent' ? `${s.risk_value} % del balance` : money(s.risk_value, cur);
        const key = [d.auto_on, d.halted, autos, s.risk_mode, s.risk_value, s.max_daily_loss, d.day && d.day.trades, s.max_trades_day, dayPl === null ? '' : dayPl.toFixed(2)].join('|');
        if (el.dataset.key === key) return;
        el.dataset.key = key;
        el.innerHTML = `
            <div class="desk-card flex flex-wrap items-center justify-between gap-3" style="${d.auto_on ? 'box-shadow: inset 0 0 0 2px #60a5fa' : ''}">
                <div class="min-w-0">
                    <div class="text-white font-bold">Piloto automático: ${d.auto_on ? '<span class="text-blue-300">● ENCENDIDO</span>' : '<span class="text-slate-300">○ apagado</span>'}</div>
                    <div class="text-xs text-slate-300 mt-1">${autos} analista${autos === 1 ? '' : 's'} en modo automático · riesgo ${esc(riskTxt)} por operación ·
                        operaciones hoy ${esc(d.day && d.day.trades)}/${esc(s.max_trades_day)} ·
                        resultado del día <b class="num">${dayPl === null ? '—' : `${dayPl > 0 ? '▲ ' : dayPl < 0 ? '▼ ' : ''}${signed(dayPl, cur)}`}</b> (se apaga al perder ${money(s.max_daily_loss, cur)})</div>
                    ${d.halted ? `<div class="text-xs text-orange-300 mt-1">${esc(d.halted)}</div>` : ''}
                </div>
                <button type="button" data-mt="auto" class="flex-none font-bold rounded-lg px-4 py-2 text-white ${d.auto_on ? 'bg-orange-600 hover:bg-orange-700' : 'bg-blue-600 hover:bg-blue-700'}">
                    ${d.auto_on ? 'Apagar piloto' : 'Encender piloto'}</button>
            </div>`;
    }

    function analystHtml(a) {
        const params = (a.param_spec || []).map(p => `
            <label class="block text-xs text-slate-400">${esc(p.label)}
                <input type="number" step="any" min="${esc(p.min)}" max="${esc(p.max)}" data-param="${esc(p.key)}" value="${esc(a.params[p.key])}" class="${inputCls}">
            </label>`).join('');
        return `
            <div class="rounded-lg bg-slate-800 p-3" data-analyst="${esc(a.id)}">
                <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                        <div class="font-semibold text-white">${esc(a.name || a.id)} ${a.kind === 'external' ? '<span class="text-xs text-slate-400">(externo)</span>' : ''}</div>
                        <div class="text-xs text-slate-400">${esc(a.description || '')}</div>
                    </div>
                    <label class="flex items-center gap-2 text-xs text-slate-200 flex-none cursor-pointer">
                        <input type="checkbox" data-f="enabled" ${a.enabled ? 'checked' : ''} class="rounded"> Conectado
                    </label>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
                    <label class="block text-xs text-slate-400">Modo
                        <select data-f="mode" class="${inputCls}">
                            <option value="avisos" ${a.mode === 'avisos' ? 'selected' : ''}>Solo avisos</option>
                            <option value="automatico" ${a.mode === 'automatico' ? 'selected' : ''}>Automático</option>
                        </select>
                    </label>
                    ${a.kind === 'builtin' ? `
                    <label class="block text-xs text-slate-400 col-span-2">Símbolos (separados por comas)
                        <input type="text" data-f="symbols" value="${esc((a.symbols || []).join(', '))}" placeholder="${esc(selected || 'EURUSD')}" class="${inputCls}">
                    </label>
                    <label class="block text-xs text-slate-400">Velas
                        <select data-f="tf" class="${inputCls}">${['M1', 'M5', 'M15'].map(t => `<option ${a.tf === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
                    </label>` : ''}
                </div>
                ${params ? `<details class="mt-2"><summary class="text-xs text-blue-300 cursor-pointer">Parámetros</summary><div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">${params}</div></details>` : ''}
                <div class="text-xs text-slate-400 mt-2" data-astatus="${esc(a.id)}"></div>
            </div>`;
    }

    function riskFormHtml(s) {
        const f = (key, label, val, extra = '') => `<label class="block text-xs text-slate-400">${label}
            <input type="number" step="any" min="0" inputmode="decimal" name="${key}" value="${esc(val)}" class="${inputCls}" ${extra}></label>`;
        return `
            <div class="grid grid-cols-2 gap-2">
                <label class="block text-xs text-slate-400">Riesgo por operación automática en
                    <select name="risk_mode" class="${inputCls}">
                        <option value="money" ${s.risk_mode === 'money' ? 'selected' : ''}>Dinero (divisa de la cuenta)</option>
                        <option value="percent" ${s.risk_mode === 'percent' ? 'selected' : ''}>% del balance (máx. 5 %)</option>
                    </select>
                </label>
                ${f('risk_value', 'Riesgo por operación', s.risk_value)}
                ${f('max_risk', 'Pérdida máxima por operación (manual y auto)', s.max_risk)}
                ${f('max_volume', 'Lotes máximos por orden', s.max_volume)}
                ${f('max_daily_loss', 'Pérdida máxima del día (apaga el piloto)', s.max_daily_loss)}
                ${f('max_positions', 'Posiciones abiertas a la vez', s.max_positions, 'step="1" min="1"')}
                ${f('max_trades_day', 'Operaciones automáticas por día', s.max_trades_day, 'step="1" min="1"')}
                ${f('min_stop_spreads', 'Distancia mínima del stop (× spread)', s.min_stop_spreads)}
            </div>
            <label class="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                <input type="checkbox" name="breakeven" ${s.breakeven ? 'checked' : ''} class="rounded">
                Mover el stop a la entrada cuando la operación gane 1R
            </label>
            <p id="mt-ea-cap" class="text-xs text-slate-400"></p>
            <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 rounded-lg">Guardar riesgo</button>`;
    }

    function signalHtml(g) {
        const d = (symInfo(g.symbol) || {}).d ?? 5;
        const t = new Date(g.time * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const buy = g.side === 'buy';
        const badge = { enviada: 'bg-blue-600', aviso: 'bg-slate-500', bloqueada: 'bg-orange-700', ignorada: 'bg-slate-700' }[g.status] || 'bg-slate-600';
        const canUse = g.status === 'aviso' || g.status === 'bloqueada';
        return `<li class="border-t border-slate-600 pt-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="min-w-0">
                    <span class="text-xs text-slate-400 num">${esc(t)}</span>
                    <b class="text-white ml-1">${esc(g.analyst_name)}</b>
                    <span class="ml-1 font-semibold" style="color:${buy ? COL.up : COL.down}">${buy ? '▲ Compra' : '▼ Venta'} ${esc(g.symbol)}</span>
                    ${g.tf ? `<span class="text-xs text-slate-400">${esc(g.tf)}</span>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs font-bold text-white rounded-full px-2 py-0.5 ${badge}">${esc(SIG_STATUS[g.status] || g.status)}</span>
                    ${canUse ? `<button type="button" data-usesig="${esc(g.id)}" class="text-xs bg-slate-600 hover:bg-slate-500 text-white rounded px-2 py-1">Al ticket</button>` : ''}
                </div>
            </div>
            <div class="text-xs text-slate-300 num mt-1">Entrada ≈ ${px(g.entry, d)} · SL ${px(g.sl, d)} · TP ${g.tp ? px(g.tp, d) : '—'}${g.volume ? ` · ${esc(g.volume)} lotes · riesgo ${money(g.risk, state.account && state.account.currency)}` : ''}</div>
            <div class="text-xs text-slate-400">${esc(g.reason || '')}${g.message ? ` · ${esc(g.message)}` : ''}</div>
        </li>`;
    }

    async function saveAnalyst(card) {
        const body = { id: card.dataset.analyst };
        card.querySelectorAll('[data-f]').forEach(el => { body[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; });
        const params = {};
        card.querySelectorAll('[data-param]').forEach(el => { params[el.dataset.param] = Number(el.value); });
        if (Object.keys(params).length) body.params = params;
        if (body.enabled && body.mode === 'automatico' && !(state.desk && state.desk.auto_on)) toast('Modo automático guardado. Opera solo cuando enciendas el piloto automático.', 'info');
        try { await api('/api/desk/analyst', body); } catch (e) { toast(e.message, 'error'); }
    }

    async function saveRisk(e) {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = { risk_mode: fd.get('risk_mode'), breakeven: fd.get('breakeven') === 'on' };
        ['risk_value', 'max_risk', 'max_volume', 'max_daily_loss', 'max_positions', 'max_trades_day', 'min_stop_spreads'].forEach(k => { body[k] = Number(fd.get(k)); });
        if (document.activeElement) document.activeElement.blur();
        try { await api('/api/desk/settings', body); toast('Riesgo guardado en el puente.', 'success'); } catch (err) { toast(err.message, 'error'); }
    }

    async function toggleAuto() {
        const d = state && state.desk;
        if (!d) return;
        if (d.auto_on) {
            try { await api('/api/desk/auto', { on: false }); toast('Piloto automático apagado.', 'info'); } catch (e) { toast(e.message, 'error'); }
            return;
        }
        const s = d.settings, cur = state.account && state.account.currency;
        const autos = d.analysts.filter(a => a.enabled && a.mode === 'automatico').map(a => a.name || a.id);
        const real = state.account && !state.account.demo;
        const msg = `${real ? '⚠ CUENTA REAL: DINERO REAL.\n\n' : ''}El piloto automático abrirá operaciones SIN pedirte confirmación.\n\n` +
            `Analistas en automático: ${autos.length ? autos.join(', ') : 'ninguno todavía'}\n` +
            `Riesgo por operación: ${s.risk_mode === 'percent' ? `${s.risk_value} % del balance` : money(s.risk_value, cur)} (máx. ${money(s.max_risk, cur)})\n` +
            `Se apaga solo al perder ${money(s.max_daily_loss, cur)} en el día.\nMáximo ${s.max_positions} posiciones y ${s.max_trades_day} operaciones al día.\n\n¿Encenderlo?`;
        if (!confirm(msg)) return;
        try { await api('/api/desk/auto', { on: true, confirm: true }); toast('Piloto automático encendido.', 'success'); } catch (e) { toast(e.message, 'error'); }
    }

    // Lleva una señal (aviso o bloqueada) al ticket manual, con los lotes de tu riesgo.
    function useSignal(id) {
        const g = ((state.desk && state.desk.signals) || []).find(x => String(x.id) === String(id));
        if (!g) return;
        if (!symInfo(g.symbol)) { toast(`${g.symbol} no está en MetaTrader.`, 'error'); return; }
        selectSymbol(g.symbol);
        side = g.side; otype = 'market';
        $('#mt-sl').value = g.sl ?? '';
        $('#mt-tp').value = g.tp || '';
        $('#mt-vol').value = g.volume || '';
        renderLive();
        $('#mt-ticket').scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('Señal cargada en el ticket: revísala y confirma.', 'info');
    }

    // ---------- ticket ----------
    function readTicket() {
        const q = symInfo(selected);
        const v = id => num($(id).value);
        const entry = otype === 'market' ? (q ? num(side === 'buy' ? q.ask : q.bid) : null) : v('#mt-price');
        return { q, entry, sl: v('#mt-sl'), tp: v('#mt-tp'), vol: v('#mt-vol'), risk: v('#mt-risk') };
    }

    function moneyAtRisk(q, entry, sl, vol) {
        const tv = num(q && q.tv), ts = num(q && q.ts);
        if (!tv || !ts || entry === null || sl === null || !vol) return null;
        const dist = side === 'buy' ? entry - sl : sl - entry;
        return dist / ts * tv * vol;
    }

    function volumeForRisk() {
        const { q, entry, sl, risk } = readTicket();
        if (!q || entry === null || sl === null || !risk) { toast('Indica stop loss y riesgo para calcular los lotes.', 'error'); return; }
        const perLot = moneyAtRisk(q, entry, sl, 1);
        if (!perLot || perLot <= 0) { toast('El stop está en el lado equivocado.', 'error'); return; }
        const step = num(q.vstep) || 0.01;
        let vol = Math.floor(risk / perLot / step + 1e-9) * step;
        const vmax = Math.min(num(q.vmax) || Infinity, num(state && state.ea && state.ea.max_volume) || Infinity);
        vol = Math.min(vol, vmax);
        const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
        if (vol < (num(q.vmin) || step)) { toast(`Con ese stop ni el lote mínimo (${q.vmin}) cabe en ${risk}.`, 'error'); $('#mt-vol').value = ''; ticketInfo(); return; }
        $('#mt-vol').value = vol.toFixed(decimals);
        lsSet(LS.risk, String(risk));
        ticketInfo();
    }

    function ticketInfo() {
        const el = $('#mt-ticket-info');
        if (!el) return;
        const { q, entry, sl, tp, vol } = readTicket();
        const cur = state && state.account && state.account.currency;
        if (!q || entry === null || sl === null || !vol) { el.textContent = 'El stop loss es obligatorio. Usa "Lotes por riesgo" para dimensionar la orden.'; return; }
        const risk = moneyAtRisk(q, entry, sl, vol);
        if (risk === null || risk <= 0) { el.innerHTML = '<span class="text-orange-300">El stop está en el lado equivocado de la entrada.</span>'; return; }
        const max = Math.min(num(state.limits && state.limits.max_risk) ?? Infinity, num(state.ea && state.ea.max_risk) ?? Infinity);
        const rr = tp ? Math.abs(tp - entry) / Math.abs(entry - sl) : null;
        el.innerHTML = `Entrada ≈ <b class="num">${px(entry, q.d)}</b> · pérdida en el stop <b class="num">${money(risk, cur)}</b>${rr ? ` · beneficio:riesgo <b class="num">${rr.toFixed(2)}R</b>` : ''}
            ${risk > max ? `<span class="block text-orange-300">Supera tu máximo por operación (${money(max, cur)}): se rechazará.</span>` : ''}`;
    }

    function reviewOrder(e) {
        e.preventDefault();
        const { q, entry, sl, tp, vol } = readTicket();
        if (!q) return;
        if (!sl) { toast('El stop loss es obligatorio.', 'error'); return; }
        if (!vol) { toast('Indica los lotes.', 'error'); return; }
        if (otype !== 'market' && !entry) { toast('Indica el precio de la orden pendiente.', 'error'); return; }
        const cur = state.account && state.account.currency;
        const risk = moneyAtRisk(q, entry, sl, vol);
        const real = state.account && !state.account.demo;
        const verb = side === 'buy' ? 'COMPRAR' : 'VENDER';
        const how = otype === 'market' ? 'a mercado' : `${otype === 'limit' ? 'limitada' : 'stop'} a ${px(entry, q.d)}`;
        $('#mt-confirm-body').innerHTML = `
            ${real ? '<p class="mb-2 rounded bg-red-700 px-2 py-1 font-bold text-white">CUENTA REAL: dinero real</p>' : '<p class="mb-2 text-xs text-slate-400">Cuenta demo</p>'}
            <p class="text-base text-white font-semibold">${verb} ${esc(vol)} lotes de ${esc(q.s)} ${esc(how)}</p>
            <ul class="mt-2 space-y-1 text-slate-300 num">
                <li>Stop loss: <b>${px(sl, q.d)}</b></li>
                <li>Take profit: <b>${tp ? px(tp, q.d) : 'sin objetivo'}</b></li>
                <li>Pérdida si salta el stop: <b>${money(risk, cur)}</b> (puede ser mayor con huecos o deslizamiento)</li>
            </ul>`;
        const dlg = $('#mt-confirm');
        const okBtn = $('#mt-confirm-ok');
        okBtn.textContent = `Sí, ${side === 'buy' ? 'comprar' : 'vender'}`;
        dlg.returnValue = '';
        dlg.onclose = async () => {
            if (dlg.returnValue !== 'ok') return;
            try {
                const r = await api('/api/order', { symbol: q.s, side, type: otype, volume: vol, price: otype === 'market' ? 0 : entry, sl, tp: tp || 0, confirm: true });
                toast(`Orden #${r.id} enviada a MetaTrader…`, 'info');
            } catch (err) { toast(`Rechazada por el puente: ${err.message}`, 'error'); }
        };
        if (dlg.showModal) dlg.showModal(); else if (confirm($('#mt-confirm-body').innerText)) { dlg.returnValue = 'ok'; dlg.onclose(); }
    }

    async function closePosition(ticket) {
        const p = (state.positions || []).find(x => String(x.ticket) === String(ticket));
        if (!p) return;
        if (!confirm(`¿Cerrar ${p.type === 'buy' ? 'la compra' : 'la venta'} de ${p.vol} ${p.s} (#${p.ticket}) a mercado?`)) return;
        try { await api('/api/close', { ticket: p.ticket, confirm: true }); } catch (err) { toast(err.message, 'error'); }
    }

    async function stopToEntry(ticket) {
        const p = (state.positions || []).find(x => String(x.ticket) === String(ticket));
        if (!p) return;
        if (!confirm(`¿Mover el stop de #${p.ticket} ${p.s} a la entrada (${p.open})?`)) return;
        try { await api('/api/modify', { ticket: p.ticket, sl: p.open, tp: p.tp || 0 }); } catch (err) { toast(err.message, 'error'); }
    }

    // Rellena el ticket con trader/plan.json de la Mesa de Trading (mismo ticker si existe en el bróker).
    function usePlan() {
        const plan = window.TradingDesk && window.TradingDesk.getPlan && window.TradingDesk.getPlan();
        if (!plan) { toast('No hay plan cargado en la Mesa de Trading.', 'error'); return; }
        const match = state && state.symbols.find(s => s.s === plan.symbol || s.s.replace(/[^A-Z]/gi, '').toUpperCase().startsWith(String(plan.symbol).toUpperCase()));
        if (match) selectSymbol(match.s);
        else toast(`${plan.symbol} no está en tus símbolos de MetaTrader: añádelo a Observación de Mercado. Relleno los precios igualmente.`, 'info');
        side = 'buy';
        otype = 'market';
        $('#mt-sl').value = plan.stop ?? '';
        $('#mt-tp').value = plan.target ?? '';
        renderLive();
        toast('Plan cargado: revisa los lotes con "Lotes por riesgo".', 'success');
    }

    function selectSymbol(s) {
        if (s === selected) return;
        selected = s;
        lsSet(LS.symbol, s);
        $('#mt-sl').value = '';
        $('#mt-tp').value = '';
        $('#mt-vol').value = '';
        requestBars();
        renderLive();
    }

    // ---------- gráfico de velas (canvas) ----------
    function drawChart() {
        const cv = root && $('#mt-chart');
        if (!cv) return;
        const wrap = $('#mt-chart-wrap');
        const W = wrap.clientWidth, H = wrap.clientHeight;
        if (!W) return;
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        g.font = '11px Inter, system-ui, sans-serif';
        const q = symInfo(selected);
        if (!bars.length) {
            g.fillStyle = COL.text;
            g.fillText(state ? (selected ? 'Cargando velas…' : 'Elige un símbolo') : 'Sin conexión', 12, 22);
            return;
        }
        const m = { l: 6, r: 64, t: 10, b: 20 };
        const slot = Math.max(5, Math.min(14, (W - m.l - m.r) / 90));
        const n = Math.min(bars.length, Math.floor((W - m.l - m.r) / slot));
        const vis = bars.slice(-n);
        const d = q ? (num(q.d) ?? 5) : 5;
        const pos = state && state.positions ? state.positions.filter(p => p.s === selected) : [];
        let lo = Math.min(...vis.map(b => b.l)), hi = Math.max(...vis.map(b => b.h));
        pos.forEach(p => [p.open, p.sl, p.tp].forEach(v => { if (num(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
        const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.001 || 1;
        lo -= pad; hi += pad;
        const y = v => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
        const x = i => m.l + i * slot + slot / 2;

        // rejilla y eje de precios
        g.strokeStyle = COL.grid; g.lineWidth = 1; g.fillStyle = COL.text; g.textAlign = 'left';
        for (let i = 0; i <= 4; i++) {
            const v = lo + (hi - lo) * i / 4, yy = Math.round(y(v)) + 0.5;
            g.beginPath(); g.moveTo(m.l, yy); g.lineTo(W - m.r, yy); g.stroke();
            g.fillText(v.toFixed(d), W - m.r + 6, yy + 4);
        }
        // eje de tiempo
        g.textAlign = 'center';
        const fmtT = t => { const dt = new Date(t * 1000); return tf === 'D1' ? dt.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : dt.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); };
        [0.15, 0.5, 0.85].forEach(f => { const i = Math.floor((vis.length - 1) * f); g.fillText(fmtT(vis[i].t), x(i), H - 5); });

        // velas
        const bw = Math.max(1, slot * 0.6);
        vis.forEach((b, i) => {
            const up = b.c >= b.o;
            g.strokeStyle = g.fillStyle = up ? COL.up : COL.down;
            g.beginPath(); g.moveTo(Math.round(x(i)) + 0.5, y(b.h)); g.lineTo(Math.round(x(i)) + 0.5, y(b.l)); g.stroke();
            const top = y(Math.max(b.o, b.c)), h = Math.max(1, Math.abs(y(b.o) - y(b.c)));
            g.fillRect(x(i) - bw / 2, top, bw, h);
        });

        // líneas de posiciones: entrada, SL y TP
        const hline = (v, color, label, dash) => {
            if (!num(v)) return;
            const yy = Math.round(y(v)) + 0.5;
            g.save(); g.strokeStyle = color; g.setLineDash(dash ? [5, 4] : []); g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(m.l, yy); g.lineTo(W - m.r, yy); g.stroke(); g.restore();
            g.fillStyle = color; g.fillRect(W - m.r + 1, yy - 8, m.r - 2, 16);
            g.fillStyle = '#0f172a'; g.textAlign = 'left'; g.fillText(`${label}`, W - m.r + 4, yy + 4);
        };
        pos.forEach(p => { hline(p.open, COL.entry, 'Ent', false); hline(p.sl, COL.sl, 'SL', true); hline(p.tp, COL.tp, 'TP', true); });
        // precio actual
        if (q && num(q.bid)) {
            const yy = Math.round(y(q.bid)) + 0.5;
            g.save(); g.strokeStyle = COL.price; g.globalAlpha = 0.5; g.setLineDash([2, 3]);
            g.beginPath(); g.moveTo(m.l, yy); g.lineTo(W - m.r, yy); g.stroke(); g.restore();
            g.fillStyle = COL.price; g.fillRect(W - m.r + 1, yy - 8, m.r - 2, 16);
            g.fillStyle = '#0f172a'; g.textAlign = 'left'; g.fillText(Number(q.bid).toFixed(d), W - m.r + 4, yy + 4);
        }
        // cruz
        if (chartHover !== null) {
            const i = Math.max(0, Math.min(vis.length - 1, Math.round((chartHover - m.l - slot / 2) / slot)));
            const b = vis[i];
            g.save(); g.strokeStyle = COL.price; g.globalAlpha = 0.35; g.beginPath(); g.moveTo(Math.round(x(i)) + 0.5, m.t); g.lineTo(Math.round(x(i)) + 0.5, H - m.b); g.stroke(); g.restore();
            const tip = $('#mt-chart-tip');
            tip.classList.remove('hidden');
            tip.textContent = `${fmtT(b.t)}  A ${b.o.toFixed(d)}  Máx ${b.h.toFixed(d)}  Mín ${b.l.toFixed(d)}  C ${b.c.toFixed(d)}`;
        }
    }

    // ---------- eventos ----------
    function wire() {
        $('#mt-settings').addEventListener('submit', (e) => {
            e.preventDefault();
            lsSet(LS.base, $('#mt-base').value.trim().replace(/\/+$/, ''));
            lsSet(LS.token, $('#mt-token').value.trim());
            connect().then(renderAll);
        });
        root.querySelector('[data-mt="settings"]').addEventListener('click', () => $('#mt-settings').classList.toggle('hidden'));
        const dc = root.querySelector('[data-mt="disconnect"]');
        if (dc) dc.addEventListener('click', disconnect);
        $('#mt-auto').addEventListener('click', (e) => { if (e.target.closest('[data-mt="auto"]')) toggleAuto(); });
        $('#mt-analysts').addEventListener('change', (e) => { const card = e.target.closest('[data-analyst]'); if (card) saveAnalyst(card); });
        $('#mt-riskform').addEventListener('submit', saveRisk);
        $('#mt-signals').addEventListener('click', (e) => { const b = e.target.closest('[data-usesig]'); if (b) useSignal(b.dataset.usesig); });
        root.querySelector('[data-mt="notif"]').addEventListener('click', async () => {
            if (!('Notification' in window)) { toast('Este navegador no admite notificaciones.', 'error'); return; }
            const p = await Notification.requestPermission();
            toast(p === 'granted' ? 'Te avisaré de órdenes ejecutadas o rechazadas.' : 'Notificaciones no permitidas.', p === 'granted' ? 'success' : 'error');
        });
        root.querySelector('[data-mt="calcvol"]').addEventListener('click', volumeForRisk);
        root.querySelector('[data-mt="useplan"]').addEventListener('click', usePlan);
        $('#mt-quotes').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sym]'); if (tr) selectSymbol(tr.dataset.sym); });
        root.querySelectorAll('[data-tf]').forEach(b => b.addEventListener('click', () => {
            tf = b.dataset.tf; lsSet(LS.tf, tf);
            root.querySelectorAll('[data-tf]').forEach(x => { x.className = `text-xs rounded px-2 py-1 ${x.dataset.tf === tf ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-600'}`; });
            requestBars(); renderLive();
        }));
        root.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => { side = b.dataset.side; renderLive(); }));
        root.querySelectorAll('[data-otype]').forEach(b => b.addEventListener('click', () => {
            otype = b.dataset.otype;
            const q = symInfo(selected);
            if (otype !== 'market' && q && !$('#mt-price').value) $('#mt-price').value = side === 'buy' ? q.ask : q.bid;
            renderLive();
        }));
        ['#mt-price', '#mt-sl', '#mt-tp', '#mt-vol', '#mt-risk'].forEach(id => $(id).addEventListener('input', ticketInfo));
        $('#mt-ticket').addEventListener('submit', reviewOrder);
        $('#mt-positions').addEventListener('click', (e) => {
            const c = e.target.closest('[data-close]'), be = e.target.closest('[data-be]');
            if (c) closePosition(c.dataset.close);
            if (be) stopToEntry(be.dataset.be);
        });
        const cv = $('#mt-chart');
        const move = (ev) => { const r = cv.getBoundingClientRect(); chartHover = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left; scheduleDraw(); };
        const leave = () => { chartHover = null; $('#mt-chart-tip').classList.add('hidden'); scheduleDraw(); };
        cv.addEventListener('mousemove', move); cv.addEventListener('mouseleave', leave);
        cv.addEventListener('touchmove', move, { passive: true }); cv.addEventListener('touchend', leave);
    }

    function init() {
        root = document.getElementById('mt5-section');
        if (!root) return;
        // ?token=... en la URL (lo imprime el puente): se guarda y se quita de la barra de direcciones.
        let openTab = false;
        const params = new URLSearchParams(location.search);
        if (params.get('token')) {
            lsSet(LS.token, params.get('token'));
            if (/^https?:$/.test(location.protocol)) lsSet(LS.base, location.origin);
            params.delete('token');
            const qs = params.toString();
            history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
            openTab = true;
        }
        tf = TFS.includes(lsGet(LS.tf, 'M1')) ? lsGet(LS.tf, 'M1') : 'M1';
        renderAll();
        // Al entrar con el enlace del puente, abre directamente esta pestaña.
        if (openTab && window.TradingDesk) window.TradingDesk.showView('mt5');
        if (token()) connect();
        let t = null;
        window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(drawChart, 120); });
        window.addEventListener('view-change', (e) => { if (e.detail === 'mt5') drawChart(); });
    }

    window.MT5Live = { reconnect: connect };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
