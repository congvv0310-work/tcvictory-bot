// api/scan.js — Quét tín hiệu H1 từ nhiều chỉ báo → Telegram
// Chỉ báo: Cardwell Range Analyze, Fan Principle Signals
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
const ENTRY_BAND_ATR = 0.1; // nới khoảng entry ±0.1 × ATR
const SHOW_TP3 = false; // chỉ hiện TP1 và TP2
const PRICE_DECIMALS = 0; // làm tròn số nguyên
const ENTRY_SHIFT = 0; // hiệu chỉnh lệch feed, để 0 cho tới khi gom đủ mẫu

const BARS = 500;
const MAX_BAR_AGE_MIN = 55; // chặn gửi trùng khi cron đọc lại nến cũ

// ── CẤU HÌNH CHỈ BÁO ───────────────────────────────────────────
const CARDWELL = {
  rsiLen: 14,
  trendLen: 50,
  bullLo: 40,
  bullHi: 80,
  bearLo: 20,
  bearHi: 60,
  confirmBars: 2,
  useAdx: false,
  adxLen: 14,
  adxMin: 20,
  atrLen: 14,
  slMult: 1.5,
  tp1Mult: 1.0,
  tp2Mult: 2.0,
  tp3Mult: 3.0,
};

const FAN = {
  pivLen: 5,
  maxFanBars: 300,
  minLegPct: 0.1,
  atrLen: 14,
  slBufAtr: 0.1,
  slMaxAtr: 3.0,
  tp1R: 1.0,
  tp2R: 2.0,
  tp3R: 3.0,
  maxPivots: 20,
};

