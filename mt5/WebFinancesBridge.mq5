//+------------------------------------------------------------------+
//| WebFinancesBridge.mq5                                            |
//| Envía precios, cuenta y posiciones al puente local web-finances  |
//| (bridge/server.py) y ejecuta las órdenes que confirmes en la app.|
//|                                                                  |
//| Instalación:                                                     |
//|  1. Copia este archivo en MQL5/Experts (Archivo > Abrir carpeta  |
//|     de datos) y compílalo en MetaEditor (F7).                    |
//|  2. Herramientas > Opciones > Asesores Expertos: marca "Permitir |
//|     WebRequest para las URL listadas" y añade la URL del puente, |
//|     por ejemplo http://127.0.0.1:8765                            |
//|  3. Arrastra el EA a cualquier gráfico y pega el Token que       |
//|     muestra bridge/server.py al arrancar.                        |
//|                                                                  |
//| Seguridad: por defecto NO opera (AllowTrading=false) y nunca     |
//| opera en cuentas reales salvo que pongas AllowLiveAccount=true.  |
//| Cada orden exige stop loss y se rechaza si la pérdida en el stop |
//| supera MaxRiskPerTrade (divisa de la cuenta) o el volumen supera |
//| MaxVolume. El puente repite esas comprobaciones.                 |
//+------------------------------------------------------------------+
#property copyright "web-finances"
#property version   "1.00"
#property description "Puente en tiempo real con la app web-finances (precios, cuenta, posiciones y órdenes confirmadas)."

#include <Trade\Trade.mqh>

input string BridgeUrl        = "http://127.0.0.1:8765"; // URL del puente (añádela a WebRequest)
input string Token            = "";                      // Token que muestra bridge/server.py
input string Symbols          = "";                      // Símbolos separados por comas (vacío = Observación de Mercado)
input int    IntervalMs       = 250;                     // Cada cuántos ms se envían datos
input bool   AllowTrading     = false;                   // Permitir ejecutar órdenes desde la app
input bool   AllowLiveAccount = false;                   // Permitir operar en cuenta REAL
input double MaxRiskPerTrade  = 50.0;                    // Pérdida máxima en el stop por orden (divisa de la cuenta)
input double MaxVolume        = 1.0;                     // Lotes máximos por orden
input long   MagicNumber      = 770077;                  // Magic de las órdenes de la app
input int    MaxSymbols       = 40;                      // Máximo de símbolos de Observación de Mercado

CTrade   g_trade;
string   g_symbols[];
datetime g_lastWarn   = 0;
int      g_ticks      = 0;
bool     g_connected  = false;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(Token) < 8)
     {
      Alert("web-finances: falta el Token (cópialo de la consola de bridge/server.py)");
      return(INIT_PARAMETERS_INCORRECT);
     }
   g_trade.SetExpertMagicNumber((ulong)MagicNumber);
   g_trade.SetDeviationInPoints(20);
   LoadSymbols();
   EventSetMillisecondTimer(MathMax(IntervalMs, 100));
   Print("web-finances: enviando ", ArraySize(g_symbols), " símbolos a ", BridgeUrl,
         " · trading ", (AllowTrading ? "ACTIVADO" : "desactivado"),
         " · cuentas reales ", (AllowLiveAccount ? "PERMITIDAS" : "no"));
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
void OnTimer()
  {
   g_ticks++;
   if(StringLen(Symbols) == 0 && g_ticks % 40 == 0)
      LoadSymbols();                     // Observación de Mercado puede cambiar

   string resp;
   if(!Post("/mt5/push", BuildPayload(), resp))
      return;
   if(!g_connected)
     {
      g_connected = true;
      Print("web-finances: conectado con el puente");
     }
   string lines[];
   int n = StringSplit(resp, '\n', lines);
   for(int i = 0; i < n; i++)
     {
      string ln = lines[i];
      StringTrimLeft(ln);
      StringTrimRight(ln);
      if(ln == "" || ln == "OK")
         continue;
      HandleCommand(ln);
     }
  }

