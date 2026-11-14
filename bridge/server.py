#!/usr/bin/env python3
"""
Puente web-finances <-> MetaTrader 5
=====================================

Servidor local, solo biblioteca estándar de Python (3.8+), que:

  * sirve la app (index.html, PWA) al ordenador y, con --lan, al móvil por la WiFi;
  * recibe en tiempo real precios, cuenta y posiciones de MetaTrader 5 y los emite a la app (SSE);
  * pasa a MetaTrader las órdenes que confirmes en la app, después de validarlas aquí
    (stop obligatorio, riesgo máximo, volumen máximo, límite de órdenes por minuto) y otra vez en MT5.

Fuentes de datos (elige una):

  --source ea       (por defecto) el Expert Advisor mt5/WebFinancesBridge.mq5 empuja los datos
                    con WebRequest. Funciona en MT5 de Windows, macOS y Linux (Wine).
  --source python   el paquete oficial MetaTrader5 de Python (solo Windows, con el terminal abierto):
                    pip install MetaTrader5
  --source demo     simulador con precios aleatorios, para probar la app sin MetaTrader.

Uso:

  python3 bridge/server.py                    # http://127.0.0.1:8765, fuente EA
  python3 bridge/server.py --demo             # simulador
  python3 bridge/server.py --lan              # accesible desde el móvil en la misma WiFi

El token de acceso se crea en bridge/.token la primera vez (no se sube a git). La app lo pide una
vez; el EA lo lleva en su parámetro "Token".
"""

import argparse
import hmac
import ipaddress
import json
import math
import mimetypes
import os
import random
import secrets
import socket
import sys
import threading
import time
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analysts  # noqa: E402  (analistas y piloto automático, mismo directorio)

VERSION = "1.1"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOKEN_FILE = os.path.join(HERE, ".token")

STATIC_EXT = {".html", ".js", ".css", ".webmanifest", ".svg", ".png", ".ico", ".json"}
STATIC_DIRS = {"", "icons"}            # carpetas servidas sin token (la app en sí)
DATA_DIRS = ("trader/",)               # datos de las skills: requieren token
TIMEFRAMES = {"M1": 60, "M5": 300, "M15": 900, "H1": 3600, "D1": 86400}
EA_STALE_SECONDS = 5.0

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


def now():
    return time.time()


def log(msg):
    sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    sys.stdout.flush()


# --------------------------------------------------------------------------------------------
# Estado compartido
# --------------------------------------------------------------------------------------------
class Hub:
    """Último estado de MetaTrader, cola de comandos y difusión a los clientes SSE."""

    def __init__(self, limits):
        self.lock = threading.Condition()
        self.limits = limits
        self.version = 0
        self.state = {"account": None, "symbols": {}, "positions": [], "orders": [], "ea": None}
        self.source = None
        self.last_push = 0.0
        self.commands = {}             # id -> comando
        self.queue = deque()           # ids pendientes de enviar al EA
        self.events = deque(maxlen=200)  # eventos (resultados, barras) para SSE
        self.event_seq = 0
        self.order_times = deque()
        self.next_id = 1
        self.desk = None               # analysts.AnalystDesk

    # --- actualización desde la fuente ---
    def update(self, payload):
        with self.lock:
            st = self.state
            if "account" in payload:
                st["account"] = payload["account"]
            if "ea" in payload:
                st["ea"] = payload["ea"]
            for s in payload.get("symbols") or []:
                if isinstance(s, dict) and s.get("s"):
                    st["symbols"][str(s["s"])] = s
            if "positions" in payload:
                st["positions"] = payload.get("positions") or []
            if "orders" in payload:
                st["orders"] = payload.get("orders") or []
            self.last_push = now()
            self.version += 1
            self.lock.notify_all()

    def emit(self, kind, data):
        with self.lock:
            self.event_seq += 1
            self.events.append((self.event_seq, kind, data))
            self.version += 1
            self.lock.notify_all()
        if kind == "bars" and self.desk:    # fuera del candado: los analistas usan el historial
            self.desk.on_bars(data)

    def snapshot(self, desk=True):
        # el estado de los analistas se lee fuera del candado del hub (evita bloqueos cruzados)
        desk_state = self.desk.public() if (desk and self.desk) else None
        with self.lock:
            age = now() - self.last_push if self.last_push else None
            return {
                "desk": desk_state,
                "type": "state",
                "source": self.source,
                "connected": age is not None and age < EA_STALE_SECONDS,
                "age": round(age, 2) if age is not None else None,
                "server_time": now(),
                "limits": self.limits,
                "account": self.state["account"],
                "ea": self.state["ea"],
                "symbols": list(self.state["symbols"].values()),
                "positions": self.state["positions"],
                "orders": self.state["orders"],
                "commands": sorted(self.commands.values(), key=lambda c: -c["id"])[:30],
            }

    # --- comandos ---
    def add_command(self, cmd):
        with self.lock:
            cmd["id"] = self.next_id
            self.next_id += 1
            cmd["status"] = "pending"
            cmd["created"] = now()
            self.commands[cmd["id"]] = cmd
            self.queue.append(cmd["id"])
            # mantener solo los 100 más recientes
            for old in sorted(self.commands)[:-100]:
                self.commands.pop(old, None)
            self.version += 1
            self.lock.notify_all()
            return dict(cmd)

    def take_commands(self):
        out = []
        with self.lock:
            while self.queue:
                cid = self.queue.popleft()
                cmd = self.commands.get(cid)
                if not cmd or cmd["status"] != "pending":
                    continue
                if now() - cmd["created"] > 30:      # una orden vieja no se envía nunca
                    cmd["status"] = "expired"
                    cmd["message"] = "caducada: MetaTrader no la recogió en 30 s"
                    continue
                cmd["status"] = "sent"
                out.append(dict(cmd))
            if out:
                self.version += 1
                self.lock.notify_all()
        return out

    def result(self, res):
        with self.lock:
            cmd = self.commands.get(int(res.get("id", 0)))
            if not cmd:
                return False
            cmd["status"] = "done" if res.get("ok") else "rejected"
            cmd["retcode"] = res.get("retcode")
            cmd["message"] = str(res.get("message", ""))[:300]
            if res.get("ticket"):
                cmd["ticket"] = res.get("ticket")
            self.version += 1
            self.lock.notify_all()
        self.emit("result", dict(cmd))
        return True

    def allow_order_rate(self):
        with self.lock:
            t = now()
            while self.order_times and t - self.order_times[0] > 60:
                self.order_times.popleft()
            if len(self.order_times) >= self.limits["max_orders_per_minute"]:
                return False
            self.order_times.append(t)
            return True


