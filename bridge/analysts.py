"""
Analistas y piloto automático del puente web-finances
=====================================================

El puente es el "espacio de los analistas": aquí viven las estrategias que leen los precios en
tiempo real que envía MetaTrader (cada tick del EA), construyen sus propias velas y, al cierre de
cada vela, pueden emitir una señal con entrada, stop y objetivo.

Cada analista se conecta o desconecta desde la app y trabaja en uno de dos modos:

  * "avisos":      la señal aparece en la app y tú decides si la ejecutas.
  * "automatico":  si el piloto automático está encendido, la orden se dimensiona con TU riesgo
                   y se envía sola, pasando por las mismas validaciones que una orden manual
                   (stop obligatorio, riesgo y lotes máximos, solo demo salvo --allow-live) y
                   otra vez por las del EA en MetaTrader.

Analistas externos (tus scripts, Claude con las skills /trader-*...) pueden enviar señales con
POST /api/signal (ver bridge/enviar_senal.py). Aparecen en la app desconectados hasta que los
conectes tú.

El piloto automático SIEMPRE arranca apagado al iniciar el puente, y se apaga solo si se alcanza
la pérdida máxima del día.

Solo biblioteca estándar.
"""

import json
import os
import re
import threading
import time
from collections import deque

HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS_FILE = os.path.join(HERE, "settings.json")
MAGIC = 770077
TF_SEC = {"M1": 60, "M5": 300, "M15": 900}
HISTORY_BARS = 1000
EXTERNAL_ID = re.compile(r"^[a-z0-9_-]{1,32}$")


def now():
    return time.time()


def _num(v):
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _clamp(v, lo, hi, default):
    v = _num(v)
    if v is None:
        return default
    return max(lo, min(hi, v))


# --------------------------------------------------------------------------------------------
# Velas en tiempo real a partir de los ticks
# --------------------------------------------------------------------------------------------
class BarStore:
    """Velas de 1 minuto por símbolo, construidas con cada precio que llega de MetaTrader."""

    def __init__(self):
        self.m1 = {}            # símbolo -> lista de [t, o, h, l, c]
        self.seeded = {}        # símbolo -> momento en que llegó el historial
        self.requested = {}     # símbolo -> momento en que se pidió el historial

    def tick(self, sym, price, t_ms):
        if price is None:
            return
        t = (t_ms / 1000.0) if t_ms else now()
        minute = int(t) // 60 * 60
        bars = self.m1.setdefault(sym, [])
        if bars and bars[-1][0] == minute:
            b = bars[-1]
            b[2], b[3], b[4] = max(b[2], price), min(b[3], price), price
        elif not bars or minute > bars[-1][0]:
            bars.append([minute, price, price, price, price])
            del bars[:-HISTORY_BARS - 50]

    def seed(self, sym, history):
        """Historial de velas M1 que devuelve MetaTrader (comando BARS)."""
        hist = []
        for b in history or []:
            if isinstance(b, (list, tuple)) and len(b) >= 5:
                vals = [_num(x) for x in b[:5]]
                if None not in vals:
                    hist.append([int(vals[0])] + vals[1:])
        if not hist:
            return
        hist.sort(key=lambda b: b[0])
        live = [b for b in self.m1.get(sym, []) if b[0] > hist[-1][0]]
        self.m1[sym] = (hist + live)[-HISTORY_BARS - 50:]
        self.seeded[sym] = now()

    def closed(self, sym, tf):
        """Velas CERRADAS de la temporalidad pedida (la última, aún abierta, se descarta)."""
        bars = self.m1.get(sym) or []
        if len(bars) < 2:
            return []
        step = TF_SEC[tf]
        out = []
        for t, o, h, l, c in bars:
            g = t // step * step
            if out and out[-1][0] == g:
                b = out[-1]
                b[2], b[3], b[4] = max(b[2], h), min(b[3], l), c
            else:
                out.append([g, o, h, l, c])
        return out[:-1]


# --------------------------------------------------------------------------------------------
# Indicadores
# --------------------------------------------------------------------------------------------
def ema(values, n):
    if len(values) < n:
        return []
    k = 2.0 / (n + 1)
    out = [sum(values[:n]) / n]
    for v in values[n:]:
        out.append(v * k + out[-1] * (1 - k))
    return [None] * (n - 1) + out