//+------------------------------------------------------------------+
void AddSymbol(const string s)
  {
   if(s == "")
      return;
   int n = ArraySize(g_symbols);
   for(int i = 0; i < n; i++)
      if(g_symbols[i] == s)
         return;
   ArrayResize(g_symbols, n + 1);
   g_symbols[n] = s;
  }

//+------------------------------------------------------------------+
void LoadSymbols()
  {
   ArrayResize(g_symbols, 0);
   if(StringLen(Symbols) > 0)
     {
      string parts[];
      int n = StringSplit(Symbols, ',', parts);
      for(int i = 0; i < n; i++)
        {
         string s = parts[i];
         StringTrimLeft(s);
         StringTrimRight(s);
         if(s == "")
            continue;
         if(SymbolSelect(s, true))
            AddSymbol(s);
         else
            Print("web-finances: el símbolo ", s, " no existe en este bróker");
        }
     }
   else
     {
      int total = SymbolsTotal(true);
      for(int i = 0; i < total && i < MaxSymbols; i++)
         AddSymbol(SymbolName(i, true));
     }
  }

//+------------------------------------------------------------------+
bool IsDemo()
  {
   return(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO);
  }

//+------------------------------------------------------------------+
bool TradingEnabled()
  {
   if(!AllowTrading)
      return(false);
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
      return(false);
   if(!IsDemo() && !AllowLiveAccount)
      return(false);
   return(true);
  }

//+------------------------------------------------------------------+
//| JSON mínimo                                                      |
//+------------------------------------------------------------------+
string JStr(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\t", " ");
   return("\"" + s + "\"");
  }

string JNum(const double v, const int digits)
  {
   if(!MathIsValidNumber(v))
      return("null");
   return(DoubleToString(v, digits));
  }

string JBool(const bool b)
  {
   return(b ? "true" : "false");
  }

