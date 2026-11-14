"""
Comité de analistas (votación)
==============================

Cada analista del comité mira las velas CERRADAS de un símbolo en tiempo real y vota:

    +1 compra · -1 venta · 0 neutral · None (no tiene datos suficientes: no vota)

El comité cuenta los votos emitidos (compra + venta; los neutrales no cuentan) y, si un lado
reúne el porcentaje mínimo (75 % por defecto) con un quórum mínimo de votos, da la señal: el
stop loss se pone a N × ATR de la entrada y el take profit a R veces esa distancia.

Las familias (tendencia, momento, ruptura, reversión, patrones) resumen los métodos de las
skills instaladas en .claude/skills (medias y Minervini/O'Neil, MACD, RSI, Donchian/turtle,
Bollinger, Ichimoku, ADX, Supertrend, SAR, etc.), en versión que puede votar cada vela.
Los analistas externos (Claude con las skills, tus scripts) votan con POST /api/vote.

Solo biblioteca estándar.
"""

from analysts import Analyst, atr, ema, rsi


# --------------------------------------------------------------------------------------------
# Indicadores (series alineadas con las velas; None donde aún no hay datos)
# --------------------------------------------------------------------------------------------
def sma(values, n):
    if len(values) < n:
        return [None] * len(values)
    out = [None] * (n - 1)
    s = sum(values[:n])
    out.append(s / n)
    for i in range(n, len(values)):
        s += values[i] - values[i - n]
        out.append(s / n)
    return out


def atr_series(bars, n=14):
    out = [None] * len(bars)
    if len(bars) <= n:
        return out
    trs = [bars[0][2] - bars[0][3]]
    for i in range(1, len(bars)):
        h, l, pc = bars[i][2], bars[i][3], bars[i - 1][4]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    a = sum(trs[1:n + 1]) / n
    out[n] = a
    for i in range(n + 1, len(bars)):
        a = (a * (n - 1) + trs[i]) / n
        out[i] = a
    return out


def macd(closes, f=12, s=26, sig=9):
    ef, es = ema(closes, f), ema(closes, s)
    if not es:
        return None, None
    line = [a - b for a, b in zip(ef, es) if a is not None and b is not None]
    signal = ema(line, sig)
    if len(signal) < 2 or signal[-1] is None or signal[-2] is None:
        return None, None
    return line, signal


def adx(bars, n=14):
    if len(bars) < 2 * n + 2:
        return None, None, None
    tr, pdm, mdm = [], [], []
    for i in range(1, len(bars)):
        h, l, ph, pl, pc = bars[i][2], bars[i][3], bars[i - 1][2], bars[i - 1][3], bars[i - 1][4]
        up, dn = h - ph, pl - l
        pdm.append(up if up > dn and up > 0 else 0.0)
        mdm.append(dn if dn > up and dn > 0 else 0.0)
        tr.append(max(h - l, abs(h - pc), abs(l - pc)))
    st, sp, sm = sum(tr[:n]), sum(pdm[:n]), sum(mdm[:n])
    dxs = []
    pdi = mdi = 0.0
    for i in range(n, len(tr)):
        st = st - st / n + tr[i]
        sp = sp - sp / n + pdm[i]
        sm = sm - sm / n + mdm[i]
        if st <= 0:
            continue
        pdi, mdi = 100 * sp / st, 100 * sm / st
        dxs.append(100 * abs(pdi - mdi) / (pdi + mdi) if pdi + mdi else 0.0)
    if len(dxs) < n:
        return None, None, None
    a = sum(dxs[:n]) / n
    for d in dxs[n:]:
        a = (a * (n - 1) + d) / n
    return a, pdi, mdi