def rsi(closes, n=14):
    if len(closes) <= n:
        return []
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    ag, al = gains / n, losses / n
    out = [None] * n
    out.append(100.0 if al == 0 else 100 - 100 / (1 + ag / al))
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0)) / n
        al = (al * (n - 1) + max(-d, 0)) / n
        out.append(100.0 if al == 0 else 100 - 100 / (1 + ag / al))
    return out


def atr(bars, n=14):
    if len(bars) <= n:
        return None
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return a


# --------------------------------------------------------------------------------------------
# Analistas integrados
# --------------------------------------------------------------------------------------------
class Analyst:
    id = ""
    name = ""
    description = ""
    params = []        # [(clave, etiqueta, mínimo, máximo, por defecto)]

    def needs(self, p):
        return 60

    def evaluate(self, bars, p):
        """Recibe velas cerradas [t,o,h,l,c] y devuelve ("buy"|"sell", stop, objetivo, motivo) o None."""
        raise NotImplementedError

    @staticmethod
    def levels(side, entry, risk_dist, rr):
        if side == "buy":
            return entry - risk_dist, entry + risk_dist * rr
        return entry + risk_dist, entry - risk_dist * rr


class CruceMedias(Analyst):
    id = "cruce_medias"
    name = "Cruce de medias"
    description = "Compra cuando la media rápida cruza por encima de la lenta y vende al revés. Stop a 1,5 ATR."
    params = [("rapida", "Media rápida", 3, 50, 9), ("lenta", "Media lenta", 10, 200, 21),
              ("atr_mult", "Stop (× ATR)", 0.5, 5, 1.5), ("rr", "Objetivo (R)", 0.5, 5, 2)]

    def needs(self, p):
        return int(max(p["lenta"], 14)) + 3

    def evaluate(self, bars, p):
        closes = [b[4] for b in bars]
        f, s = ema(closes, int(p["rapida"])), ema(closes, int(p["lenta"]))
        if len(f) < 2 or None in (f[-1], f[-2], s[-1], s[-2]):
            return None
        a = atr(bars)
        if not a:
            return None
        if f[-2] <= s[-2] and f[-1] > s[-1]:
            side = "buy"
        elif f[-2] >= s[-2] and f[-1] < s[-1]:
            side = "sell"
        else:
            return None
        sl, tp = self.levels(side, closes[-1], a * p["atr_mult"], p["rr"])
        return side, sl, tp, "Media %d cruza %s la media %d" % (p["rapida"], "por encima de" if side == "buy" else "por debajo de", p["lenta"])


class Ruptura(Analyst):
    id = "ruptura"
    name = "Ruptura de rango"
    description = "Entra cuando una vela cierra fuera del máximo o mínimo de las últimas N velas (canal de Donchian)."
    params = [("velas", "Velas del rango", 5, 100, 20), ("atr_mult", "Stop (× ATR)", 0.5, 5, 1.5), ("rr", "Objetivo (R)", 0.5, 5, 2)]

    def needs(self, p):
        return int(max(p["velas"], 14)) + 3

    def evaluate(self, bars, p):
        n = int(p["velas"])
        prev = bars[-n - 1:-1]
        last = bars[-1]
        hi, lo = max(b[2] for b in prev), min(b[3] for b in prev)
        a = atr(bars)
        if not a:
            return None
        if last[4] > hi and bars[-2][4] <= hi:
            side = "buy"
        elif last[4] < lo and bars[-2][4] >= lo:
            side = "sell"
        else:
            return None
        sl, tp = self.levels(side, last[4], a * p["atr_mult"], p["rr"])
        return side, sl, tp, "Cierre %s del rango de %d velas" % ("por encima" if side == "buy" else "por debajo", n)


class RsiRebote(Analyst):
    id = "rsi_rebote"
    name = "Rebote RSI"
    description = "Compra cuando el RSI sale de sobreventa (vuelve a subir de 30) y vende cuando sale de sobrecompra (baja de 70)."
    params = [("bajo", "Sobreventa", 5, 45, 30), ("alto", "Sobrecompra", 55, 95, 70),
              ("atr_mult", "Stop (× ATR)", 0.5, 5, 1.5), ("rr", "Objetivo (R)", 0.5, 5, 1.5)]

    def needs(self, p):
        return 30

    def evaluate(self, bars, p):
        closes = [b[4] for b in bars]
        r = rsi(closes)
        if len(r) < 2 or None in (r[-1], r[-2]):
            return None
        a = atr(bars)
        if not a:
            return None
        if r[-2] < p["bajo"] <= r[-1]:
            side = "buy"
        elif r[-2] > p["alto"] >= r[-1]:
            side = "sell"
        else:
            return None
        sl, tp = self.levels(side, closes[-1], a * p["atr_mult"], p["rr"])
        return side, sl, tp, "RSI %.0f sale de %s" % (r[-1], "sobreventa" if side == "buy" else "sobrecompra")