//+------------------------------------------------------------------+
string BuildPayload()
  {
   string j = "{\"v\":1";

   j += ",\"ea\":{\"version\":\"1.0\",\"trading\":" + JBool(TradingEnabled()) +
        ",\"live_allowed\":" + JBool(AllowLiveAccount) +
        ",\"max_risk\":" + JNum(MaxRiskPerTrade, 2) +
        ",\"max_volume\":" + JNum(MaxVolume, 2) + "}";

   j += ",\"account\":{\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
        ",\"name\":" + JStr(AccountInfoString(ACCOUNT_NAME)) +
        ",\"server\":" + JStr(AccountInfoString(ACCOUNT_SERVER)) +
        ",\"company\":" + JStr(AccountInfoString(ACCOUNT_COMPANY)) +
        ",\"currency\":" + JStr(AccountInfoString(ACCOUNT_CURRENCY)) +
        ",\"balance\":" + JNum(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
        ",\"equity\":" + JNum(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
        ",\"profit\":" + JNum(AccountInfoDouble(ACCOUNT_PROFIT), 2) +
        ",\"margin\":" + JNum(AccountInfoDouble(ACCOUNT_MARGIN), 2) +
        ",\"free_margin\":" + JNum(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
        ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) +
        ",\"demo\":" + JBool(IsDemo()) + "}";

   // Precios
   j += ",\"symbols\":[";
   bool first = true;
   int n = ArraySize(g_symbols);
   for(int i = 0; i < n; i++)
     {
      string s = g_symbols[i];
      MqlTick t;
      if(!SymbolInfoTick(s, t))
         continue;
      int d = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
      double prev = iClose(s, PERIOD_D1, 1);
      if(!first)
         j += ",";
      first = false;
      j += "{\"s\":" + JStr(s) +
           ",\"bid\":" + JNum(t.bid, d) +
           ",\"ask\":" + JNum(t.ask, d) +
           ",\"last\":" + JNum(t.last, d) +
           ",\"t\":" + IntegerToString((long)t.time_msc) +
           ",\"d\":" + IntegerToString(d) +
           ",\"prev\":" + (prev > 0 ? JNum(prev, d) : "null") +
           ",\"tv\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE), 8) +
           ",\"ts\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) +
           ",\"vmin\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) +
           ",\"vmax\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_MAX), 4) +
           ",\"vstep\":" + JNum(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) +
           ",\"contract\":" + JNum(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 4) + "}";
     }
   j += "]";

   // Posiciones abiertas
   j += ",\"positions\":[";
   first = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0)
         continue;
      string ps = PositionGetString(POSITION_SYMBOL);
      int d = (int)SymbolInfoInteger(ps, SYMBOL_DIGITS);
      bool isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      if(!first)
         j += ",";
      first = false;
      j += "{\"ticket\":" + IntegerToString((long)tk) +
           ",\"s\":" + JStr(ps) +
           ",\"type\":" + (isBuy ? "\"buy\"" : "\"sell\"") +
           ",\"vol\":" + JNum(PositionGetDouble(POSITION_VOLUME), 4) +
           ",\"open\":" + JNum(PositionGetDouble(POSITION_PRICE_OPEN), d) +
           ",\"sl\":" + JNum(PositionGetDouble(POSITION_SL), d) +
           ",\"tp\":" + JNum(PositionGetDouble(POSITION_TP), d) +
           ",\"price\":" + JNum(PositionGetDouble(POSITION_PRICE_CURRENT), d) +
           ",\"profit\":" + JNum(PositionGetDouble(POSITION_PROFIT), 2) +
           ",\"swap\":" + JNum(PositionGetDouble(POSITION_SWAP), 2) +
           ",\"time\":" + IntegerToString((long)PositionGetInteger(POSITION_TIME)) +
           ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC)) +
           ",\"comment\":" + JStr(PositionGetString(POSITION_COMMENT)) + "}";
     }
   j += "]";

   // Órdenes pendientes
   j += ",\"orders\":[";
   first = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk == 0)
         continue;
      string os = OrderGetString(ORDER_SYMBOL);
      int d = (int)SymbolInfoInteger(os, SYMBOL_DIGITS);
      if(!first)
         j += ",";
      first = false;
      j += "{\"ticket\":" + IntegerToString((long)tk) +
           ",\"s\":" + JStr(os) +
           ",\"type\":" + IntegerToString(OrderGetInteger(ORDER_TYPE)) +
           ",\"vol\":" + JNum(OrderGetDouble(ORDER_VOLUME_CURRENT), 4) +
           ",\"price\":" + JNum(OrderGetDouble(ORDER_PRICE_OPEN), d) +
           ",\"sl\":" + JNum(OrderGetDouble(ORDER_SL), d) +
           ",\"tp\":" + JNum(OrderGetDouble(ORDER_TP), d) + "}";
     }
   j += "]}";
   return(j);
  }

//+------------------------------------------------------------------+
//| HTTP                                                             |
//+------------------------------------------------------------------+
bool Post(const string path, const string body, string &response)
  {
   char data[];
   char result[];
   string resultHeaders;
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(len > 0)
      ArrayResize(data, len - 1);        // sin el cero final
   string headers = "Content-Type: application/json\r\nX-Token: " + Token + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", BridgeUrl + path, headers, 3000, data, result, resultHeaders);
   if(code == -1)
     {
      int err = GetLastError();
      g_connected = false;
      if(TimeLocal() - g_lastWarn > 30)
        {
         g_lastWarn = TimeLocal();
         if(err == 4014)
            Print("web-finances: WebRequest no permitido. Añade ", BridgeUrl,
                  " en Herramientas > Opciones > Asesores Expertos > Permitir WebRequest.");
         else
            Print("web-finances: no se pudo conectar con el puente (error ", err,
                  "). ¿Está corriendo bridge/server.py?");
        }
      return(false);
     }
   response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   if(code != 200)
     {
      g_connected = false;
      if(TimeLocal() - g_lastWarn > 30)
        {
         g_lastWarn = TimeLocal();
         if(code == 401)
            Print("web-finances: el puente rechazó el Token (HTTP 401). Copia el de bridge/.token");
         else
            Print("web-finances: el puente respondió HTTP ", code, ": ", response);
        }
      return(false);
     }
   return(true);
  }

