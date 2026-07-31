// api/scan.js — Quét tín hiệu H1 từ nhiều chỉ báo → Telegram
// Chỉ báo: Cardwell Range Analyze · Fan Principle Signals · Elliott Wave Scanner
// Biến môi trường: BOT_TOKEN, GROUP_ID, TD_API_KEY, CRON_SECRET
// Tùy chọn: SYMBOLS (mặc định "XAU/USD")

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const TD_API_KEY = process.env.TD_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";

const SYMBOLS = (process.env.SYMBOLS || "XAU/USD")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── HIỂN THỊ ───────────────────────────────────────────────────
const ENTRY_BAND_ATR = 0.1;
const SHOW_TP3 = false;
const PRICE_DECIMALS = 0;
const ENTRY_SHIFT = 0;

const BARS = 500;
const MAX_BAR_AGE_MIN = 55;

// ── CẤU HÌNH CHỈ BÁO ───────────────────────────────────────────
const CARDWELL = {
  rsiLen: 14, trendLen: 50,
  bullLo: 40, bullHi: 80, bearLo: 20, bearHi: 60,
  confirmBars: 2,
  useAdx: false, adxLen: 14, adxMin: 20,
  atrLen: 14, slMult: 1.5, tp1Mult: 1.0, tp2Mult: 2.0, tp3Mult: 3.0,
};

const FAN = {
  pivLen: 5, maxFanBars: 300, minLegPct: 0.1,
  atrLen: 14, slBufAtr: 0.1, slMaxAtr: 3.0,
  tp1R: 1.0, tp2R: 2.0, tp3R: 3.0, maxPivots: 20,
};

const ELLIOTT = {
  pivLeft: 5, pivRight: 5, maxPiv: 500,
  cooldown: 5, maxPatterns: 3,
  fibTol: 0.10,
  minSizeAtr: 0.8,
  reqW3Ext: true, reqW4NoOverlap: true, reqW3NotShortest: true,
  stopAtrBuf: 0.5,
  minRr: 1.5,
};

// ── HÀM CHUNG ──────────────────────────────────────────────────
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
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    gains.push(ch > 0 ? ch : 0);
    losses.push(ch < 0 ? -ch : 0);
  }
  const ag = rma(gains, len);
  const al = rma(losses, len);
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

function atr(bars, len) {
  return rma(trueRange(bars), len);
}

function adx(bars, len) {
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const trur = rma(trueRange(bars), len);
  const smP = rma(plusDM, len);
  const smM = rma(minusDM, len);
  const dx = bars.map((_, i) => {
    if (trur[i] == null || trur[i] === 0) return 0;
    const plus = (100 * smP[i]) / trur[i];
    const minus = (100 * smM[i]) / trur[i];
    const s = plus + minus;
    return (Math.abs(plus - minus) / (s === 0 ? 1 : s)) * 100;
  });
  return rma(dx, len);
}

function round(v, d) {
  return v == null ? null : Number(v.toFixed(d));
}

function p(v) {
  return v.toFixed(PRICE_DECIMALS);
}

// Từ entry + khoảng rủi ro, dựng đủ bộ mức
function makeLevels(isLong, entryRaw, risk, atrNow, mults) {
  const entry = entryRaw + ENTRY_SHIFT;
  const band = atrNow * ENTRY_BAND_ATR;
  const d = isLong ? 1 : -1;
  return {
    entryLo: entry - band,
    entryHi: entry + band,
    sl: entry - d * risk,
    tp1: entry + d * risk * mults[0],
    tp2: entry + d * risk * mults[1],
    tp3: entry + d * risk * mults[2],
  };
}

// Khi chỉ báo cho sẵn từng mức cụ thể
function makeLevelsExplicit(entryRaw, sl, tp1, tp2, tp3, atrNow) {
  const entry = entryRaw + ENTRY_SHIFT;
  const band = atrNow * ENTRY_BAND_ATR;
  const shift = entry - entryRaw;
  return {
    entryLo: entry - band,
    entryHi: entry + band,
    sl: sl + shift,
    tp1: tp1 + shift,
    tp2: tp2 + shift,
    tp3: tp3 + shift,
  };
}

