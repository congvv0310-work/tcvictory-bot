// api/backtest.js — Chạy lại chỉ báo qua lịch sử, thống kê + phát lại tín hiệu
//
// Thống kê:
//   /api/backtest?key=BI_MAT&tf=1h
//   /api/backtest?key=BI_MAT&tf=15min&only=cardwell&trades=1
//
// Phát lại tín hiệu thật lên Telegram (để kiểm thử):
//   /api/backtest?key=BI_MAT&tf=1h&send=3
//   /api/backtest?key=BI_MAT&tf=1h&only=cardwell&send=1
//
// Tham số:
//   tf     5min | 15min | 30min | 1h | 4h | 1day   (mặc định 1h)
//   only   cardwell | fan | elliott                (bỏ trống = cả ba)
//   bars   số nến, tối đa 5000
//   hold   giữ tối đa bao nhiêu nến                (mặc định 100)
//   trades =1 để xem danh sách lệnh
//   send   =N gửi N tín hiệu gần nhất lên Telegram

const TD_API_KEY = process.env.TD_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;

const ENTRY_BAND_ATR = 0.1;
const PRICE_DECIMALS = 0;

const CARDWELL = {
  rsiLen: 14, trendLen: 50,
  bullLo: 40, bullHi: 80, bearLo: 20, bearHi: 60,
  confirmBars: 2,
  useAdx: false, adxLen: 14, adxMin: 20,
  atrLen: 14, slMult: 1.5, tp1Mult: 1.0, tp2Mult: 2.0,
};

const FAN = {
  pivLen: 5, maxFanBars: 300, minLegPct: 0.1,
  atrLen: 14, slBufAtr: 0.1, slMaxAtr: 3.0,
  tp1R: 1.0, tp2R: 2.0, maxPivots: 20,
};

const ELLIOTT = {
  pivLeft: 5, pivRight: 5, maxPiv: 500,
  cooldown: 5, maxPatterns: 3,
  fibTol: 0.10, minSizeAtr: 0.8,
  reqW3Ext: true, reqW4NoOverlap: true, reqW3NotShortest: true,
  stopAtrBuf: 0.5, minRr: 1.5,
};

// ── HÀM CHỈ BÁO CƠ BẢN ─────────────────────────────────────────
function rma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i] ?? 0;
    if (i < len - 1) sum += v;
    else if (i === len - 1) { sum += v; out[i] = sum / len; }
    else out[i] = (out[i - 1] * (len - 1) + v) / len;
  }
  return out;
}

function sma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += src[i];
    if (i >= len) sum -= src[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function rsi(closes, len) {
  const gains = [0], losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(ch > 0 ? ch : 0);
    losses.push(ch < 0 ? -ch : 0);
  }
  const ag = rma(gains, len), al = rma(losses, len);
  return closes.map((_, i) => {
    if (ag[i] == null || al[i] == null) return null;
    if (al[i] === 0) return 100;
    if (ag[i] === 0) return 0;
    return 100 - 100 / (1 + ag[i] / al[i]);
  });
}

function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

function atr(bars, len) { return rma(trueRange(bars), len); }

function adx(bars, len) {
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const trur = rma(trueRange(bars), len);
  const smP = rma(plusDM, len), smM = rma(minusDM, len);
  const dx = bars.map((_, i) => {
    if (trur[i] == null || trur[i] === 0) return 0;
    const plus = (100 * smP[i]) / trur[i];
    const minus = (100 * smM[i]) / trur[i];
    const s = plus + minus;
    return (Math.abs(plus - minus) / (s === 0 ? 1 : s)) * 100;
  });
  return rma(dx, len);
}