//+------------------------------------------------------------------+
void SendResult(const long id, const bool ok, const uint retcode, const string message, const ulong ticket)
  {
   string j = "{\"id\":" + IntegerToString(id) +
              ",\"ok\":" + JBool(ok) +
              ",\"retcode\":" + IntegerToString((long)retcode) +
              ",\"message\":" + JStr(message) +
              ",\"ticket\":" + IntegerToString((long)ticket) + "}";
   string resp;
   Post("/mt5/result", j, resp);
   Print("web-finances: comando #", id, (ok ? " OK: " : " RECHAZADO: "), message);
  }

//+------------------------------------------------------------------+
//| Comandos: ORDER / CLOSE / MODIFY / BARS (separados por ';')      |
//+------------------------------------------------------------------+
void HandleCommand(const string line)
  {
   string f[];
   int n = StringSplit(line, ';', f);
   if(n < 2)
      return;
   long id = StringToInteger(f[1]);

   if(f[0] == "BARS" && n >= 5)
     {
      SendBars(id, f[2], f[3], (int)StringToInteger(f[4]));
      return;
     }
   if(!TradingEnabled())
     {
      SendResult(id, false, 0, "Trading desactivado: activa AllowTrading y el botón Algo Trading (y AllowLiveAccount si la cuenta es real)", 0);
      return;
     }
   if(f[0] == "ORDER" && n >= 9)
      DoOrder(id, f[2], f[3], StringToDouble(f[4]), f[5], StringToDouble(f[6]), StringToDouble(f[7]), StringToDouble(f[8]));
   else
      if(f[0] == "CLOSE" && n >= 3)
         DoClose(id, (ulong)StringToInteger(f[2]));
      else
         if(f[0] == "MODIFY" && n >= 5)
            DoModify(id, (ulong)StringToInteger(f[2]), StringToDouble(f[3]), StringToDouble(f[4]));
         else
            SendResult(id, false, 0, "Comando desconocido: " + f[0], 0);
  }

//+------------------------------------------------------------------+
int VolumeDigits(const double step)
  {
   int d = 0;
   double s = step;
   while(d < 8 && MathAbs(s - MathRound(s)) > 1e-9)
     {
      s *= 10.0;
      d++;
     }
   return(d);
  }

//+------------------------------------------------------------------+
void DoOrder(const long id, const string sym, const string side, double vol, const string type,
             double price, double sl, double tp)
  {
   if(!SymbolSelect(sym, true))
     {
      SendResult(id, false, 0, "Símbolo no disponible: " + sym, 0);
      return;
     }
   bool isBuy = (side == "buy");
   if(side != "buy" && side != "sell")
     {
      SendResult(id, false, 0, "Lado inválido", 0);
      return;
     }
   if(type != "market" && type != "limit" && type != "stop")
     {
      SendResult(id, false, 0, "Tipo de orden inválido", 0);
      return;
     }
   if(sl <= 0.0)
     {
      SendResult(id, false, 0, "El stop loss es obligatorio", 0);
      return;
     }

   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step > 0.0)
      vol = MathFloor(vol / step + 1e-9) * step;
   vol = NormalizeDouble(vol, VolumeDigits(step));
   if(vol < vmin || vol > vmax || vol > MaxVolume)
     {
      SendResult(id, false, 0, StringFormat("Volumen %.2f fuera de límites (mín %.2f, máx %.2f)", vol, vmin, MathMin(vmax, MaxVolume)), 0);
      return;
     }

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   sl = NormalizeDouble(sl, digits);
   tp = (tp > 0.0 ? NormalizeDouble(tp, digits) : 0.0);
   price = NormalizeDouble(price, digits);

   MqlTick t;
   if(!SymbolInfoTick(sym, t))
     {
      SendResult(id, false, 0, "Sin precio para " + sym, 0);
      return;
     }
   double entry = (type == "market") ? (isBuy ? t.ask : t.bid) : price;
   if(entry <= 0.0)
     {
      SendResult(id, false, 0, "Precio de entrada inválido", 0);
      return;
     }
   if((isBuy && sl >= entry) || (!isBuy && sl <= entry))
     {
      SendResult(id, false, 0, "El stop está en el lado equivocado de la entrada", 0);
      return;
     }

   double pl = 0.0;
   if(!OrderCalcProfit(isBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, sym, vol, entry, sl, pl))
     {
      SendResult(id, false, 0, "No se pudo calcular la pérdida en el stop", 0);
      return;
     }
   double risk = -pl;
   if(risk > MaxRiskPerTrade + 1e-9)
     {
      SendResult(id, false, 0, StringFormat("Pérdida en el stop %.2f supera el máximo %.2f", risk, MaxRiskPerTrade), 0);
      return;
     }

   g_trade.SetTypeFillingBySymbol(sym);
   string cmt = "web-finances #" + IntegerToString(id);
   bool ok = false;
   if(type == "market")
      ok = isBuy ? g_trade.Buy(vol, sym, 0.0, sl, tp, cmt) : g_trade.Sell(vol, sym, 0.0, sl, tp, cmt);
   else
      if(type == "limit")
         ok = isBuy ? g_trade.BuyLimit(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt)
              : g_trade.SellLimit(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt);
      else
         ok = isBuy ? g_trade.BuyStop(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt)
              : g_trade.SellStop(vol, price, sym, sl, tp, ORDER_TIME_GTC, 0, cmt);

   uint rc = g_trade.ResultRetcode();
   bool done = ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
   ulong ticket = g_trade.ResultOrder();
   if(ticket == 0)
      ticket = g_trade.ResultDeal();
   SendResult(id, done, rc, g_trade.ResultRetcodeDescription() + StringFormat(" (riesgo %.2f)", risk), ticket);
  }