# --------------------------------------------------------------------------------------------
# Validación de órdenes (la misma idea que /trader-risk: el stop es obligatorio y el riesgo cabe)
# --------------------------------------------------------------------------------------------
def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def risk_money(sym, side, entry, sl, volume):
    """Pérdida aproximada en la divisa de la cuenta si salta el stop."""
    tv, ts = _num(sym.get("tv")), _num(sym.get("ts"))
    if not tv or not ts or entry is None or sl is None:
        return None
    dist = (entry - sl) if side == "buy" else (sl - entry)
    return max(0.0, dist) / ts * tv * volume


def validate_order(hub, body):
    snap = hub.snapshot(desk=False)
    limits = hub.limits
    if not snap["connected"]:
        return None, "MetaTrader no está conectado"
    ea = snap.get("ea") or {}
    if not ea.get("trading"):
        return None, "El EA tiene el trading desactivado (parámetro AllowTrading=false)"
    sym_name = str(body.get("symbol", "")).strip()
    sym = next((s for s in snap["symbols"] if s.get("s") == sym_name), None)
    if not sym:
        return None, "Símbolo desconocido: añádelo al parámetro Symbols del EA o a Observación de Mercado"
    side = body.get("side")
    if side not in ("buy", "sell"):
        return None, "Lado inválido"
    otype = body.get("type", "market")
    if otype not in ("market", "limit", "stop"):
        return None, "Tipo de orden inválido"
    volume = _num(body.get("volume"))
    if not volume or volume <= 0:
        return None, "Volumen inválido"
    if volume > limits["max_volume"]:
        return None, "Volumen por encima del máximo (%s lotes)" % limits["max_volume"]
    sl, tp = _num(body.get("sl")), _num(body.get("tp"))
    price = _num(body.get("price")) or 0.0
    if not sl:
        return None, "El stop loss es obligatorio"
    bid, ask = _num(sym.get("bid")), _num(sym.get("ask"))
    entry = price if otype != "market" else (ask if side == "buy" else bid)
    if otype != "market" and not price:
        return None, "Falta el precio de la orden pendiente"
    if entry is None:
        return None, "Sin precio para el símbolo"
    if side == "buy" and sl >= entry:
        return None, "En una compra el stop debe estar por debajo de la entrada"
    if side == "sell" and sl <= entry:
        return None, "En una venta el stop debe estar por encima de la entrada"
    if tp and ((side == "buy" and tp <= entry) or (side == "sell" and tp >= entry)):
        return None, "El take profit está en el lado equivocado"
    risk = risk_money(sym, side, entry, sl, volume)
    max_risk = limits["max_risk"]
    if ea.get("max_risk") is not None:
        max_risk = min(max_risk, float(ea["max_risk"]))
    if risk is not None and risk > max_risk + 1e-9:
        return None, "Riesgo %.2f por encima del máximo %.2f por operación" % (risk, max_risk)
    acct = snap.get("account") or {}
    if not acct.get("demo") and not limits["allow_live"]:
        return None, "Cuenta REAL: el puente solo opera en demo salvo que lo arranques con --allow-live"
    if not body.get("confirm"):
        return None, "Falta la confirmación"
    if not hub.allow_order_rate():
        return None, "Demasiadas órdenes en el último minuto"
    return {
        "kind": "order", "symbol": sym_name, "side": side, "volume": volume, "type": otype,
        "price": price, "sl": sl, "tp": tp or 0.0,
        "risk": round(risk, 2) if risk is not None else None,
    }, None