// ── QUÉT TÍN HIỆU: CARDWELL ────────────────────────────────────
function scanCardwell(bars) {
  const C = CARDWELL;
  const closes = bars.map((b) => b.close);
  const rsiArr = rsi(closes, C.rsiLen);
  const maArr = sma(closes, C.trendLen);
  const atrArr = atr(bars, C.atrLen);
  const adxArr = adx(bars, C.adxLen);

  const out = [];
  let bullCount = 0, bearCount = 0, prevRegime = 0;

  for (let i = 0; i < bars.length; i++) {
    if (rsiArr[i] == null || maArr[i] == null) { bullCount = 0; bearCount = 0; continue; }
    const bullRaw = closes[i] > maArr[i] && rsiArr[i] >= C.bullLo && rsiArr[i] <= C.bullHi;
    const bearRaw = closes[i] < maArr[i] && rsiArr[i] >= C.bearLo && rsiArr[i] <= C.bearHi;
    bullCount = bullRaw ? bullCount + 1 : 0;
    bearCount = bearRaw ? bearCount + 1 : 0;
    const state =
      bullRaw && bullCount >= C.confirmBars ? 1
      : bearRaw && bearCount >= C.confirmBars ? -1 : 0;

    const chopOk = !C.useAdx || (adxArr[i] != null && adxArr[i] >= C.adxMin);
    const isLong = state === 1 && prevRegime !== 1 && chopOk;
    const isShort = state === -1 && prevRegime !== -1 && chopOk;
    prevRegime = state;

    if ((isLong || isShort) && i >= 1 && atrArr[i] != null) {
      const entry = closes[i - 1];
      const a = atrArr[i];
      const d = isLong ? 1 : -1;
      const vung = isLong
        ? `vùng tăng (${C.bullLo}–${C.bullHi})`
        : `vùng giảm (${C.bearLo}–${C.bearHi})`;
      out.push({
        i, dir: isLong ? "long" : "short", time: bars[i].datetime,
        entry, sl: entry - d * a * C.slMult,
        tp1: entry + d * a * C.tp1Mult, tp2: entry + d * a * C.tp2Mult,
        atrNow: a,
        reason: `RSI ${rsiArr[i].toFixed(1)} nằm trong ${vung}, giá nằm ${isLong ? "trên" : "dưới"} SMA50.`,
      });
    }
  }
  return out;
}