def supertrend_dir(bars, n=10, mult=3.0):
    atrs = atr_series(bars, n)
    trend, fu, fl = 1, None, None
    for i in range(len(bars)):
        a = atrs[i]
        if a is None:
            continue
        h, l, c = bars[i][2], bars[i][3], bars[i][4]
        hl2 = (h + l) / 2
        bu, bl = hl2 + mult * a, hl2 - mult * a
        pc = bars[i - 1][4]
        fu = bu if fu is None or bu < fu or pc > fu else fu
        fl = bl if fl is None or bl > fl or pc < fl else fl
        if trend == 1 and c < fl:
            trend = -1
        elif trend == -1 and c > fu:
            trend = 1
    return trend if fu is not None else None


def psar_dir(bars, step=0.02, top=0.2):
    if len(bars) < 10:
        return None
    up = bars[1][4] >= bars[0][4]
    sar = bars[0][3] if up else bars[0][2]
    ep = bars[1][2] if up else bars[1][3]
    af = step
    for i in range(2, len(bars)):
        h, l = bars[i][2], bars[i][3]
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, bars[i - 1][3], bars[i - 2][3])
            if l < sar:
                up, sar, ep, af = False, ep, l, step
            elif h > ep:
                ep, af = h, min(af + step, top)
        else:
            sar = max(sar, bars[i - 1][2], bars[i - 2][2])
            if h > sar:
                up, sar, ep, af = True, ep, h, step
            elif l < ep:
                ep, af = l, min(af + step, top)
    return 1 if up else -1


def stoch(bars, n=14, d=3):
    ks = []
    for i in range(len(bars) - n - d + 1, len(bars)):
        win = bars[i - n + 1:i + 1]
        if i - n + 1 < 0:
            return None, None
        hh, ll = max(b[2] for b in win), min(b[3] for b in win)
        ks.append(50.0 if hh == ll else 100 * (bars[i][4] - ll) / (hh - ll))
    if len(ks) < d:
        return None, None
    return ks[-1], sum(ks[-d:]) / d


def sgn(x, dead=0.0):
    return 1 if x > dead else -1 if x < -dead else 0


# --------------------------------------------------------------------------------------------
# Votantes: (id, nombre, familia, mínimo de velas, función(velas) -> +1/-1/0)
# --------------------------------------------------------------------------------------------
def _c(b):
    return [x[4] for x in b]


def v_ema_20_50(b):
    c = _c(b)
    e20, e50 = ema(c, 20)[-1], ema(c, 50)[-1]
    return 1 if c[-1] > e20 > e50 else -1 if c[-1] < e20 < e50 else 0


def v_cruce_9_21(b):
    c = _c(b)
    return sgn(ema(c, 9)[-1] - ema(c, 21)[-1])


def v_sma200(b):
    c = _c(b)
    return sgn(c[-1] - sma(c, 200)[-1])


def v_pendiente50(b):
    e = ema(_c(b), 50)
    return sgn(e[-1] - e[-6])


def v_supertrend(b):
    return supertrend_dir(b)


def v_psar(b):
    return psar_dir(b)


def v_ichimoku(b):
    def mid(n):
        w = b[-n:]
        return (max(x[2] for x in w) + min(x[3] for x in w)) / 2
    c, tk, kj = b[-1][4], mid(9), mid(26)
    return 1 if c > tk > kj else -1 if c < tk < kj else 0


def v_adx(b):
    a, p, m = adx(b)
    if a is None:
        return None
    return 0 if a < 20 else sgn(p - m)


def v_aroon(b):
    n = 25
    w = b[-n - 1:]
    hi = max(range(len(w)), key=lambda i: w[i][2])
    lo = min(range(len(w)), key=lambda i: w[i][3])
    up, dn = 100 * hi / n, 100 * lo / n          # 100 = máximo/mínimo en la última vela
    return 1 if up >= 70 and dn <= 30 else -1 if dn >= 70 and up <= 30 else 0


def v_heikin(b):
    ho, hc = (b[-50][1] + b[-50][4]) / 2, None
    cols = []
    for x in b[-50:]:
        hc_new = (x[1] + x[2] + x[3] + x[4]) / 4
        if hc is not None:
            ho = (ho + hc) / 2
        hc = hc_new
        cols.append(sgn(hc - ho))
    return cols[-1] if cols[-1] == cols[-2] else 0