// ── CHỈ BÁO 1: CARDWELL RANGE ANALYZE ──────────────────────────
function analyzeCardwell(bars) {
  const C = CARDWELL;
  const closes = bars.map((b) => b.close);
  const rsiArr = rsi(closes, C.rsiLen);
  const maArr = sma(closes, C.trendLen);
  const atrArr = atr(bars, C.atrLen);
  const adxArr = adx(bars, C.adxLen);

  const regime = new Array(bars.length).fill(0);
  let bullCount = 0;
  let bearCount = 0;

  for (let i = 0; i < bars.length; i++) {
    if (rsiArr[i] == null || maArr[i] == null) { bullCount = 0; bearCount = 0; continue; }
    const bullRaw = closes[i] > maArr[i] && rsiArr[i] >= C.bullLo && rsiArr[i] <= C.bullHi;
    const bearRaw = closes[i] < maArr[i] && rsiArr[i] >= C.bearLo && rsiArr[i] <= C.bearHi;
    bullCount = bullRaw ? bullCount + 1 : 0;
    bearCount = bearRaw ? bearCount + 1 : 0;
    regime[i] =
      bullRaw && bullCount >= C.confirmBars ? 1
      : bearRaw && bearCount >= C.confirmBars ? -1
      : 0;
  }

  const n = bars.length - 1;
  const state = regime[n];
  const prev = regime[n - 1];
  const chopOk = !C.useAdx || (adxArr[n] != null && adxArr[n] >= C.adxMin);
  const isLong = state === 1 && prev !== 1 && chopOk;
  const isShort = state === -1 && prev !== -1 && chopOk;

  const a = atrArr[n];
  const levels =
    a == null || !(isLong || isShort)
      ? null
      : makeLevels(isLong, closes[n - 1], a * C.slMult, a, [
          C.tp1Mult / C.slMult, C.tp2Mult / C.slMult, C.tp3Mult / C.slMult,
        ]);

  const vung = isLong
    ? `vùng tăng (${C.bullLo}–${C.bullHi})`
    : `vùng giảm (${C.bearLo}–${C.bearHi})`;

  return {
    signal: isLong ? "long" : isShort ? "short" : null,
    levels,
    reason: rsiArr[n] == null ? ""
      : `RSI ${rsiArr[n].toFixed(1)} nằm trong ${vung}, giá nằm ${isLong ? "trên" : "dưới"} SMA50.`,
    debug: {
      rsi: round(rsiArr[n], 2), sma50: round(maArr[n], 3),
      atr: round(a, 3), adx: round(adxArr[n], 2),
      regimeNow: state, regimePrev: prev,
    },
  };
}