// ── QUÉT TÍN HIỆU: FAN PRINCIPLE ───────────────────────────────
function scanFan(bars) {
  const F = FAN;
  const closes = bars.map((b) => b.close);
  const atrArr = atr(bars, F.atrLen);
  const L = F.pivLen;
  const out = [];

  const loBar = [], loVal = [], hiBar = [], hiVal = [];
  let originBar = null, originVal = null, fanDir = 0;
  let fL2Val = null, fL3Bar = null, fL3Val = null, fanM3 = null;
  const slope = (x1, y1, x2, y2) => (x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0);

  for (let i = 0; i < bars.length; i++) {
    if (i >= 2 * L) {
      const j = i - L;
      let isHigh = true, isLow = true;
      const cH = bars[j].high, cL = bars[j].low;
      for (let k = i - 2 * L; k <= i; k++) {
        if (k === j) continue;
        if (bars[k].high >= cH) isHigh = false;
        if (bars[k].low <= cL) isLow = false;
      }
      if (isLow) { loBar.push(j); loVal.push(cL); if (loBar.length > F.maxPivots) { loBar.shift(); loVal.shift(); } }
      if (isHigh) { hiBar.push(j); hiVal.push(cH); if (hiBar.length > F.maxPivots) { hiBar.shift(); hiVal.shift(); } }
    }

    if (loBar.length >= 4) {
      const m = loBar.length;
      const oB = loBar[m - 4], oV = loVal[m - 4];
      const b1 = loBar[m - 3], v1 = loVal[m - 3];
      const b2 = loBar[m - 2], v2 = loVal[m - 2];
      const b3 = loBar[m - 1], v3 = loVal[m - 1];
      if (i - oB <= F.maxFanBars && oV !== 0 && (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct &&
          b1 > oB && b2 > b1 && b3 > b2 && (fanDir !== -1 || b3 > fL3Bar)) {
        originBar = oB; originVal = oV; fanDir = 1;
        fL2Val = v2; fL3Bar = b3; fL3Val = v3; fanM3 = slope(oB, oV, b3, v3);
      }
    }
    if (hiBar.length >= 4) {
      const m = hiBar.length;
      const oB = hiBar[m - 4], oV = hiVal[m - 4];
      const b1 = hiBar[m - 3], v1 = hiVal[m - 3];
      const b2 = hiBar[m - 2], v2 = hiVal[m - 2];
      const b3 = hiBar[m - 1], v3 = hiVal[m - 1];
      if (i - oB <= F.maxFanBars && oV !== 0 && (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct &&
          b1 > oB && b2 > b1 && b3 > b2 && (fanDir !== 1 || b3 > fL3Bar)) {
        originBar = oB; originVal = oV; fanDir = -1;
        fL2Val = v2; fL3Bar = b3; fL3Val = v3; fanM3 = slope(oB, oV, b3, v3);
      }
    }

    if (fanM3 == null || fanDir === 0 || i < 3) continue;
    const lineAt = (x) => originVal + fanM3 * (x - originBar);
    const fPrev = lineAt(i - 1), fPrev2 = lineAt(i - 2);
    const bull = fanDir === 1 && closes[i - 1] > fPrev && closes[i - 2] <= fPrev2;
    const bear = fanDir === -1 && closes[i - 1] < fPrev && closes[i - 2] >= fPrev2;
    if (!bull && !bear) continue;

    const aPrev = atrArr[i - 1];
    if (aPrev == null || atrArr[i] == null) continue;
    const entry = closes[i - 1];
    let risk;
    if (bull) {
      const chan = Math.min(fL2Val, fL3Val);
      risk = entry - Math.max(chan - aPrev * F.slBufAtr, entry - aPrev * F.slMaxAtr);
    } else {
      const chan = Math.max(fL2Val, fL3Val);
      risk = Math.min(chan + aPrev * F.slBufAtr, entry + aPrev * F.slMaxAtr) - entry;
    }
    if (!(risk > 0)) continue;
    const d = bull ? 1 : -1;
    out.push({
      i, dir: bull ? "long" : "short", time: bars[i].datetime,
      entry, sl: entry - d * risk,
      tp1: entry + d * risk * F.tp1R, tp2: entry + d * risk * F.tp2R,
      atrNow: atrArr[i],
      reason: `Giá phá ${bull ? "lên" : "xuống"} đường quạt số 3 (mức ${fPrev.toFixed(PRICE_DECIMALS)}), quạt dựng từ ${bull ? "4 đáy" : "4 đỉnh"} liên tiếp.`,
    });
  }
  return out;
}

// ── QUÉT TÍN HIỆU: ELLIOTT WAVE ────────────────────────────────
function scanElliott(bars) {
  const E = ELLIOTT;
  const atrArr = atr(bars, 14);
  const LL = E.pivLeft, RL = E.pivRight;
  const highs = [], lows = [], out = [];
  let frozenIdx = null, patHistory = [];

  const inRange = (r, lo, hi, tol) =>
    r != null && !Number.isNaN(r) && r >= lo * (1 - tol) && r <= hi * (1 + tol);
  const overlapsImpulse = (s, e) =>
    patHistory.some((d) => d.type === 1 && d.start <= e && d.end >= s);

  function impulse(a, isBull) {
    if (highs.length < 3 || lows.length < 3) return null;
    const A = isBull ? lows : highs, B = isBull ? highs : lows;
    const p0 = A[2], p1 = B[2], p2 = A[1], p3 = B[1], p4 = A[0], p5 = B[0];
    if (!(p0.i < p1.i && p1.i < p2.i && p2.i < p3.i && p3.i < p4.i && p4.i < p5.i)) return null;
    const s = isBull ? 1 : -1;
    if (!(s * (p1.p - p0.p) > 0 && s * (p2.p - p0.p) > 0 && s * (p3.p - p1.p) > 0)) return null;

    const w1 = s * (p1.p - p0.p);
    const w3 = s * (p3.p - p2.p);
    const w5 = s * (p5.p - p4.p);
    const w2ret = w1 > 0 ? (s * (p1.p - p2.p)) / w1 : null;
    const w4ret = w3 > 0 ? (s * (p3.p - p4.p)) / w3 : null;

    if (E.reqW4NoOverlap && !(s * (p4.p - p1.p) > 0)) return null;
    if (E.reqW3NotShortest && !(w3 >= w1 && w3 >= w5)) return null;
    if (E.reqW3Ext && !(w3 > w1)) return null;
    if (!inRange(w2ret, 0.382, 0.786, E.fibTol)) return null;
    if (!inRange(w4ret, 0.236, 0.500, E.fibTol)) return null;
    const ms = a * E.minSizeAtr;
    if (!(w1 > ms && w3 > ms && w5 > ms)) return null;

    const entry = p5.p;
    const stop = p4.p - s * a * E.stopAtrBuf;
    const tp1 = p5.p + s * w3 * 0.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(tp1 - entry) / risk >= E.minRr)) return null;

    return {
      type: 1, dir: isBull ? "long" : "short",
      ten: isBull ? "Sóng đẩy tăng (1-2-3-4-5)" : "Sóng đẩy giảm (1-2-3-4-5)",
      entry, sl: stop, tp1, tp2: p5.p + s * w3 * 1.0,
      start: p0.i, end: p5.i,
    };
  }

  function correction(a, isBull) {
    if (highs.length < 2 || lows.length < 2) return null;
    const s = isBull ? 1 : -1;
    const wa = isBull ? lows[1] : highs[1];
    const wb = isBull ? highs[1] : lows[1];
    const wc = isBull ? lows[0] : highs[0];
    if (!(wa.i < wb.i && wb.i < wc.i)) return null;

    const aLen = s * (wb.p - wa.p);
    const cMove = s * (wb.p - wc.p);
    const cExt = aLen > 1e-10 ? cMove / aLen : null;
    const ms = a * E.minSizeAtr;
    if (!(aLen > ms && cMove > ms)) return null;
    if (!inRange(cExt, 0.618, 1.618, E.fibTol)) return null;
    if (!(s * (wc.p - wa.p) <= 0)) return null;

    const entry = wc.p;
    const stop = wc.p - s * a * E.stopAtrBuf;
    const tp1 = wc.p + s * aLen * 1.0;
    const tp2 = wc.p + s * aLen * 1.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(tp2 - entry) / risk >= E.minRr)) return null;

    return {
      type: 2, dir: isBull ? "long" : "short",
      ten: isBull ? "Sóng điều chỉnh ABC tăng" : "Sóng điều chỉnh ABC giảm",
      entry, sl: stop, tp1, tp2, start: wa.i, end: wc.i,
    };
  }

  for (let i = 0; i < bars.length; i++) {
    if (i >= LL + RL) {
      const j = i - RL;
      let isHigh = true, isLow = true;
      const cH = bars[j].high, cL = bars[j].low;
      for (let k = i - (LL + RL); k <= i - 1; k++) {
        if (k === j) continue;
        if (bars[k].high >= cH) isHigh = false;
        if (bars[k].low <= cL) isLow = false;
      }
      if (isHigh) { highs.unshift({ p: cH, i: j }); if (highs.length > E.maxPiv) highs.pop(); }
      if (isLow) { lows.unshift({ p: cL, i: j }); if (lows.length > E.maxPiv) lows.pop(); }
    }

    if (i <= (LL + RL) * 2) continue;
    const a = atrArr[i];
    if (a == null) continue;

    let res = impulse(a, true) || impulse(a, false);
    if (!res) {
      const cb = correction(a, true);
      if (cb && !overlapsImpulse(cb.start, cb.end)) res = cb;
      else {
        const cbe = correction(a, false);
        if (cbe && !overlapsImpulse(cbe.start, cbe.end)) res = cbe;
      }
    }

    if (res && (frozenIdx == null || Math.abs(res.start - frozenIdx) > E.cooldown)) {
      frozenIdx = res.start;
      patHistory.push({ type: res.type, start: res.start, end: res.end });
      while (patHistory.length > E.maxPatterns) patHistory.shift();
      out.push({
        i, dir: res.dir, time: bars[i].datetime,
        entry: res.entry, sl: res.sl, tp1: res.tp1, tp2: res.tp2,
        atrNow: a,
        reason: `Nhận diện ${res.ten}, các tỷ lệ Fibonacci giữa các sóng nằm trong ngưỡng cho phép.`,
      });
    }
  }
  return out;
}