def v_macd(b):
    line, sig = macd(_c(b))
    return None if line is None else sgn(line[-1] - sig[-1])


def v_macd_hist(b):
    line, sig = macd(_c(b))
    if line is None:
        return None
    h1, h0 = line[-1] - sig[-1], line[-2] - sig[-2]
    return 1 if h1 > 0 and h1 > h0 else -1 if h1 < 0 and h1 < h0 else 0


def v_rsi_momento(b):
    r = rsi(_c(b))[-1]
    return 1 if r > 55 else -1 if r < 45 else 0


def v_roc(b):
    c = _c(b)
    return sgn(c[-1] - c[-11])


def v_cci(b):
    tp = [(x[2] + x[3] + x[4]) / 3 for x in b[-20:]]
    m = sum(tp) / 20
    md = sum(abs(t - m) for t in tp) / 20
    if not md:
        return 0
    cci = (tp[-1] - m) / (0.015 * md)
    return 1 if cci > 100 else -1 if cci < -100 else 0


def v_tres_velas(b):
    w = b[-3:]
    if all(x[4] > x[1] for x in w) and w[0][4] < w[1][4] < w[2][4]:
        return 1
    if all(x[4] < x[1] for x in w) and w[0][4] > w[1][4] > w[2][4]:
        return -1
    return 0


def v_donchian20(b):
    prev = b[-21:-1]
    c = b[-1][4]
    return 1 if c > max(x[2] for x in prev) else -1 if c < min(x[3] for x in prev) else 0


def v_donchian55(b):
    w = b[-55:]
    hi, lo = max(x[2] for x in w), min(x[3] for x in w)
    return sgn(b[-1][4] - (hi + lo) / 2)


def v_keltner(b):
    c = _c(b)
    e, a = ema(c, 20)[-1], atr(b)
    if not a:
        return None
    return 1 if c[-1] > e + 1.5 * a else -1 if c[-1] < e - 1.5 * a else 0


def v_bollinger(b):
    c = _c(b)[-20:]
    m = sum(c) / 20
    sd = (sum((x - m) ** 2 for x in c) / 20) ** 0.5
    return 1 if c[-1] < m - 2 * sd else -1 if c[-1] > m + 2 * sd else 0


def v_rsi_extremos(b):
    r = rsi(_c(b))[-1]
    return 1 if r < 30 else -1 if r > 70 else 0


def v_estocastico(b):
    k, d = stoch(b)
    if k is None:
        return None
    return 1 if k < 25 and k > d else -1 if k > 75 and k < d else 0


def v_williams(b):
    w = b[-14:]
    hh, ll = max(x[2] for x in w), min(x[3] for x in w)
    if hh == ll:
        return 0
    r = -100 * (hh - b[-1][4]) / (hh - ll)
    return 1 if r < -80 else -1 if r > -20 else 0


def v_envolvente(b):
    p, x = b[-2], b[-1]
    if p[4] < p[1] and x[4] > x[1] and x[4] >= p[1] and x[1] <= p[4]:
        return 1
    if p[4] > p[1] and x[4] < x[1] and x[4] <= p[1] and x[1] >= p[4]:
        return -1
    return 0