# --------------------------------------------------------------------------------------------
# Fuente: simulador
# --------------------------------------------------------------------------------------------
DEMO_SYMBOLS = [
    # nombre, precio, dígitos, volatilidad por tick, tick_size, tick_value por lote, contrato
    ("EURUSD", 1.0850, 5, 0.00004, 0.00001, 1.0, 100000),
    ("GBPUSD", 1.2700, 5, 0.00005, 0.00001, 1.0, 100000),
    ("USDJPY", 151.20, 3, 0.006, 0.001, 0.66, 100000),
    ("XAUUSD", 2385.0, 2, 0.12, 0.01, 1.0, 100),
    ("US500", 5820.0, 1, 0.35, 0.1, 0.1, 1),
    ("BTCUSD", 68000.0, 2, 9.0, 0.01, 0.01, 1),
]


class DemoSource(threading.Thread):
    daemon = True

    def __init__(self, hub, max_risk, max_volume):
        super().__init__()
        self.hub = hub
        self.rng = random.Random(7)
        self.syms = {}
        self.hist = {}
        self.positions = []
        self.ticket = 1000
        self.balance = 10000.0
        self.max_risk = max_risk
        self.max_volume = max_volume
        t0 = int(now()) // 60 * 60
        for name, px, d, vol, ts, tv, contract in DEMO_SYMBOLS:
            bars = []
            p = px
            for i in range(300, 0, -1):     # 300 velas de 1 minuto de historia
                o = p
                h = l = o
                for _ in range(12):
                    p += self.rng.gauss(0, vol * 2)
                    h, l = max(h, p), min(l, p)
                bars.append([t0 - i * 60, round(o, d), round(h, d), round(l, d), round(p, d), self.rng.randint(50, 500)])
            self.hist[name] = bars
            spread = ts * (12 if d >= 3 else 3)
            self.syms[name] = {"s": name, "bid": round(p, d), "ask": round(p + spread, d), "d": d,
                               "prev": round(px, d), "ts": ts, "tv": tv, "vstep": 0.01, "vmin": 0.01,
                               "vmax": 100.0, "contract": contract, "_vol": vol, "_spread": spread}

    def public_syms(self):
        return [{k: v for k, v in s.items() if not k.startswith("_")} for s in self.syms.values()]

    def run(self):
        while True:
            for s in self.syms.values():
                mid = s["bid"] + self.rng.gauss(0, s["_vol"])
                s["bid"] = round(mid, s["d"])
                s["ask"] = round(mid + s["_spread"], s["d"])
                s["t"] = int(now() * 1000)
                bars = self.hist[s["s"]]
                minute = int(now()) // 60 * 60
                if bars[-1][0] == minute:
                    b = bars[-1]
                    b[2], b[3], b[4] = max(b[2], s["bid"]), min(b[3], s["bid"]), s["bid"]
                    b[5] += 1
                else:
                    bars.append([minute, s["bid"], s["bid"], s["bid"], s["bid"], 1])
                    del bars[:-500]
            self._mark_positions()
            self.hub.update(self._payload())
            time.sleep(0.25)

    def _profit(self, p):
        s = self.syms[p["s"]]
        px = s["bid"] if p["type"] == "buy" else s["ask"]
        diff = (px - p["open"]) if p["type"] == "buy" else (p["open"] - px)
        return diff / s["ts"] * s["tv"] * p["vol"]

    def _mark_positions(self):
        keep = []
        for p in self.positions:
            s = self.syms[p["s"]]
            px = s["bid"] if p["type"] == "buy" else s["ask"]
            p["price"] = px
            p["profit"] = round(self._profit(p), 2)
            hit_sl = p["sl"] and ((p["type"] == "buy" and px <= p["sl"]) or (p["type"] == "sell" and px >= p["sl"]))
            hit_tp = p["tp"] and ((p["type"] == "buy" and px >= p["tp"]) or (p["type"] == "sell" and px <= p["tp"]))
            if hit_sl or hit_tp:
                self.balance += p["profit"]
                self.hub.emit("result", {"kind": "close", "status": "done", "ticket": p["ticket"],
                                         "message": "%s %s cerrada por %s: %.2f" % (p["s"], p["ticket"], "stop" if hit_sl else "take profit", p["profit"])})
            else:
                keep.append(p)
        self.positions = keep

    def _payload(self):
        profit = sum(p["profit"] for p in self.positions)
        # margen aproximado con apalancamiento 1:100 (en USD)
        margin = sum(p["vol"] * self.syms[p["s"]]["contract"] * (1.0 if p["s"].startswith("USD") else p["open"]) / 100.0
                     for p in self.positions)
        return {
            "ea": {"version": "demo", "trading": True, "live_allowed": False, "max_risk": self.max_risk, "max_volume": self.max_volume},
            "account": {"login": 0, "name": "Cuenta DEMO simulada", "server": "web-finances-demo", "company": "Simulador",
                        "currency": "USD", "balance": round(self.balance, 2), "equity": round(self.balance + profit, 2),
                        "profit": round(profit, 2), "margin": round(margin, 2),
                        "free_margin": round(self.balance + profit - margin, 2), "leverage": 100, "demo": True},
            "symbols": self.public_syms(),
            "positions": [dict(p) for p in self.positions],
            "orders": [],
        }

    def execute(self, cmd):
        k = cmd["kind"]
        if k == "order":
            if cmd["type"] != "market":
                return {"ok": False, "retcode": 10013, "message": "El simulador solo ejecuta órdenes a mercado"}
            s = self.syms[cmd["symbol"]]
            self.ticket += 1
            px = s["ask"] if cmd["side"] == "buy" else s["bid"]
            self.positions.append({"ticket": self.ticket, "s": cmd["symbol"], "type": cmd["side"], "vol": cmd["volume"],
                                   "open": px, "sl": cmd["sl"], "tp": cmd["tp"], "price": px, "profit": 0.0, "swap": 0.0,
                                   "time": int(now()), "magic": 770077, "comment": "web-finances"})
            return {"ok": True, "retcode": 10009, "ticket": self.ticket, "message": "Ejecutada a %s" % px}
        if k == "close":
            for p in self.positions:
                if p["ticket"] == cmd["ticket"]:
                    self.positions.remove(p)
                    self.balance += p["profit"]
                    return {"ok": True, "retcode": 10009, "ticket": p["ticket"], "message": "Cerrada: %.2f" % p["profit"]}
            return {"ok": False, "retcode": 10036, "message": "Posición no encontrada"}
        if k == "modify":
            for p in self.positions:
                if p["ticket"] == cmd["ticket"]:
                    p["sl"], p["tp"] = cmd["sl"], cmd["tp"]
                    return {"ok": True, "retcode": 10009, "ticket": p["ticket"], "message": "SL/TP modificados"}
            return {"ok": False, "retcode": 10036, "message": "Posición no encontrada"}
        if k == "bars":
            step = TIMEFRAMES.get(cmd["tf"], 60) // 60
            m1 = self.hist.get(cmd["symbol"], [])
            bars = []
            for i in range(0, len(m1), step):
                grp = m1[i:i + step]
                if grp:
                    bars.append([grp[0][0], grp[0][1], max(b[2] for b in grp), min(b[3] for b in grp), grp[-1][4], sum(b[5] for b in grp)])
            return {"ok": True, "bars": bars[-cmd["count"]:]}
        return {"ok": False, "message": "comando desconocido"}