// ── HÀM CHUNG ──────────────────────────────────────────────────
function rma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i] ?? 0;
    if (i < len - 1) sum += v;
    else if (i === len - 1) {
      sum += v;
      out[i] = sum / len;
    } else out[i] = (out[i - 1] * (len - 1) + v) / len;
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
  const avgGain = rma(gains, len);
  const avgLoss = rma(losses, len);
  return closes.map((_, i) => {
    if (avgGain[i] == null || avgLoss[i] == null) return null;
    if (avgLoss[i] === 0) return 100;
    if (avgGain[i] === 0) return 0;
    return 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
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
  const smPlus = rma(plusDM, len);
  const smMinus = rma(minusDM, len);
  const dx = bars.map((_, i) => {
    if (trur[i] == null || trur[i] === 0) return 0;
    const plus = (100 * smPlus[i]) / trur[i];
    const minus = (100 * smMinus[i]) / trur[i];
    const sum = plus + minus;
    return (Math.abs(plus - minus) / (sum === 0 ? 1 : sum)) * 100;
  });
  return rma(dx, len);
}

function round(v, d) {
  return v == null ? null : Number(v.toFixed(d));
}

function p(v) {
  return v.toFixed(PRICE_DECIMALS);
}

// Ghép khoảng entry và các mức từ entry + rủi ro
function makeLevels(isLong, entryRaw, risk, atrNow, mults) {
  const entry = entryRaw + ENTRY_SHIFT;
  const band = atrNow * ENTRY_BAND_ATR;
  const dir = isLong ? 1 : -1;
  return {
    entryLo: entry - band,
    entryHi: entry + band,
    sl: entry - dir * risk,
    tp1: entry + dir * risk * mults[0],
    tp2: entry + dir * risk * mults[1],
    tp3: entry + dir * risk * mults[2],
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

  // Chạy lại lịch sử để đếm nến xác nhận, giống hệt Pine
  const regime = new Array(bars.length).fill(0);
  let bullCount = 0;
  let bearCount = 0;

  for (let i = 0; i < bars.length; i++) {
    if (rsiArr[i] == null || maArr[i] == null) {
      bullCount = 0;
      bearCount = 0;
      continue;
    }
    const isUp = closes[i] > maArr[i];
    const isDown = closes[i] < maArr[i];
    const inBull = rsiArr[i] >= C.bullLo && rsiArr[i] <= C.bullHi;
    const inBear = rsiArr[i] >= C.bearLo && rsiArr[i] <= C.bearHi;

    const bullRaw = isUp && inBull;
    const bearRaw = isDown && inBear;

    bullCount = bullRaw ? bullCount + 1 : 0;
    bearCount = bearRaw ? bearCount + 1 : 0;

    regime[i] =
      bullRaw && bullCount >= C.confirmBars
        ? 1
        : bearRaw && bearCount >= C.confirmBars
        ? -1
        : 0;
  }

  const n = bars.length - 1;
  const state = regime[n];
  const prev = regime[n - 1];

  const chopOk = !C.useAdx || (adxArr[n] != null && adxArr[n] >= C.adxMin);
  const isLong = state === 1 && prev !== 1 && chopOk;
  const isShort = state === -1 && prev !== -1 && chopOk;
  const signal = isLong ? "long" : isShort ? "short" : null;

  const a = atrArr[n];
  const levels =
    a == null
      ? null
      : makeLevels(isLong, closes[n - 1], a * C.slMult, a, [
          C.tp1Mult / C.slMult,
          C.tp2Mult / C.slMult,
          C.tp3Mult / C.slMult,
        ]);

  const vung = isLong
    ? `vùng tăng (${C.bullLo}–${C.bullHi})`
    : `vùng giảm (${C.bearLo}–${C.bearHi})`;
  const viTri = isLong ? "trên" : "dưới";

  return {
    signal,
    levels,
    reason:
      rsiArr[n] == null
        ? ""
        : `RSI ${rsiArr[n].toFixed(1)} nằm trong ${vung}, giá nằm ${viTri} SMA50.`,
    debug: {
      rsi: round(rsiArr[n], 2),
      sma50: round(maArr[n], 3),
      atr: round(a, 3),
      adx: round(adxArr[n], 2),
      regimeNow: state,
      regimePrev: prev,
    },
  };
}

// ── CHỈ BÁO 2: FAN PRINCIPLE SIGNALS ───────────────────────────
function analyzeFan(bars) {
  const F = FAN;
  const closes = bars.map((b) => b.close);
  const atrArr = atr(bars, F.atrLen);
  const L = F.pivLen;

  const loBar = [];
  const loVal = [];
  const hiBar = [];
  const hiVal = [];

  // Trạng thái quạt, giữ qua từng nến giống biến var của Pine
  let originBar = null;
  let originVal = null;
  let fanDir = 0;
  let fL2Val = null;
  let fL3Bar = null;
  let fL3Val = null;
  let fanM3 = null;

  const slope = (x1, y1, x2, y2) => (x2 !== x1 ? (y2 - y1) / (x2 - x1) : 0);

  for (let i = 0; i < bars.length; i++) {
    // Tìm pivot: tâm cách hiện tại L nến, cửa sổ rộng 2L+1
    if (i >= 2 * L) {
      const j = i - L;
      let isHigh = true;
      let isLow = true;
      const candH = bars[j].high;
      const candL = bars[j].low;
      for (let k = i - 2 * L; k <= i; k++) {
        if (k === j) continue;
        if (bars[k].high >= candH) isHigh = false;
        if (bars[k].low <= candL) isLow = false;
      }
      if (isLow) {
        loBar.push(j);
        loVal.push(candL);
        if (loBar.length > F.maxPivots) {
          loBar.shift();
          loVal.shift();
        }
      }
      if (isHigh) {
        hiBar.push(j);
        hiVal.push(candH);
        if (hiBar.length > F.maxPivots) {
          hiBar.shift();
          hiVal.shift();
        }
      }
    }

    // Dựng quạt tăng từ 4 đáy gần nhất
    if (loBar.length >= 4) {
      const m = loBar.length;
      const oB = loBar[m - 4];
      const oV = loVal[m - 4];
      const b1 = loBar[m - 3];
      const v1 = loVal[m - 3];
      const b2 = loBar[m - 2];
      const v2 = loVal[m - 2];
      const b3 = loBar[m - 1];
      const v3 = loVal[m - 1];
      const fresh = i - oB <= F.maxFanBars;
      const legOk = oV !== 0 && (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct;
      if (
        fresh &&
        legOk &&
        b1 > oB &&
        b2 > b1 &&
        b3 > b2 &&
        (fanDir !== -1 || b3 > fL3Bar)
      ) {
        originBar = oB;
        originVal = oV;
        fanDir = 1;
        fL2Val = v2;
        fL3Bar = b3;
        fL3Val = v3;
        fanM3 = slope(oB, oV, b3, v3);
      }
    }

    // Dựng quạt giảm từ 4 đỉnh gần nhất
    if (hiBar.length >= 4) {
      const m = hiBar.length;
      const oB = hiBar[m - 4];
      const oV = hiVal[m - 4];
      const b1 = hiBar[m - 3];
      const v1 = hiVal[m - 3];
      const b2 = hiBar[m - 2];
      const v2 = hiVal[m - 2];
      const b3 = hiBar[m - 1];
      const v3 = hiVal[m - 1];
      const fresh = i - oB <= F.maxFanBars;
      const legOk = oV !== 0 && (Math.abs(v1 - oV) / oV) * 100 >= F.minLegPct;
      if (
        fresh &&
        legOk &&
        b1 > oB &&
        b2 > b1 &&
        b3 > b2 &&
        (fanDir !== 1 || b3 > fL3Bar)
      ) {
        originBar = oB;
        originVal = oV;
        fanDir = -1;
        fL2Val = v2;
        fL3Bar = b3;
        fL3Val = v3;
        fanM3 = slope(oB, oV, b3, v3);
      }
    }
  }

  const n = bars.length - 1;

  if (fanM3 == null || fanDir === 0 || n < 3) {
    return { signal: null, levels: null, reason: "", debug: { fanDir, quatChuaDung: true } };
  }

  const lineAt = (x) => originVal + fanM3 * (x - originBar);
  const fanPrev = lineAt(n - 1); // giá trị đường quạt 3 tại nến trước
  const fanPrev2 = lineAt(n - 2);

  // Pine kiểm tra phá vỡ trên close[1] so với close[2]
  const bullBreak =
    fanDir === 1 && closes[n - 1] > fanPrev && closes[n - 2] <= fanPrev2;
  const bearBreak =
    fanDir === -1 && closes[n - 1] < fanPrev && closes[n - 2] >= fanPrev2;

  const signal = bullBreak ? "long" : bearBreak ? "short" : null;

  let levels = null;
  const aPrev = atrArr[n - 1];
  const aNow = atrArr[n];

  if (signal && aPrev != null && aNow != null) {
    const entry = closes[n - 1];
    let risk;
    if (bullBreak) {
      const chanQuat = Math.min(fL2Val, fL3Val);
      const rawSl = chanQuat - aPrev * F.slBufAtr;
      const sanSl = entry - aPrev * F.slMaxAtr; // trần rủi ro
      risk = entry - Math.max(rawSl, sanSl);
    } else {
      const chanQuat = Math.max(fL2Val, fL3Val);
      const rawSl = chanQuat + aPrev * F.slBufAtr;
      const tranSl = entry + aPrev * F.slMaxAtr;
      risk = Math.min(rawSl, tranSl) - entry;
    }
    if (risk > 0) {
      levels = makeLevels(bullBreak, entry, risk, aNow, [F.tp1R, F.tp2R, F.tp3R]);
    }
  }

  const huong = bullBreak ? "lên" : "xuống";
  const nguon = bullBreak ? "4 đáy" : "4 đỉnh";

  return {
    signal: levels ? signal : null,
    levels,
    reason: signal
      ? `Giá phá ${huong} đường quạt số 3 (mức ${p(fanPrev)}), quạt dựng từ ${nguon} liên tiếp.`
      : "",
    debug: {
      fanDir,
      quat3HienTai: round(lineAt(n), 3),
      quat3NenTruoc: round(fanPrev, 3),
      soDay: loBar.length,
      soDinh: hiBar.length,
    },
  };
}

// ── DANH SÁCH CHỈ BÁO ──────────────────────────────────────────
// Thêm chỉ báo mới: viết hàm analyzeXxx rồi thêm một dòng vào đây.
const INDICATORS = [
  { ten: "Cardwell Range Analyze", chay: analyzeCardwell },
  { ten: "Fan Principle Signals", chay: analyzeFan },
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
  return bars.filter((b) => b.ts + 3600 * 1000 <= now); // bỏ nến đang chạy dở
}

// ── GỬI TELEGRAM ───────────────────────────────────────────────
async function sendMessage(text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: GROUP_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
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

        let sent = false;
        let skipReason = null;
        let telegram = null;

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
          telegram = await sendMessage(
            buildMessage(r.signal, r.levels, r.reason, ind.ten)
          );
          sent = telegram?.ok === true;
        }

        results.push({
          symbol,
          chiBao: ind.ten,
          signal: r.signal,
          sent,
          skipReason,
          telegramError: telegram && !telegram.ok ? telegram.description : null,
          barTime,
          barAgeMin,
          isFresh,
          barsUsed: bars.length,
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