// ── CHỈ BÁO 2: FAN PRINCIPLE SIGNALS ───────────────────────────
function analyzeFan(bars) {
  const F = FAN;
  const closes = bars.map((b) => b.close);
  const atrArr = atr(bars, F.atrLen);
  const L = F.pivLen;

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
      if (isLow) {
        loBar.push(j); loVal.push(cL);
        if (loBar.length > F.maxPivots) { loBar.shift(); loVal.shift(); }
      }
      if (isHigh) {
        hiBar.push(j); hiVal.push(cH);
        if (hiBar.length > F.maxPivots) { hiBar.shift(); hiVal.shift(); }
      }
    }

    // Quạt tăng từ 4 đáy gần nhất
    if (loBar.length >= 4) {
      const m = loBar.length;
      const oB = loBar[m - 4], oV = loVal[m - 4];
      const b1 = loBar[m - 3], v1 = loVal[m - 3];
      const b2 = loBar[m - 2], v2 = loVal[m - 2];
      const b3 = loBar[m - 1], v3 = loVal[m - 1];
      if (i - oB <= F.maxFanBars && oV !== 0 &&
          (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct &&
          b1 > oB && b2 > b1 && b3 > b2 &&
          (fanDir !== -1 || b3 > fL3Bar)) {
        originBar = oB; originVal = oV; fanDir = 1;
        fL2Val = v2; fL3Bar = b3; fL3Val = v3;
        fanM3 = slope(oB, oV, b3, v3);
      }
    }

    // Quạt giảm từ 4 đỉnh gần nhất
    if (hiBar.length >= 4) {
      const m = hiBar.length;
      const oB = hiBar[m - 4], oV = hiVal[m - 4];
      const b1 = hiBar[m - 3], v1 = hiVal[m - 3];
      const b2 = hiBar[m - 2], v2 = hiVal[m - 2];
      const b3 = hiBar[m - 1], v3 = hiVal[m - 1];
      if (i - oB <= F.maxFanBars && oV !== 0 &&
          (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct &&
          b1 > oB && b2 > b1 && b3 > b2 &&
          (fanDir !== 1 || b3 > fL3Bar)) {
        originBar = oB; originVal = oV; fanDir = -1;
        fL2Val = v2; fL3Bar = b3; fL3Val = v3;
        fanM3 = slope(oB, oV, b3, v3);
      }
    }
  }

  const n = bars.length - 1;
  if (fanM3 == null || fanDir === 0 || n < 3) {
    return { signal: null, levels: null, reason: "", debug: { fanDir, quatChuaDung: true } };
  }

  const lineAt = (x) => originVal + fanM3 * (x - originBar);
  const fanPrev = lineAt(n - 1);
  const fanPrev2 = lineAt(n - 2);

  const bullBreak = fanDir === 1 && closes[n - 1] > fanPrev && closes[n - 2] <= fanPrev2;
  const bearBreak = fanDir === -1 && closes[n - 1] < fanPrev && closes[n - 2] >= fanPrev2;
  const signal = bullBreak ? "long" : bearBreak ? "short" : null;

  let levels = null;
  const aPrev = atrArr[n - 1], aNow = atrArr[n];

  if (signal && aPrev != null && aNow != null) {
    const entry = closes[n - 1];
    let risk;
    if (bullBreak) {
      const chan = Math.min(fL2Val, fL3Val);
      risk = entry - Math.max(chan - aPrev * F.slBufAtr, entry - aPrev * F.slMaxAtr);
    } else {
      const chan = Math.max(fL2Val, fL3Val);
      risk = Math.min(chan + aPrev * F.slBufAtr, entry + aPrev * F.slMaxAtr) - entry;
    }
    if (risk > 0) levels = makeLevels(bullBreak, entry, risk, aNow, [F.tp1R, F.tp2R, F.tp3R]);
  }

  return {
    signal: levels ? signal : null,
    levels,
    reason: signal
      ? `Giá phá ${bullBreak ? "lên" : "xuống"} đường quạt số 3 (mức ${p(fanPrev)}), quạt dựng từ ${bullBreak ? "4 đáy" : "4 đỉnh"} liên tiếp.`
      : "",
    debug: {
      fanDir,
      quat3HienTai: round(lineAt(n), 3),
      quat3NenTruoc: round(fanPrev, 3),
      soDay: loBar.length, soDinh: hiBar.length,
    },
  };
}