# --------------------------------------------------------------------------------------------
# Fuente: paquete MetaTrader5 de Python (Windows)
# --------------------------------------------------------------------------------------------
class PythonMT5Source(threading.Thread):
    daemon = True

    def __init__(self, hub, symbols, max_risk, max_volume, allow_trading, magic=770077):
        super().__init__()
        try:
            import MetaTrader5 as mt5  # noqa: N813
        except ImportError:
            sys.exit("Falta el paquete MetaTrader5 (solo Windows): pip install MetaTrader5")
        self.mt5 = mt5
        if not mt5.initialize():
            sys.exit("No se pudo conectar con el terminal MetaTrader 5: %s" % (mt5.last_error(),))
        self.hub = hub
        self.symbols = symbols
        self.max_risk, self.max_volume = max_risk, max_volume
        self.allow_trading = allow_trading
        self.magic = magic
        self.mlock = threading.Lock()

    def _symbols(self):
        mt5 = self.mt5
        names = self.symbols or [s.name for s in (mt5.symbols_get() or []) if s.visible]
        out = []
        for n in names[:60]:
            info = mt5.symbol_info(n)
            tick = mt5.symbol_info_tick(n)
            if not info or not tick:
                mt5.symbol_select(n, True)
                continue
            rates = mt5.copy_rates_from_pos(n, mt5.TIMEFRAME_D1, 1, 1)
            prev = float(rates[0]["close"]) if rates is not None and len(rates) else None
            out.append({"s": n, "bid": tick.bid, "ask": tick.ask, "last": tick.last, "t": tick.time_msc, "d": info.digits,
                        "prev": prev, "tv": info.trade_tick_value, "ts": info.trade_tick_size, "vmin": info.volume_min,
                        "vmax": info.volume_max, "vstep": info.volume_step, "contract": info.trade_contract_size})
        return out

    def run(self):
        mt5 = self.mt5
        while True:
            try:
                with self.mlock:
                    a = mt5.account_info()
                    syms = self._symbols()
                    pos = mt5.positions_get() or []
                    ords = mt5.orders_get() or []
                    term = mt5.terminal_info()
                acct = None
                if a:
                    acct = {"login": a.login, "name": a.name, "server": a.server, "company": a.company, "currency": a.currency,
                            "balance": a.balance, "equity": a.equity, "profit": a.profit, "margin": a.margin,
                            "free_margin": a.margin_free, "leverage": a.leverage, "demo": a.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO}
                self.hub.update({
                    "ea": {"version": "python", "trading": bool(self.allow_trading and term and term.trade_allowed),
                           "live_allowed": self.hub.limits["allow_live"], "max_risk": self.max_risk, "max_volume": self.max_volume},
                    "account": acct,
                    "symbols": syms,
                    "positions": [{"ticket": p.ticket, "s": p.symbol, "type": "buy" if p.type == 0 else "sell", "vol": p.volume,
                                   "open": p.price_open, "sl": p.sl, "tp": p.tp, "price": p.price_current, "profit": p.profit,
                                   "swap": p.swap, "time": p.time, "magic": p.magic, "comment": p.comment} for p in pos],
                    "orders": [{"ticket": o.ticket, "s": o.symbol, "type": o.type, "vol": o.volume_current, "price": o.price_open,
                                "sl": o.sl, "tp": o.tp} for o in ords],
                })
            except Exception as e:  # el terminal puede reiniciarse; seguimos intentándolo
                log("MetaTrader5: %s" % e)
            time.sleep(0.25)

    def execute(self, cmd):
        mt5 = self.mt5
        with self.mlock:
            if cmd["kind"] == "bars":
                tf = getattr(mt5, "TIMEFRAME_" + cmd["tf"], mt5.TIMEFRAME_M1)
                r = mt5.copy_rates_from_pos(cmd["symbol"], tf, 0, cmd["count"])
                bars = [] if r is None else [[int(x["time"]), float(x["open"]), float(x["high"]), float(x["low"]), float(x["close"]), int(x["tick_volume"])] for x in r]
                return {"ok": True, "bars": bars}
            if not self.allow_trading:
                return {"ok": False, "message": "Trading desactivado (arranca con --allow-trading)"}
            if cmd["kind"] == "order":
                tick = mt5.symbol_info_tick(cmd["symbol"])
                market = cmd["type"] == "market"
                if market:
                    action, otype = mt5.TRADE_ACTION_DEAL, (mt5.ORDER_TYPE_BUY if cmd["side"] == "buy" else mt5.ORDER_TYPE_SELL)
                    price = tick.ask if cmd["side"] == "buy" else tick.bid
                else:
                    action = mt5.TRADE_ACTION_PENDING
                    otype = {("buy", "limit"): mt5.ORDER_TYPE_BUY_LIMIT, ("sell", "limit"): mt5.ORDER_TYPE_SELL_LIMIT,
                             ("buy", "stop"): mt5.ORDER_TYPE_BUY_STOP, ("sell", "stop"): mt5.ORDER_TYPE_SELL_STOP}[(cmd["side"], cmd["type"])]
                    price = cmd["price"]
                req = {"action": action, "symbol": cmd["symbol"], "volume": cmd["volume"], "type": otype, "price": price,
                       "sl": cmd["sl"], "tp": cmd["tp"] or 0.0, "deviation": 20, "magic": self.magic,
                       "comment": "web-finances", "type_time": mt5.ORDER_TIME_GTC}
                if market:
                    req["type_filling"] = mt5.ORDER_FILLING_IOC
                res = mt5.order_send(req)
            elif cmd["kind"] == "close":
                pos = mt5.positions_get(ticket=cmd["ticket"])
                if not pos:
                    return {"ok": False, "message": "Posición no encontrada"}
                p = pos[0]
                tick = mt5.symbol_info_tick(p.symbol)
                buy = p.type == 0
                res = mt5.order_send({"action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume, "position": p.ticket,
                                      "type": mt5.ORDER_TYPE_SELL if buy else mt5.ORDER_TYPE_BUY,
                                      "price": tick.bid if buy else tick.ask, "deviation": 20, "magic": self.magic,
                                      "comment": "web-finances close", "type_filling": mt5.ORDER_FILLING_IOC})
            elif cmd["kind"] == "modify":
                res = mt5.order_send({"action": mt5.TRADE_ACTION_SLTP, "position": cmd["ticket"], "sl": cmd["sl"], "tp": cmd["tp"]})
            else:
                return {"ok": False, "message": "comando desconocido"}
            if res is None:
                return {"ok": False, "message": str(mt5.last_error())}
            ok = res.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED, mt5.TRADE_RETCODE_DONE_PARTIAL)
            return {"ok": ok, "retcode": res.retcode, "ticket": res.order or res.deal, "message": res.comment}