// ── MÔ PHỎNG LỆNH ──────────────────────────────────────────────
// Cùng nến chạm cả SL lẫn TP thì tính SL trước (giả định thận trọng).
function simulate(bars, sig, maxHold) {
  const d = sig.dir === "long" ? 1 : -1;
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0)) return null;

  let tp1Hit = false;
  for (let j = sig.i + 1; j <= Math.min(sig.i + maxHold, bars.length - 1); j++) {
    const b = bars[j];
    const chamSL = d === 1 ? b.low <= sig.sl : b.high >= sig.sl;
    if (chamSL) {
      return tp1Hit
        ? { ket: "TP1", R: Math.abs(sig.tp1 - sig.entry) / risk, soNen: j - sig.i }
        : { ket: "SL", R: -1, soNen: j - sig.i };
    }
    const chamTP2 = d === 1 ? b.high >= sig.tp2 : b.low <= sig.tp2;
    if (chamTP2) return { ket: "TP2", R: Math.abs(sig.tp2 - sig.entry) / risk, soNen: j - sig.i };
    const chamTP1 = d === 1 ? b.high >= sig.tp1 : b.low <= sig.tp1;
    if (chamTP1) tp1Hit = true;
  }

  const cuoi = bars[Math.min(sig.i + maxHold, bars.length - 1)].close;
  return { ket: tp1Hit ? "TP1" : "HET_HAN", R: (d * (cuoi - sig.entry)) / risk, soNen: maxHold };
}