from committee import VOTERS, VOTER_IDS, Committee  # noqa: E402  (usa Analyst, ema, rsi, atr de arriba)

COMMITTEE = Committee()
BUILTIN = {a.id: a for a in (COMMITTEE, CruceMedias(), Ruptura(), RsiRebote())}
COMMITTEE_MAX_SYMBOLS = 15


# --------------------------------------------------------------------------------------------
# Mesa de analistas + piloto automático
# --------------------------------------------------------------------------------------------
DEFAULT_SETTINGS = {
    "risk_mode": "money",        # "money" (divisa de la cuenta) o "percent" (del balance)
    "risk_value": 20.0,          # riesgo de cada operación automática
    "max_risk": 50.0,            # techo por operación (manual y automática)
    "max_volume": 1.0,           # lotes máximos por orden
    "max_daily_loss": 100.0,     # al perder esto en el día, el piloto automático se apaga solo
    "max_positions": 3,          # posiciones abiertas a la vez (desde la app o el piloto)
    "max_trades_day": 10,        # operaciones automáticas por día
    "breakeven": True,           # mover el stop a la entrada al ganar 1R
    "min_stop_spreads": 3,       # el stop debe estar al menos a N spreads
}


class AnalystDesk(threading.Thread):
    daemon = True

    def __init__(self, hub, dispatch, validate, active, allow_live, log, auto_start=False):
        super().__init__()
        self.hub, self.dispatch, self.validate, self.active = hub, dispatch, validate, active
        self.allow_live = allow_live
        self.log = log
        self.lock = threading.RLock()
        self.bars = BarStore()
        self.settings = dict(DEFAULT_SETTINGS)
        self.settings["max_risk"] = hub.limits["max_risk"]
        self.settings["max_volume"] = hub.limits["max_volume"]
        self.analysts = {}
        for a in BUILTIN.values():
            self.analysts[a.id] = {"id": a.id, "kind": "builtin", "enabled": False, "mode": "avisos",
                                   "symbols": [], "tf": "M5", "params": {k: d for k, _, _, _, d in a.params}}
        # el comité viene conectado y en automático: con el piloto encendido opera solo.
        # Sin símbolos = todos los de MetaTrader (hasta 15).
        self.analysts["comite"].update(enabled=True, mode="automatico", off=[])
        self.ext_votes = {}          # símbolo -> {analista externo: (voto, caduca)}
        self.runtime = {}            # (analista, símbolo) -> {"last": t, "cool": n, "status": str}
        self.signals = deque(maxlen=60)
        self.signal_seq = 0
        self.auto_on = bool(auto_start)   # apagado salvo que arranques el puente con --auto
        self.halted = ""
        self.day = None
        self.day_start_equity = None
        self.trades_today = 0
        self.be_done = set()
        self.recent = {}             # símbolo -> momento de la última orden automática
        self.rev = 1
        self._load()
        self._apply_limits()

    # ---------------- persistencia ----------------
    def _load(self):
        try:
            with open(SETTINGS_FILE, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        self.update_settings(data.get("settings") or {}, save=False)
        for cfg in data.get("analysts") or []:
            if not isinstance(cfg, dict):
                continue
            aid = str(cfg.get("id", ""))
            if aid not in self.analysts and cfg.get("kind") == "external" and EXTERNAL_ID.match(aid):
                self._ensure_external(aid, cfg.get("name"))
            if aid in self.analysts:
                self.update_analyst(dict(cfg, id=aid), save=False)

    def _save(self):
        data = {"settings": self.settings, "analysts": list(self.analysts.values())}
        tmp = SETTINGS_FILE + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            os.replace(tmp, SETTINGS_FILE)
        except OSError as e:
            self.log("No se pudo guardar bridge/settings.json: %s" % e)

    def _apply_limits(self):
        self.hub.limits["max_risk"] = self.settings["max_risk"]
        self.hub.limits["max_volume"] = self.settings["max_volume"]

    def _changed(self):
        self.rev += 1
        self.hub.emit("desk", {"rev": self.rev})

    # ---------------- configuración desde la app ----------------
    def update_settings(self, body, save=True):
        with self.lock:
            s = self.settings
            if body.get("risk_mode") in ("money", "percent"):
                s["risk_mode"] = body["risk_mode"]
            if "risk_value" in body:
                hi = 5.0 if s["risk_mode"] == "percent" else 1e7
                s["risk_value"] = _clamp(body["risk_value"], 0.01, hi, s["risk_value"])
            if "max_risk" in body:
                s["max_risk"] = _clamp(body["max_risk"], 0.01, 1e7, s["max_risk"])
            if "max_volume" in body:
                s["max_volume"] = _clamp(body["max_volume"], 0.01, 1000, s["max_volume"])
            if "max_daily_loss" in body:
                s["max_daily_loss"] = _clamp(body["max_daily_loss"], 0.01, 1e8, s["max_daily_loss"])
            if "max_positions" in body:
                s["max_positions"] = int(_clamp(body["max_positions"], 1, 50, s["max_positions"]))
            if "max_trades_day" in body:
                s["max_trades_day"] = int(_clamp(body["max_trades_day"], 1, 500, s["max_trades_day"]))
            if "min_stop_spreads" in body:
                s["min_stop_spreads"] = _clamp(body["min_stop_spreads"], 0, 50, s["min_stop_spreads"])
            if "breakeven" in body:
                s["breakeven"] = bool(body["breakeven"])
            if s["risk_mode"] == "percent":
                s["risk_value"] = min(s["risk_value"], 5.0)
            self._apply_limits()
            if save:
                self._save()
                self._changed()
                self.log("Riesgo actualizado desde la app: %s" % json.dumps(s, ensure_ascii=False))
            return dict(s)

    def update_analyst(self, body, save=True):
        with self.lock:
            a = self.analysts.get(str(body.get("id", "")))
            if not a:
                return None, "Analista desconocido"
            if "enabled" in body:
                a["enabled"] = bool(body["enabled"])
            if body.get("mode") in ("avisos", "automatico"):
                a["mode"] = body["mode"]
            if a["kind"] == "builtin":
                if body.get("tf") in TF_SEC:
                    a["tf"] = body["tf"]
                if "symbols" in body:
                    syms = body["symbols"]
                    if isinstance(syms, str):
                        syms = syms.split(",")
                    a["symbols"] = [str(x).strip()[:32] for x in syms if str(x).strip() and ";" not in str(x)][:20]
                spec = BUILTIN[a["id"]].params
                for k, _, lo, hi, d in spec:
                    if k in (body.get("params") or {}):
                        a["params"][k] = _clamp(body["params"][k], lo, hi, a["params"].get(k, d))
                for k, _, _, _, d in spec:
                    a["params"].setdefault(k, d)
                if a["id"] == "comite" and isinstance(body.get("off"), list):
                    a["off"] = sorted({str(x) for x in body["off"]} & VOTER_IDS)
            if save:
                self._save()
                self._changed()
                self.log("Analista %s: %s, modo %s" % (a["id"], "conectado" if a["enabled"] else "desconectado", a["mode"]))
            return dict(a), None

    def set_auto(self, on):
        with self.lock:
            if on and self.halted:
                # volver a encenderlo tras el límite diario es una decisión explícita: se reinicia el contador
                self.day_start_equity = None
                self.halted = ""
            self.auto_on = bool(on)
            self._changed()
        self.log("PILOTO AUTOMÁTICO %s" % ("ENCENDIDO" if on else "apagado"))
        return self.auto_on

    def _ensure_external(self, aid, name=None):
        if aid in self.analysts:
            return self.analysts[aid]
        if sum(1 for a in self.analysts.values() if a["kind"] == "external") >= 20:
            return None
        self.analysts[aid] = {"id": aid, "kind": "external", "name": str(name or aid)[:60], "enabled": False,
                              "mode": "avisos", "symbols": [], "tf": None, "params": {}}
        return self.analysts[aid]

    # ---------------- estado para la app ----------------
    def public(self):
        with self.lock:
            out = []
            for a in self.analysts.values():
                item = dict(a)
                if a["kind"] == "builtin":
                    an = BUILTIN[a["id"]]
                    item.update(name=an.name, description=an.description,
                                param_spec=[{"key": k, "label": l, "min": lo, "max": hi} for k, l, lo, hi, _ in an.params])
                    item["status"] = {k[1]: rt.get("status", "") for k, rt in self.runtime.items() if k[0] == a["id"]}
                    if a["id"] == "comite":
                        item["voters"] = [{"id": v[0], "name": v[1], "family": v[2]} for v in VOTERS]
                        item["tallies"] = {k[1]: rt["tally"] for k, rt in self.runtime.items()
                                           if k[0] == "comite" and rt.get("tally")}
                else:
                    item["description"] = "Analista externo: envía señales con POST /api/signal"
                    item["status"] = {}
                out.append(item)
            return {
                "rev": self.rev,
                "auto_on": self.auto_on,
                "halted": self.halted,
                "settings": dict(self.settings),
                "analysts": out,
                "signals": list(self.signals)[::-1][:40],
                "day": {"date": self.day, "start_equity": self.day_start_equity, "trades": self.trades_today},
            }

    # ---------------- historial (respuesta de MetaTrader al comando BARS) ----------------
    def on_bars(self, data):
        if (data or {}).get("tf") == "M1" and len(data.get("bars") or []) >= 30:
            with self.lock:
                self.bars.seed(str(data.get("symbol")), data.get("bars"))

    def _want_history(self, sym):
        t = now()
        if self.bars.seeded.get(sym) or t - self.bars.requested.get(sym, 0) < 30:
            return
        self.bars.requested[sym] = t
        self.dispatch(self.hub, self.active, {"kind": "bars", "symbol": sym, "tf": "M1", "count": HISTORY_BARS})

    # ---------------- bucle ----------------
    def run(self):
        while True:
            try:
                self.step()
            except Exception as e:      # un fallo de un analista no tumba el puente
                self.log("Analistas: %s" % e)
            time.sleep(0.25)

    def step(self):
        snap = self.hub.snapshot()
        if not snap["connected"]:
            return
        syms = {s.get("s"): s for s in snap["symbols"]}
        with self.lock:
            for name, s in syms.items():
                self.bars.tick(name, _num(s.get("bid")), _num(s.get("t")))
            self._day_guard(snap)
            for a in list(self.analysts.values()):
                if a["kind"] != "builtin" or not a["enabled"]:
                    continue
                targets = a["symbols"]
                if a["id"] == "comite" and not targets:
                    targets = list(syms)[:COMMITTEE_MAX_SYMBOLS]
                for sym in targets:
                    self._run_analyst(a, sym, syms.get(sym), snap)
            if self.settings["breakeven"]:
                self._breakeven(snap, syms)

    def _day_guard(self, snap):
        acct = snap.get("account") or {}
        eq = _num(acct.get("equity"))
        today = time.strftime("%Y-%m-%d")
        if today != self.day:
            self.day, self.day_start_equity, self.trades_today = today, None, 0
            if self.halted:
                self.halted = ""
                self._changed()
        if eq is None:
            return
        if self.day_start_equity is None:
            self.day_start_equity = eq
        loss = self.day_start_equity - eq
        if self.auto_on and loss >= self.settings["max_daily_loss"]:
            self.auto_on = False
            self.halted = "Pérdida del día %.2f ≥ límite %.2f: piloto automático apagado" % (loss, self.settings["max_daily_loss"])
            self.log(self.halted)
            self.hub.emit("signal", {"kind": "halt", "message": self.halted})
            self._changed()

    def _run_analyst(self, a, sym, info, snap):
        key = (a["id"], sym)
        rt = self.runtime.setdefault(key, {"last": None, "cool": 0, "status": ""})
        if not info:
            rt["status"] = "símbolo no disponible en MetaTrader"
            return
        an = BUILTIN[a["id"]]
        p = a["params"]
        if an is COMMITTEE:
            return self._run_committee(a, sym, info, snap, rt)
        need = an.needs(p)
        bars = self.bars.closed(sym, a["tf"])
        if len(bars) < need:
            self._want_history(sym)
            rt["status"] = "calentando %d/%d velas" % (len(bars), need)
            return
        last_t = bars[-1][0]
        if rt["last"] is None:          # primera pasada: no se opera con velas del pasado
            rt["last"] = last_t
            rt["status"] = "vigilando"
            return
        if last_t == rt["last"]:
            return
        rt["last"] = last_t
        if rt["cool"] > 0:
            rt["cool"] -= 1
            rt["status"] = "en pausa %d velas" % rt["cool"]
            return
        res = an.evaluate(bars[-max(need * 3, 120):], p)
        if not res:
            rt["status"] = "vigilando · sin señal en la vela de %s" % time.strftime("%H:%M", time.localtime(last_t + TF_SEC[a["tf"]]))
            return
        side, sl, tp, reason = res
        rt["cool"] = 3
        rt["status"] = "señal %s" % ("compra" if side == "buy" else "venta")
        d = int(_num(info.get("d")) or 5)
        self.handle_signal(a, {"symbol": sym, "side": side, "sl": round(sl, d), "tp": round(tp, d),
                               "reason": reason, "tf": a["tf"]}, snap)

    def _run_committee(self, a, sym, info, snap, rt):
        p = a["params"]
        bars = self.bars.closed(sym, a["tf"])
        need = COMMITTEE.needs(p)
        if len(bars) < need:
            self._want_history(sym)
            rt["status"] = "calentando %d/%d velas" % (len(bars), need)
            return
        last_t = bars[-1][0]
        if last_t == rt["last"]:
            return
        rt["last"] = last_t
        t = now()
        ext = {}
        for aid, (v, exp) in list(self.ext_votes.get(sym, {}).items()):
            if exp < t:
                del self.ext_votes[sym][aid]
            elif (self.analysts.get(aid) or {}).get("enabled"):
                ext[aid] = v
        tally = COMMITTEE.tally(bars, p, set(a.get("off") or []), ext)
        rt["tally"] = tally
        side = tally["side"]
        hora = time.strftime("%H:%M", time.localtime(last_t + TF_SEC[a["tf"]]))
        if not side:
            rt["prev_side"] = None
            rt["status"] = "%s · compra %.0f %% · venta %.0f %% (%d votos, quórum %d)" % (
                hora, tally["pct_buy"], tally["pct_sell"], tally["buy"] + tally["sell"], p["quorum"])
            return
        pct = tally["pct_buy"] if side == "buy" else tally["pct_sell"]
        if rt.get("prev_side") == side:
            # el consenso sigue: ya se actuó cuando se formó
            rt["status"] = "%s · consenso de %s se mantiene (%.0f %%)" % (hora, "compra" if side == "buy" else "venta", pct)
            return
        rt["prev_side"] = side
        a_ = atr(bars)
        if not a_:
            return
        sl, tp = COMMITTEE.levels(side, _num(info.get("ask") if side == "buy" else info.get("bid")) or bars[-1][4],
                                  a_ * p["atr_mult"], p["rr"])
        d = int(_num(info.get("d")) or 5)
        rt["status"] = "%s · ¡CONSENSO %s %.0f %%!" % (hora, "COMPRA" if side == "buy" else "VENTA", pct)
        sig = self.handle_signal(a, {"symbol": sym, "side": side, "sl": round(sl, d), "tp": round(tp, d), "tf": a["tf"],
                               "reason": "Comité: %.0f %% a favor (%d de %d votos)" % (
                                   pct, max(tally["buy"], tally["sell"]), tally["buy"] + tally["sell"])}, snap)
        # si se bloqueó por falta de hueco (máximo de posiciones, límite de órdenes), se reintenta en la
        # próxima vela mientras el consenso siga; si ya hay posición en este símbolo, no.
        msg = sig.get("message", "")
        if sig.get("status") == "bloqueada" and ("posiciones abiertas o en camino (máximo" in msg or "Demasiadas órdenes" in msg):
            rt["prev_side"] = None

    def external_vote(self, body):
        """Voto de un analista externo para el comité (Claude con las skills, tus scripts)."""
        aid = str(body.get("analyst", "")).strip().lower()
        if not EXTERNAL_ID.match(aid) or aid in BUILTIN:
            return None, "analyst: usa 1-32 letras minúsculas, números, - o _"
        v = {"buy": 1, "sell": -1, "neutral": 0}.get(body.get("side"))
        if v is None:
            return None, "side debe ser buy, sell o neutral"
        sym = str(body.get("symbol", "")).strip()[:32]
        if not sym or ";" in sym:
            return None, "Falta symbol"
        minutes = _clamp(body.get("minutes"), 1, 1440, 60)
        with self.lock:
            existed = aid in self.analysts
            a = self._ensure_external(aid, body.get("name"))
            if not a:
                return None, "Demasiados analistas externos"
            if not existed:
                self.log("Nuevo analista externo '%s': conéctalo en la app para que su voto cuente" % aid)
                self._save()
                self._changed()
            self.ext_votes.setdefault(sym, {})[aid] = (v, now() + minutes * 60)
        return {"ok": True, "analyst": aid, "symbol": sym, "vote": body.get("side"), "minutes": minutes,
                "counts": bool(a["enabled"])}, None

    # ---------------- señales ----------------
    def external_signal(self, body):
        aid = str(body.get("analyst", "")).strip().lower()
        if not EXTERNAL_ID.match(aid):
            return None, "analyst: usa 1-32 letras minúsculas, números, - o _"
        if aid in BUILTIN:
            return None, "Ese nombre es de un analista integrado"
        side = body.get("side")
        if side not in ("buy", "sell"):
            return None, "side debe ser buy o sell"
        sym = str(body.get("symbol", "")).strip()[:32]
        sl, tp = _num(body.get("sl")), _num(body.get("tp")) or 0.0
        if not sym or ";" in sym or not sl:
            return None, "Faltan symbol o sl (el stop es obligatorio)"
        snap = self.hub.snapshot()
        with self.lock:
            existed = aid in self.analysts
            a = self._ensure_external(aid, body.get("name"))
            if not a:
                return None, "Demasiados analistas externos"
            if not existed:
                self.log("Nuevo analista externo '%s': conéctalo en la app para usar sus señales" % aid)
                self._save()
                self._changed()
            sig = self.handle_signal(a, {"symbol": sym, "side": side, "sl": sl, "tp": tp,
                                         "reason": str(body.get("reason", ""))[:200], "tf": str(body.get("tf", ""))[:8]}, snap)
            return sig, None

    def handle_signal(self, a, s, snap):
        syms = {x.get("s"): x for x in snap["symbols"]}
        info = syms.get(s["symbol"])
        self.signal_seq += 1
        sig = dict(s, id=self.signal_seq, time=now(), analyst=a["id"],
                   analyst_name=a.get("name") or BUILTIN.get(a["id"]).name, mode=a["mode"])
        if info:
            sig["entry"] = _num(info.get("ask") if s["side"] == "buy" else info.get("bid"))
        if not a["enabled"]:
            sig.update(status="ignorada", message="Analista desconectado: conéctalo en la app para recibir sus señales")
        elif a["mode"] != "automatico":
            sig.update(status="aviso", message="Solo aviso: decide tú si la ejecutas")
            vol, risk, _ = self._size(sig, info, snap)
            sig.update(volume=vol, risk=risk)
        else:
            self._auto_execute(sig, info, snap)
        self.signals.append(sig)
        self.hub.emit("signal", sig)
        self.log("SEÑAL %s %s %s SL %s TP %s → %s %s" % (sig["analyst"], sig["side"], sig["symbol"], sig["sl"], sig.get("tp"),
                                                        sig["status"], sig.get("message", "")))
        return sig

    def _size(self, sig, info, snap):
        """Lotes para el riesgo configurado. Devuelve (lotes, riesgo, error)."""
        if not info:
            return None, None, "Símbolo no disponible en MetaTrader"
        entry, sl = sig.get("entry"), _num(sig.get("sl"))
        tv, ts = _num(info.get("tv")), _num(info.get("ts"))
        if not entry or not sl or not tv or not ts:
            return None, None, "Sin precio o sin valor de tick para dimensionar"
        dist = (entry - sl) if sig["side"] == "buy" else (sl - entry)
        if dist <= 0:
            return None, None, "El stop está en el lado equivocado del precio actual"
        s = self.settings
        bal = _num((snap.get("account") or {}).get("balance")) or 0.0
        budget = s["risk_value"] if s["risk_mode"] == "money" else bal * s["risk_value"] / 100.0
        ea_max = _num((snap.get("ea") or {}).get("max_risk"))
        budget = min(budget, s["max_risk"], ea_max if ea_max else budget)
        per_lot = dist / ts * tv
        step = _num(info.get("vstep")) or 0.01
        vol = int(budget / per_lot / step + 1e-9) * step
        ea_vol = _num((snap.get("ea") or {}).get("max_volume"))
        vol = min(vol, s["max_volume"], _num(info.get("vmax")) or vol, ea_vol if ea_vol else vol)
        frac = ("%.8f" % step).rstrip("0").split(".")[1]
        vol = round(int(vol / step + 1e-9) * step, len(frac))
        vmin = _num(info.get("vmin")) or step
        if vol < vmin - 1e-12:
            return None, None, "Con este stop ni el lote mínimo (%s) cabe en el riesgo de %.2f" % (vmin, budget)
        return vol, round(per_lot * vol, 2), None

    def _auto_execute(self, sig, info, snap):
        s = self.settings
        acct = snap.get("account") or {}

        def block(msg):
            sig.update(status="bloqueada", message=msg)

        if not self.auto_on:
            return block(self.halted or "Piloto automático apagado: queda como aviso")
        if not acct.get("demo") and not self.allow_live:
            return block("Cuenta REAL: el puente solo opera en demo salvo --allow-live")
        if self.trades_today >= s["max_trades_day"]:
            return block("Límite de %d operaciones automáticas por día" % s["max_trades_day"])
        mine = [p.get("s") for p in snap.get("positions") or [] if int(_num(p.get("magic")) or 0) == MAGIC]
        # órdenes que van camino de MetaTrader y aún no son posición
        mine += [c.get("symbol") for c in snap.get("commands") or []
                 if c.get("kind") == "order" and c.get("status") in ("pending", "sent")]
        t = now()
        mine += [sym for sym, ts in self.recent.items() if t - ts < 5 and sym not in mine]
        if len(mine) >= s["max_positions"]:
            return block("Ya hay %d posiciones abiertas o en camino (máximo %d)" % (len(mine), s["max_positions"]))
        if sig["symbol"] in mine:
            return block("Ya hay una posición abierta o en camino en %s" % sig["symbol"])
        if info:
            spread = (_num(info.get("ask")) or 0) - (_num(info.get("bid")) or 0)
            dist = abs((sig.get("entry") or 0) - sig["sl"])
            if spread > 0 and dist < spread * s["min_stop_spreads"]:
                return block("Stop demasiado cerca: %.0f× el spread (mínimo %.0f×)" % (dist / spread, s["min_stop_spreads"]))
        vol, risk, err = self._size(sig, info, snap)
        if err:
            return block(err)
        sig.update(volume=vol, risk=risk)
        cmd, err = self.validate(self.hub, {"symbol": sig["symbol"], "side": sig["side"], "type": "market", "volume": vol,
                                            "price": 0, "sl": sig["sl"], "tp": sig.get("tp") or 0, "confirm": True})
        if err:
            return block(err)
        cmd["origin"] = "auto:%s" % sig["analyst"]
        sent = self.dispatch(self.hub, self.active, cmd)
        self.trades_today += 1
        self.recent[sig["symbol"]] = now()
        sig.update(status="enviada", message="Orden #%s enviada a MetaTrader (%s lotes, riesgo %.2f)" % (sent["id"], vol, risk), order_id=sent["id"])

    def _breakeven(self, snap, syms):
        for p in snap.get("positions") or []:
            if int(_num(p.get("magic")) or 0) != MAGIC or p.get("ticket") in self.be_done:
                continue
            op, sl, px = _num(p.get("open")), _num(p.get("sl")), _num(p.get("price"))
            if not op or not sl or px is None:
                continue
            buy = p.get("type") == "buy"
            r = (op - sl) if buy else (sl - op)
            if r <= 0:                      # el stop ya está en la entrada o en beneficio
                self.be_done.add(p.get("ticket"))
                continue
            gained = (px - op) if buy else (op - px)
            if gained >= r:
                self.be_done.add(p.get("ticket"))
                self.dispatch(self.hub, self.active, {"kind": "modify", "ticket": int(p["ticket"]), "sl": op,
                                                      "tp": _num(p.get("tp")) or 0.0, "origin": "auto:breakeven"})
                self.log("Stop de #%s %s movido a la entrada (+1R)" % (p.get("ticket"), p.get("s")))