# --------------------------------------------------------------------------------------------
# Comandos: van al EA (cola) o se ejecutan directamente (demo / python)
# --------------------------------------------------------------------------------------------
def dispatch(hub, active, cmd):
    cmd = hub.add_command(cmd)
    if active is None:
        return cmd                       # el EA lo recogerá en su próximo envío

    def work():
        hub.take_commands()              # lo marca como enviado
        res = active.execute(cmd)
        res["id"] = cmd["id"]
        if cmd["kind"] == "bars":
            hub.result({"id": cmd["id"], "ok": res.get("ok"), "message": "%d velas" % len(res.get("bars") or [])})
            hub.emit("bars", {"symbol": cmd["symbol"], "tf": cmd["tf"], "bars": res.get("bars") or []})
        else:
            hub.result(res)
    threading.Thread(target=work, daemon=True).start()
    return cmd


def ea_line(cmd):
    """Formato de texto plano para el EA (MQL5 no trae parser JSON)."""
    k = cmd["kind"]
    if k == "order":
        return "ORDER;%d;%s;%s;%.8g;%s;%.10g;%.10g;%.10g" % (cmd["id"], cmd["symbol"], cmd["side"], cmd["volume"], cmd["type"], cmd["price"], cmd["sl"], cmd["tp"])
    if k == "close":
        return "CLOSE;%d;%d" % (cmd["id"], cmd["ticket"])
    if k == "modify":
        return "MODIFY;%d;%d;%.10g;%.10g" % (cmd["id"], cmd["ticket"], cmd["sl"], cmd["tp"])
    if k == "bars":
        return "BARS;%d;%s;%s;%d" % (cmd["id"], cmd["symbol"], cmd["tf"], cmd["count"])
    return ""