// ── CHỈ BÁO 3: ELLIOTT WAVE SCANNER ────────────────────────────
function analyzeElliott(bars) {
  const E = ELLIOTT;
  const atrArr = atr(bars, 14);
  const LL = E.pivLeft, RL = E.pivRight;

  // Mảng pivot xếp mới nhất ở đầu, giống unshift của Pine
  const highs = [];
  const lows = [];
  let frozenIdx = null;
  let patHistory = []; // {type, start, end} — type 1 = sóng đẩy, 2 = điều chỉnh
  let finalRes = null;

  const inRange = (r, lo, hi, tol) =>
    r != null && !Number.isNaN(r) && r >= lo * (1 - tol) && r <= hi * (1 + tol);

  const overlapsImpulse = (start, end) =>
    patHistory.some((d) => d.type === 1 && d.start <= end && d.end >= start);

  function impulseBull(a) {
    if (highs.length < 3 || lows.length < 3) return null;
    const p0 = lows[2], p1 = highs[2], p2 = lows[1], p3 = highs[1], p4 = lows[0], p5 = highs[0];
    if (!(p0.i < p1.i && p1.i < p2.i && p2.i < p3.i && p3.i < p4.i && p4.i < p5.i)) return null;
    if (!(p1.p > p0.p && p2.p > p0.p && p3.p > p1.p)) return null;
    if (!(p2.p > p0.p)) return null;

    const w1 = p1.p - p0.p;
    const w3 = p3.p - p2.p;
    const w5 = p5.p - p4.p;
    const w2ret = p1.p > p0.p ? (p1.p - p2.p) / w1 : null;
    const w4ret = p3.p > p2.p ? (p3.p - p4.p) / w3 : null;

    if (E.reqW4NoOverlap && !(p4.p > p1.p)) return null;
    if (E.reqW3NotShortest && !(w3 >= w1 && w3 >= w5)) return null;
    if (E.reqW3Ext && !(w3 > w1)) return null;
    if (!inRange(w2ret, 0.382, 0.786, E.fibTol)) return null;
    if (!inRange(w4ret, 0.236, 0.500, E.fibTol)) return null;
    const minSize = a * E.minSizeAtr;
    if (!(w1 > minSize && w3 > minSize && w5 > minSize)) return null;

    const entry = p5.p;
    const stop = p4.p - a * E.stopAtrBuf;
    const target = p5.p + w3 * 0.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(target - entry) / risk >= E.minRr)) return null;

    return {
      type: 1, dir: "long", ten: "Sóng đẩy tăng (1-2-3-4-5)",
      entry, stop, tp1: target, tp2: p5.p + w3 * 1.0, tp3: p5.p + w3 * 1.618,
      start: p0.i, end: p5.i, w1, w3, w5,
    };
  }

  function impulseBear(a) {
    if (highs.length < 3 || lows.length < 3) return null;
    const p0 = highs[2], p1 = lows[2], p2 = highs[1], p3 = lows[1], p4 = highs[0], p5 = lows[0];
    if (!(p0.i < p1.i && p1.i < p2.i && p2.i < p3.i && p3.i < p4.i && p4.i < p5.i)) return null;
    if (!(p1.p < p0.p && p2.p < p0.p && p3.p < p1.p)) return null;
    if (!(p2.p < p0.p)) return null;

    const w1 = p0.p - p1.p;
    const w3 = p2.p - p3.p;
    const w5 = p4.p - p5.p;
    const w2ret = p0.p > p1.p ? (p2.p - p1.p) / w1 : null;
    const w4ret = p2.p > p3.p ? (p4.p - p3.p) / w3 : null;

    if (E.reqW4NoOverlap && !(p4.p < p1.p)) return null;
    if (E.reqW3NotShortest && !(w3 >= w1 && w3 >= w5)) return null;
    if (E.reqW3Ext && !(w3 > w1)) return null;
    if (!inRange(w2ret, 0.382, 0.786, E.fibTol)) return null;
    if (!inRange(w4ret, 0.236, 0.500, E.fibTol)) return null;
    const minSize = a * E.minSizeAtr;
    if (!(w1 > minSize && w3 > minSize && w5 > minSize)) return null;

    const entry = p5.p;
    const stop = p4.p + a * E.stopAtrBuf;
    const target = p5.p - w3 * 0.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(target - entry) / risk >= E.minRr)) return null;

    return {
      type: 1, dir: "short", ten: "Sóng đẩy giảm (1-2-3-4-5)",
      entry, stop, tp1: target, tp2: p5.p - w3 * 1.0, tp3: p5.p - w3 * 1.618,
      start: p0.i, end: p5.i, w1, w3, w5,
    };
  }

  function correctionBull(a) {
    if (highs.length < 2 || lows.length < 2) return null;
    const wa = lows[1], wb = highs[1], wc = lows[0];
    if (!(wa.i < wb.i && wb.i < wc.i)) return null;

    const aLen = wb.p - wa.p;
    const cDrop = wb.p - wc.p;
    const cExt = aLen > 1e-10 ? cDrop / aLen : null;
    const minSize = a * E.minSizeAtr;
    if (!(aLen > minSize && cDrop > minSize)) return null;
    if (!inRange(cExt, 0.618, 1.618, E.fibTol)) return null;
    if (!(wc.p <= wa.p)) return null;

    const entry = wc.p;
    const stop = wc.p - a * E.stopAtrBuf;
    const tp1 = wc.p + aLen * 1.0;
    const tp2 = wc.p + aLen * 1.618;
    const tp3 = wc.p + aLen * 2.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(tp2 - entry) / risk >= E.minRr)) return null;

    return {
      type: 2, dir: "long", ten: "Sóng điều chỉnh ABC tăng",
      entry, stop, tp1, tp2, tp3, start: wa.i, end: wc.i, aLen,
    };
  }

  function correctionBear(a) {
    if (highs.length < 2 || lows.length < 2) return null;
    const wa = highs[1], wb = lows[1], wc = highs[0];
    if (!(wa.i < wb.i && wb.i < wc.i)) return null;

    const aLen = wa.p - wb.p;
    const cRise = wc.p - wb.p;
    const cExt = aLen > 1e-10 ? cRise / aLen : null;
    const minSize = a * E.minSizeAtr;
    if (!(aLen > minSize && cRise > minSize)) return null;
    if (!inRange(cExt, 0.618, 1.618, E.fibTol)) return null;
    if (!(wc.p >= wa.p)) return null;

    const entry = wc.p;
    const stop = wc.p + a * E.stopAtrBuf;
    const tp1 = wc.p - aLen * 1.0;
    const tp2 = wc.p - aLen * 1.618;
    const tp3 = wc.p - aLen * 2.618;
    const risk = Math.abs(entry - stop);
    if (!(risk > 1e-10 && Math.abs(tp2 - entry) / risk >= E.minRr)) return null;

    return {
      type: 2, dir: "short", ten: "Sóng điều chỉnh ABC giảm",
      entry, stop, tp1, tp2, tp3, start: wa.i, end: wc.i, aLen,
    };
  }

  for (let i = 0; i < bars.length; i++) {
    // Pivot: cửa sổ KHÔNG tính nến hiện tại (khác với Fan)
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

    // Ưu tiên sóng đẩy, sau đó mới tới điều chỉnh
    let res = impulseBull(a) || impulseBear(a);
    if (!res) {
      const cb = correctionBull(a);
      if (cb && !overlapsImpulse(cb.start, cb.end)) res = cb;
      else {
        const cbe = correctionBear(a);
        if (cbe && !overlapsImpulse(cbe.start, cbe.end)) res = cbe;
      }
    }

    const isNew = res && (frozenIdx == null || Math.abs(res.start - frozenIdx) > E.cooldown);
    if (isNew) {
      frozenIdx = res.start;
      patHistory.push({ type: res.type, start: res.start, end: res.end });
      while (patHistory.length > E.maxPatterns) patHistory.shift();
      if (i === bars.length - 1) finalRes = res;
    }
  }

  const n = bars.length - 1;
  const aNow = atrArr[n];

  if (!finalRes || aNow == null) {
    return {
      signal: null, levels: null, reason: "",
      debug: { soDinh: highs.length, soDay: lows.length, mauGanNhat: patHistory.length },
    };
  }

  return {
    signal: finalRes.dir,
    levels: makeLevelsExplicit(
      finalRes.entry, finalRes.stop, finalRes.tp1, finalRes.tp2, finalRes.tp3, aNow
    ),
    reason: `Nhận diện ${finalRes.ten}, các tỷ lệ Fibonacci giữa các sóng nằm trong ngưỡng cho phép.`,
    debug: {
      mau: finalRes.ten,
      entryGoc: round(finalRes.entry, 3),
      slGoc: round(finalRes.stop, 3),
      soDinh: highs.length, soDay: lows.length,
    },
  };
}