//+------------------------------------------------------------------+
void DoClose(const long id, const ulong ticket)
  {
   if(!PositionSelectByTicket(ticket))
     {
      SendResult(id, false, 0, "Posición no encontrada", ticket);
      return;
     }
   g_trade.SetTypeFillingBySymbol(PositionGetString(POSITION_SYMBOL));
   bool ok = g_trade.PositionClose(ticket);
   uint rc = g_trade.ResultRetcode();
   SendResult(id, ok && rc == TRADE_RETCODE_DONE, rc, g_trade.ResultRetcodeDescription(), ticket);
  }

//+------------------------------------------------------------------+
void DoModify(const long id, const ulong ticket, const double sl, const double tp)
  {
   if(sl <= 0.0)
     {
      SendResult(id, false, 0, "No se puede quitar el stop loss", ticket);
      return;
     }
   if(!PositionSelectByTicket(ticket))
     {
      SendResult(id, false, 0, "Posición no encontrada", ticket);
      return;
     }
   int d = (int)SymbolInfoInteger(PositionGetString(POSITION_SYMBOL), SYMBOL_DIGITS);
   bool ok = g_trade.PositionModify(ticket, NormalizeDouble(sl, d), (tp > 0.0 ? NormalizeDouble(tp, d) : 0.0));
   uint rc = g_trade.ResultRetcode();
   SendResult(id, ok && rc == TRADE_RETCODE_DONE, rc, g_trade.ResultRetcodeDescription(), ticket);
  }

//+------------------------------------------------------------------+
void SendBars(const long id, const string sym, const string tf, const int count)
  {
   ENUM_TIMEFRAMES p = PERIOD_M1;
   if(tf == "M5")
      p = PERIOD_M5;
   else
      if(tf == "M15")
         p = PERIOD_M15;
      else
         if(tf == "H1")
            p = PERIOD_H1;
         else
            if(tf == "D1")
               p = PERIOD_D1;

   SymbolSelect(sym, true);
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(sym, p, 0, MathMin(MathMax(count, 10), 1000), r);
   int d = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string j = "{\"id\":" + IntegerToString(id) + ",\"symbol\":" + JStr(sym) + ",\"tf\":" + JStr(tf) + ",\"bars\":[";
   for(int i = 0; i < n; i++)
     {
      if(i > 0)
         j += ",";
      j += "[" + IntegerToString((long)r[i].time) + "," + DoubleToString(r[i].open, d) + "," +
           DoubleToString(r[i].high, d) + "," + DoubleToString(r[i].low, d) + "," +
           DoubleToString(r[i].close, d) + "," + IntegerToString(r[i].tick_volume) + "]";
     }
   j += "]}";
   string resp;
   Post("/mt5/bars", j, resp);
  }
//+------------------------------------------------------------------+