function thongKe(ten, sigs, bars, maxHold) {
  const trades = [];
  for (const s of sigs) {
    const r = simulate(bars, s, maxHold);
    if (r) trades.push({ ...s, ...r });
  }
  const n = trades.length;
  const thang = trades.filter((t) => t.ket === "TP1" || t.ket === "TP2").length;
  const thua = trades.filter((t) => t.ket === "SL").length;
  const hetHan = trades.filter((t) => t.ket === "HET_HAN").length;
  const tongR = trades.reduce((a, t) => a + t.R, 0);

  return {
    chiBao: ten,
    soLenh: n, thang, thua, hetHan,
    tyLeThang: n ? Math.round((thang / n) * 100) + "%" : "—",
    tongR: Math.round(tongR * 100) / 100,
    trungBinhR: n ? Math.round((tongR / n) * 100) / 100 : 0,
    chamTP2: trades.filter((t) => t.ket === "TP2").length,
    _trades: trades,
  };
}

// ── GỬI TELEGRAM (phát lại tín hiệu cũ) ────────────────────────
function p(v) { return v.toFixed(PRICE_DECIMALS); }

async function sendMessage(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP_ID, text,
        parse_mode: "HTML", disable_web_page_preview: true,
      }),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, description: err.message };
  }
}

function buildReplayMessage(sig, nguon, khung, ketQua) {
  const side = sig.dir === "long" ? "BUY" : "SELL";
  const band = (sig.atrNow || 0) * ENTRY_BAND_ATR;
  const lines = [
    `🔁 <b>PHÁT LẠI TÍN HIỆU CŨ</b> — ${sig.time} UTC (${khung})`,
    ``,
    `<b>${side}: ${p(sig.entry - band)} - ${p(sig.entry + band)}</b>`,
    `SL: <code>${p(sig.sl)}</code>`,
    `TP1: <code>${p(sig.tp1)}</code>`,
    `TP2: <code>${p(sig.tp2)}</code>`,
    ``,
    `📌 <b>Lý do vào lệnh:</b>`,
    sig.reason || "—",
    ``,
    `<i>Nguồn: ${nguon}</i>`,
  ];
  if (ketQua) {
    lines.push(`<i>Kết quả thực tế: ${ketQua.ket} (${ketQua.R > 0 ? "+" : ""}${Math.round(ketQua.R * 100) / 100}R sau ${ketQua.soNen} nến)</i>`);
  }
  return lines.join("\n");
}