# --------------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "web-finances-bridge/" + VERSION
    protocol_version = "HTTP/1.1"

    # silenciar el log por petición (el EA envía 4 por segundo)
    def log_message(self, fmt, *args):
        pass

    @property
    def hub(self):
        return self.server.hub

    def _authorized(self, query):
        tok = self.headers.get("X-Token") or (query.get("token") or [""])[0]
        return bool(tok) and hmac.compare_digest(tok.encode(), self.server.token.encode())

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json_body(self, limit=1_000_000):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > limit:
            return None
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8", "replace").rstrip("\x00"))
        except ValueError:
            return None

    # ---------------- GET ----------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        path = url.path
        if path == "/api/ping":
            return self._send(200, {"ok": True, "version": VERSION, "auth": self._authorized(q)})
        if path.startswith("/api/") or path.startswith("/" + DATA_DIRS[0]):
            if not self._authorized(q):
                return self._send(401, {"error": "token inválido"})
        if path == "/api/state":
            return self._send(200, self.hub.snapshot())
        if path == "/api/stream":
            return self._stream()
        return self._static(path)

    def _static(self, path):
        rel = path.lstrip("/") or "index.html"
        if ".." in rel.split("/") or rel.startswith(".") or "/." in rel:
            return self._send(404, {"error": "no encontrado"})
        ext = os.path.splitext(rel)[1].lower()
        folder = os.path.dirname(rel)
        is_data = any(rel.startswith(d) for d in DATA_DIRS)
        if is_data:
            if ext != ".json":
                return self._send(404, {"error": "no encontrado"})
        elif folder not in STATIC_DIRS or ext not in STATIC_EXT or (ext == ".json" and folder == ""):
            return self._send(404, {"error": "no encontrado"})
        full = os.path.realpath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT + os.sep) or not os.path.isfile(full):
            return self._send(404, {"error": "no encontrado"})
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript") or ctype.endswith("json"):
            ctype += "; charset=utf-8"
        extra = {"Service-Worker-Allowed": "/"} if rel == "sw.js" else None
        return self._send(200, data, ctype, extra)

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        hub = self.hub
        seen_version = -1
        with hub.lock:
            seen_event = hub.event_seq
        last_sent = 0.0
        try:
            while True:
                with hub.lock:
                    if hub.version == seen_version:
                        hub.lock.wait(timeout=10)
                    version = hub.version
                    events = [e for e in hub.events if e[0] > seen_event]
                if events:
                    seen_event = events[-1][0]
                    for _, kind, data in events:
                        self.wfile.write(("event: %s\ndata: %s\n\n" % (kind, json.dumps(data, ensure_ascii=False))).encode("utf-8"))
                wait = 0.15 - (now() - last_sent)       # como mucho ~7 estados por segundo
                if wait > 0:
                    time.sleep(wait)
                if version != seen_version:
                    seen_version = version
                    last_sent = now()
                    self.wfile.write(("event: state\ndata: %s\n\n" % json.dumps(hub.snapshot(), ensure_ascii=False)).encode("utf-8"))
                else:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    # ---------------- POST ----------------
    def do_POST(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if not self._authorized(q):
            return self._send(401, {"error": "token inválido"})
        path = url.path
        hub, active = self.hub, self.server.active
        body = self._json_body()

        # --- desde el EA ---
        if path == "/mt5/push":
            if not isinstance(body, dict):
                return self._send(400, "ERR;json inválido", "text/plain; charset=utf-8")
            if hub.source != "ea":
                return self._send(409, "ERR;el puente no está en modo EA", "text/plain; charset=utf-8")
            hub.update(body)
            lines = [ea_line(c) for c in hub.take_commands()]
            return self._send(200, "\n".join(["OK"] + [ln for ln in lines if ln]) + "\n", "text/plain; charset=utf-8")
        if path == "/mt5/result":
            if not isinstance(body, dict):
                return self._send(400, {"error": "json inválido"})
            hub.result(body)
            return self._send(200, {"ok": True})
        if path == "/mt5/bars":
            if not isinstance(body, dict):
                return self._send(400, {"error": "json inválido"})
            hub.result({"id": body.get("id", 0), "ok": True, "message": "%d velas" % len(body.get("bars") or [])})
            hub.emit("bars", {"symbol": body.get("symbol"), "tf": body.get("tf"), "bars": body.get("bars") or []})
            return self._send(200, {"ok": True})

        # --- desde la app ---
        if not isinstance(body, dict):
            return self._send(400, {"error": "json inválido"})
        if path == "/api/order":
            cmd, err = validate_order(hub, body)
            if err:
                return self._send(422, {"error": err})
            log("ORDEN %s %s %s lotes SL %s TP %s (riesgo %s)" % (cmd["side"], cmd["symbol"], cmd["volume"], cmd["sl"], cmd["tp"], cmd["risk"]))
            return self._send(202, dispatch(hub, active, cmd))
        if path == "/api/close":
            ticket = int(_num(body.get("ticket")) or 0)
            if not ticket or not body.get("confirm"):
                return self._send(422, {"error": "Falta el ticket o la confirmación"})
            if not (hub.snapshot().get("ea") or {}).get("trading"):
                return self._send(422, {"error": "Trading desactivado en MetaTrader"})
            log("CERRAR %s" % ticket)
            return self._send(202, dispatch(hub, active, {"kind": "close", "ticket": ticket}))
        if path == "/api/modify":
            ticket = int(_num(body.get("ticket")) or 0)
            sl, tp = _num(body.get("sl")) or 0.0, _num(body.get("tp")) or 0.0
            if not ticket or not sl:
                return self._send(422, {"error": "Falta el ticket o el stop (no se puede quitar el stop)"})
            return self._send(202, dispatch(hub, active, {"kind": "modify", "ticket": ticket, "sl": sl, "tp": tp}))
        if path == "/api/bars":
            sym = str(body.get("symbol", ""))[:32]
            tf = body.get("tf", "M1") if body.get("tf") in TIMEFRAMES else "M1"
            count = max(10, min(int(_num(body.get("count")) or 200), 1000))
            if not sym or ";" in sym or "\n" in sym:
                return self._send(422, {"error": "símbolo inválido"})
            return self._send(202, dispatch(hub, active, {"kind": "bars", "symbol": sym, "tf": tf, "count": count}))
        # --- analistas y piloto automático ---
        desk = hub.desk
        if path == "/api/desk/settings":
            return self._send(200, {"settings": desk.update_settings(body)})
        if path == "/api/desk/analyst":
            a, err = desk.update_analyst(body)
            return self._send(422, {"error": err}) if err else self._send(200, a)
        if path == "/api/desk/auto":
            on = bool(body.get("on"))
            if on and not body.get("confirm"):
                return self._send(422, {"error": "Falta la confirmación para encender el piloto automático"})
            return self._send(200, {"auto_on": desk.set_auto(on)})
        if path == "/api/vote":
            res, err = desk.external_vote(body)
            return self._send(422, {"error": err}) if err else self._send(200, res)
        if path == "/api/signal":
            sig, err = desk.external_signal(body)
            return self._send(422, {"error": err}) if err else self._send(202, sig)
        return self._send(404, {"error": "no encontrado"})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def load_token(explicit):
    if explicit:
        return explicit
    if os.path.isfile(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
            if tok:
                return tok
    tok = secrets.token_urlsafe(18)
    with open(TOKEN_FILE, "w") as f:
        f.write(tok + "\n")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    return tok


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))          # no envía nada; solo elige la interfaz
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ipaddress.ip_address(ip).is_loopback)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Puente web-finances <-> MetaTrader 5")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="escuchar en la red local (para el móvil)")
    ap.add_argument("--host", default=None, help="dirección de escucha (por defecto 127.0.0.1, o 0.0.0.0 con --lan)")
    ap.add_argument("--source", choices=("ea", "python", "demo"), default="ea")
    ap.add_argument("--demo", action="store_true", help="atajo de --source demo")
    ap.add_argument("--symbols", default="", help="solo --source python: símbolos separados por comas (por defecto, Observación de Mercado)")
    ap.add_argument("--allow-trading", action="store_true", help="solo --source python: permite enviar órdenes")
    ap.add_argument("--allow-live", action="store_true", help="permite operar en cuentas REALES (por defecto solo demo)")
    ap.add_argument("--max-risk", type=float, default=50.0, help="pérdida máxima por operación en la divisa de la cuenta (por defecto 50)")
    ap.add_argument("--max-volume", type=float, default=1.0, help="lotes máximos por orden (por defecto 1.0)")
    ap.add_argument("--max-orders-per-minute", type=int, default=6)
    ap.add_argument("--auto", action="store_true", help="arranca con el piloto automático ENCENDIDO")
    ap.add_argument("--token", default=None, help="token fijo (por defecto se genera en bridge/.token)")
    a = ap.parse_args(argv)
    if a.demo:
        a.source = "demo"

    token = load_token(a.token)
    limits = {"max_risk": a.max_risk, "max_volume": a.max_volume, "allow_live": bool(a.allow_live),
              "max_orders_per_minute": a.max_orders_per_minute}
    hub = Hub(limits)
    hub.source = a.source
    active = None
    if a.source == "demo":
        active = DemoSource(hub, a.max_risk, a.max_volume)
        active.start()
    elif a.source == "python":
        syms = [s.strip() for s in a.symbols.split(",") if s.strip()]
        active = PythonMT5Source(hub, syms, a.max_risk, a.max_volume, a.allow_trading)
        active.start()

    desk = analysts.AnalystDesk(hub, dispatch, validate_order, active, bool(a.allow_live), log, auto_start=a.auto)
    hub.desk = desk
    desk.start()

    host = a.host or ("0.0.0.0" if a.lan else "127.0.0.1")
    srv = Server((host, a.port), Handler)
    srv.hub, srv.active, srv.token = hub, active, token

    print("=" * 66)
    print(" web-finances · puente MetaTrader 5  (fuente: %s)" % a.source)
    print("=" * 66)
    print(" Ordenador:  http://127.0.0.1:%d/?token=%s" % (a.port, token))
    if host != "127.0.0.1":
        for ip in lan_ips():
            print(" Móvil:      http://%s:%d/?token=%s" % (ip, a.port, token))
    else:
        print(" Móvil:      arranca con --lan (misma WiFi) o usa un túnel HTTPS (ver README)")
    if a.source == "ea":
        print(" EA:         BridgeUrl=http://127.0.0.1:%d   Token=%s" % (a.port, token))
        print("             (MT5 > Herramientas > Opciones > Asesores Expertos > permitir WebRequest")
        print("              para http://127.0.0.1:%d)" % a.port)
    print(" Límites:    riesgo máx %.2f · %.2f lotes · %d órdenes/min · %s" % (
        hub.limits["max_risk"], hub.limits["max_volume"], a.max_orders_per_minute, "cuentas REALES PERMITIDAS" if a.allow_live else "solo cuentas demo"))
    print(" Comité:     %d analistas votan; opera con %s%% o más de votos a favor" % (
        len(analysts.VOTERS), int(desk.analysts["comite"]["params"]["umbral"])))
    print(" Piloto:     %s" % ("ENCENDIDO: opera solo (--auto)" if a.auto else "apagado · enciéndelo en la app o arranca con --auto"))
    print("=" * 66)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nPuente detenido.")


if __name__ == "__main__":
    main()