VOTERS = [
    ("ema_20_50", "Tendencia EMA 20/50", "Tendencia", 55, v_ema_20_50),
    ("cruce_9_21", "Cruce EMA 9/21", "Tendencia", 25, v_cruce_9_21),
    ("sma200", "Precio vs media 200", "Tendencia", 200, v_sma200),
    ("pendiente50", "Pendiente EMA 50", "Tendencia", 60, v_pendiente50),
    ("supertrend", "Supertrend 10/3", "Tendencia", 20, v_supertrend),
    ("psar", "SAR parabólico", "Tendencia", 20, v_psar),
    ("ichimoku", "Ichimoku (Tenkan/Kijun)", "Tendencia", 30, v_ichimoku),
    ("adx", "ADX / DMI", "Tendencia", 32, v_adx),
    ("aroon", "Aroon 25", "Tendencia", 27, v_aroon),
    ("heikin", "Heikin-Ashi", "Tendencia", 52, v_heikin),
    ("macd", "MACD vs señal", "Momento", 40, v_macd),
    ("macd_hist", "Histograma MACD", "Momento", 40, v_macd_hist),
    ("rsi_momento", "RSI momento (55/45)", "Momento", 20, v_rsi_momento),
    ("roc", "ROC 10", "Momento", 12, v_roc),
    ("cci", "CCI 20", "Momento", 20, v_cci),
    ("tres_velas", "Tres velas seguidas", "Momento", 3, v_tres_velas),
    ("donchian20", "Ruptura Donchian 20", "Ruptura", 22, v_donchian20),
    ("donchian55", "Canal Donchian 55", "Ruptura", 55, v_donchian55),
    ("keltner", "Canal de Keltner", "Ruptura", 25, v_keltner),
    ("bollinger", "Bandas de Bollinger", "Reversión", 20, v_bollinger),
    ("rsi_extremos", "RSI extremos (30/70)", "Reversión", 20, v_rsi_extremos),
    ("estocastico", "Estocástico 14/3", "Reversión", 20, v_estocastico),
    ("williams", "Williams %R", "Reversión", 14, v_williams),
    ("envolvente", "Vela envolvente", "Patrones", 2, v_envolvente),
]
VOTER_IDS = {v[0] for v in VOTERS}


class Committee(Analyst):
    id = "comite"
    name = "Comité de analistas (votación)"
    description = ("%d analistas votan en cada vela cerrada. Si al menos el umbral de los votos va al mismo lado "
                   "(y hay quórum), se crea stop loss y take profit y se opera." % len(VOTERS))
    params = [("umbral", "Votos a favor (%)", 50, 100, 75), ("quorum", "Quórum (votos mínimos)", 1, 40, 8),
              ("atr_mult", "Stop (× ATR)", 0.5, 5, 1.5), ("rr", "Take profit (R)", 0.5, 5, 2)]

    def needs(self, p):
        return 60          # los que necesitan más (media 200) se abstienen hasta tener datos

    def tally(self, bars, p, off=(), external=None):
        """Cuenta los votos. Devuelve el desglose (para la app) y la decisión."""
        votes = {}
        for vid, _, _, need, fn in VOTERS:
            if vid in off:
                continue
            if len(bars) < need:
                votes[vid] = None
                continue
            try:
                v = fn(bars)
            except (ValueError, ZeroDivisionError, IndexError, TypeError):
                v = None
            votes[vid] = v
        for aid, v in (external or {}).items():
            votes["ext:" + aid] = v
        buy = sum(1 for v in votes.values() if v == 1)
        sell = sum(1 for v in votes.values() if v == -1)
        neutral = sum(1 for v in votes.values() if v == 0)
        cast = buy + sell
        pb = 100.0 * buy / cast if cast else 0.0
        ps = 100.0 * sell / cast if cast else 0.0
        side = None
        if cast >= p["quorum"]:
            if pb >= p["umbral"]:
                side = "buy"
            elif ps >= p["umbral"]:
                side = "sell"
        return {"buy": buy, "sell": sell, "neutral": neutral, "abstain": sum(1 for v in votes.values() if v is None),
                "pct_buy": round(pb, 1), "pct_sell": round(ps, 1), "side": side, "votes": votes}

    def evaluate(self, bars, p):
        r = self.tally(bars, p)
        if not r["side"]:
            return None
        a = atr(bars)
        if not a:
            return None
        sl, tp = self.levels(r["side"], bars[-1][4], a * p["atr_mult"], p["rr"])
        return r["side"], sl, tp, "Comité: %.0f %% a favor (%d de %d votos)" % (
            r["pct_buy"] if r["side"] == "buy" else r["pct_sell"], max(r["buy"], r["sell"]), r["buy"] + r["sell"])