// ── TẢI DỮ LIỆU ────────────────────────────────────────────────
async function fetchBars(symbol, tf, n) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${tf}&outputsize=${n}&order=ASC&timezone=UTC&apikey=${TD_API_KEY}`;
  const json = await (await fetch(url)).json();
  if (json.status === "error" || !Array.isArray(json.values)) {
    throw new Error(json.message || "Không lấy được dữ liệu");
  }
  return json.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open), high: parseFloat(v.high),
    low: parseFloat(v.low), close: parseFloat(v.close),
  }));
}

// ── HANDLER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (CRON_SECRET) {
    const key = req.headers["x-cron-key"] || req.query?.key;
    if (key !== CRON_SECRET) return res.status(401).json({ ok: false, reason: "unauthorized" });
  }

  const symbol = req.query?.symbol || "XAU/USD";
  const tf = req.query?.tf || "1h";
  const nBars = Math.min(parseInt(req.query?.bars || "5000", 10), 5000);
  const maxHold = parseInt(req.query?.hold || "100", 10);
  const showTrades = req.query?.trades === "1";
  const only = (req.query?.only || "").toLowerCase();
  const soGui = Math.min(parseInt(req.query?.send || "0", 10) || 0, 10);

  try {
    const bars = await fetchBars(symbol, tf, nBars);
    if (bars.length < 150) {
      return res.status(200).json({ ok: false, reason: "Không đủ dữ liệu", bars: bars.length });
    }

    const bo = [
      { ten: "Cardwell Range Analyze", key: "cardwell", quet: scanCardwell },
      { ten: "Fan Principle Signals", key: "fan", quet: scanFan },
      { ten: "Elliott Wave Scanner", key: "elliott", quet: scanElliott },
    ].filter((x) => !only || x.key === only);

    const ketQua = bo.map((x) => thongKe(x.ten, x.quet(bars), bars, maxHold));

    // Phát lại N tín hiệu gần nhất lên Telegram
    let daGui = null;
    if (soGui > 0) {
      if (!BOT_TOKEN || !GROUP_ID) {
        daGui = { loi: "Thiếu BOT_TOKEN hoặc GROUP_ID" };
      } else {
        const gui = [];
        for (const r of ketQua) {
          const lay = r._trades.slice(-soGui);
          for (const t of lay) {
            const tg = await sendMessage(
              buildReplayMessage(t, r.chiBao, tf, { ket: t.ket, R: t.R, soNen: t.soNen })
            );
            gui.push({ chiBao: r.chiBao, thoiGian: t.time, huong: t.dir, ok: tg?.ok === true, loi: tg?.ok ? null : tg?.description });
          }
        }
        daGui = gui;
      }
    }

    return res.status(200).json({
      ok: true,
      symbol, khung: tf,
      soNen: bars.length,
      tuNgay: bars[0].datetime,
      denNgay: bars[bars.length - 1].datetime,
      giuToiDa: maxHold + " nến",
      giaDinh: "Cùng nến chạm cả SL và TP thì tính SL trước. Chưa trừ spread và phí.",
      ketQua: ketQua.map(({ _trades, ...r }) => r),
      ...(daGui ? { daGuiTelegram: daGui } : {}),
      ...(showTrades
        ? {
            danhSachLenh: ketQua.map((r) => ({
              chiBao: r.chiBao,
              lenh: r._trades.map((t) => ({
                thoiGian: t.time, huong: t.dir,
                entry: Math.round(t.entry * 100) / 100,
                sl: Math.round(t.sl * 100) / 100,
                tp1: Math.round(t.tp1 * 100) / 100,
                ketQua: t.ket, R: Math.round(t.R * 100) / 100, soNen: t.soNen,
              })),
            })),
          }
        : {}),
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
