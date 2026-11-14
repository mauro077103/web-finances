#!/usr/bin/env python3
"""
Envía una señal de un analista externo al puente web-finances.

  py bridge\\enviar_senal.py --analista claude --simbolo EURUSD --lado buy --sl 1.0820 --tp 1.0900 --motivo "Ruptura"

  # o usando el plan de la skill /trader-exit (trader/plan.json):
  py bridge\\enviar_senal.py --analista claude --plan trader/plan.json --simbolo TSLA

  # o solo VOTAR en el comité (cuenta como un analista más durante --minutos):
  py bridge\enviar_senal.py --analista claude --simbolo EURUSD --lado buy --votar --minutos 60

La primera vez el analista aparece en la app DESCONECTADO: conéctalo y elige "Solo avisos" o
"Automático". El puente calcula los lotes con tu riesgo y aplica todos los límites.
Solo biblioteca estándar.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser(description="Envía una señal al puente web-finances")
    ap.add_argument("--analista", required=True, help="identificador: minúsculas, números, - o _")
    ap.add_argument("--nombre", default=None, help="nombre visible en la app")
    ap.add_argument("--simbolo", help="símbolo tal como aparece en MetaTrader (EURUSD, US500...)")
    ap.add_argument("--lado", choices=("buy", "sell", "neutral"))
    ap.add_argument("--votar", action="store_true", help="en vez de una señal, un voto para el comité")
    ap.add_argument("--minutos", type=int, default=60, help="con --votar: cuánto dura el voto")
    ap.add_argument("--sl", type=float, help="stop loss (obligatorio)")
    ap.add_argument("--tp", type=float, default=0.0, help="take profit")
    ap.add_argument("--motivo", default="")
    ap.add_argument("--plan", help="trader/plan.json de /trader-exit (compra con su stop y objetivo)")
    ap.add_argument("--puente", default="http://127.0.0.1:8765")
    ap.add_argument("--token", default=None, help="por defecto, el de bridge/.token")
    a = ap.parse_args()

    body = {"analyst": a.analista, "name": a.nombre, "symbol": a.simbolo, "side": a.lado,
            "sl": a.sl, "tp": a.tp, "reason": a.motivo}
    if a.plan:
        with open(a.plan, encoding="utf-8") as f:
            plan = json.load(f)
        body.update(side="buy", sl=plan.get("stop"), tp=plan.get("target") or 0.0,
                    reason=a.motivo or "Plan de /trader-exit")
        body["symbol"] = a.simbolo or plan.get("symbol")
    path = "/api/signal"
    if a.votar:
        path = "/api/vote"
        body = {"analyst": a.analista, "name": a.nombre, "symbol": body["symbol"], "side": body["side"], "minutes": a.minutos}
    elif not body["symbol"] or not body["side"] or not body["sl"]:
        sys.exit("Faltan --simbolo, --lado o --sl (o --plan)")

    token = a.token
    if not token:
        try:
            with open(os.path.join(HERE, ".token")) as f:
                token = f.read().strip()
        except OSError:
            sys.exit("No encuentro bridge/.token: arranca antes el puente o pasa --token")

    req = urllib.request.Request(a.puente.rstrip("/") + path, data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "X-Token": token}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("Rechazada: %s" % e.read().decode("utf-8", "replace"))
    except urllib.error.URLError as e:
        sys.exit("No se puede conectar con el puente (%s): ¿está arrancado?" % e.reason)
    if a.votar:
        print("Voto %s en %s registrado%s" % (res.get("vote"), res.get("symbol"), "" if res.get("counts") else
              " (no cuenta hasta que conectes el analista en la app)"))
    else:
        print("%s · %s" % (res.get("status"), res.get("message")))


if __name__ == "__main__":
    main()