// ── DANH SÁCH CHỈ BÁO ──────────────────────────────────────────
const INDICATORS = [
  { ten: "Cardwell Range Analyze", chay: analyzeCardwell },
  { ten: "Fan Principle Signals", chay: analyzeFan },
  { ten: "Elliott Wave Scanner", chay: analyzeElliott },
];

// ── TẢI DỮ LIỆU ────────────────────────────────────────────────
async function fetchBars(symbol) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1h&outputsize=${BARS}&order=ASC&timezone=UTC&apikey=${TD_API_KEY}`;

  const json = await (await fetch(url)).json();
  if (json.status === "error" || !Array.isArray(json.values)) {
    throw new Error(json.message || "Không lấy được dữ liệu");
  }

  const bars = json.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    ts: Date.parse(v.datetime.replace(" ", "T") + "Z"),
  }));

  const now = Date.now();
  return bars.filter((b) => b.ts + 3600 * 1000 <= now);
}

// ── GỬI TELEGRAM ───────────────────────────────────────────────
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
    return { ok: false, description: "Không gọi được API Telegram: " + err.message };
  }
}

function buildMessage(dir, lv, reason, nguon) {
  const side = dir === "long" ? "BUY" : "SELL";
  const lines = [
    `<b>${side}: ${p(lv.entryLo)} - ${p(lv.entryHi)}</b>`,
    `SL: <code>${p(lv.sl)}</code>`,
    `TP1: <code>${p(lv.tp1)}</code>`,
    `TP2: <code>${p(lv.tp2)}</code>`,
  ];
  if (SHOW_TP3) lines.push(`TP3: <code>${p(lv.tp3)}</code>`);
  lines.push(``, `📌 <b>Lý do vào lệnh:</b>`, reason);
  lines.push(``, `<i>Nguồn: ${nguon}</i>`);
  return lines.join("\n");
}

// ── HANDLER ────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (CRON_SECRET) {
    const key = req.headers["x-cron-key"] || req.query?.key;
    if (key !== CRON_SECRET) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }
  }

  const debugMode = req.query?.debug === "1";
  const testMode = req.query?.test === "1";
  const results = [];

  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!GROUP_ID) missing.push("GROUP_ID");
  if (!TD_API_KEY) missing.push("TD_API_KEY");
  if (missing.length) {
    return res.status(200).json({ ok: false, reason: "thiếu biến môi trường", missing });
  }

  for (const symbol of SYMBOLS) {
    try {
      const bars = await fetchBars(symbol);
      if (bars.length < 100) {
        results.push({ symbol, error: "Không đủ dữ liệu", bars: bars.length });
        continue;
      }

      const lastTs = bars[bars.length - 1].ts;
      const barAgeMin = Math.round((Date.now() - (lastTs + 3600 * 1000)) / 60000);
      const isFresh = barAgeMin <= MAX_BAR_AGE_MIN;
      const barTime = bars[bars.length - 1].datetime;

      for (const ind of INDICATORS) {
        const r = ind.chay(bars);

        let sent = false, skipReason = null, telegram = null;

        if (testMode && r.levels) {
          telegram = await sendMessage(
            buildMessage(r.signal || "short", r.levels, r.reason, ind.ten) +
              `\n\n⚠️ <i>Tin nhắn thử — không phải tín hiệu thật</i>`
          );
          sent = telegram?.ok === true;
        } else if (r.signal && !r.levels) {
          skipReason = "thiếu mức giá";
        } else if (r.signal && !isFresh) {
          skipReason = "nến cũ, bỏ qua để tránh gửi trùng";
        } else if (r.signal) {
          telegram = await sendMessage(buildMessage(r.signal, r.levels, r.reason, ind.ten));
          sent = telegram?.ok === true;
        }

        results.push({
          symbol, chiBao: ind.ten, signal: r.signal, sent, skipReason,
          telegramError: telegram && !telegram.ok ? telegram.description : null,
          barTime, barAgeMin, isFresh, barsUsed: bars.length,
          ...(debugMode ? { debug: r.debug, levels: r.levels } : {}),
        });
      }
    } catch (err) {
      console.error(`Lỗi với ${symbol}:`, err.message);
      results.push({ symbol, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
}
