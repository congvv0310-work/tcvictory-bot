// api/scan.js — Cardwell Range Analyze trên khung H1 → Telegram
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

// ── CẤU HÌNH — khớp input mặc định của indicator ───────────────
const CFG = {
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

// ── HIỂN THỊ ───────────────────────────────────────────────────
const ENTRY_BAND_ATR = 0.1; // nới khoảng entry ±0.1 × ATR
const SHOW_TP3 = false; // chỉ hiện TP1 và TP2
const PRICE_DECIMALS = 0; // làm tròn số nguyên

// Hiệu chỉnh lệch so với sàn/feed bạn dùng.
// Để 0 cho tới khi gom đủ 5–10 tín hiệu và thấy rõ lệch một chiều.
// Nếu server luôn cao hơn ~3 điểm thì đặt -3.
const ENTRY_SHIFT = 0;

const BARS = 400;
const MAX_BAR_AGE_MIN = 55; // chặn gửi trùng khi cron đọc lại nến cũ

// ── HÀM CHỈ BÁO (mô phỏng Pine Script) ─────────────────────────
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

// ── LOGIC TÍN HIỆU ─────────────────────────────────────────────
function analyze(bars) {
  const closes = bars.map((b) => b.close);
  const rsiArr = rsi(closes, CFG.rsiLen);
  const maArr = sma(closes, CFG.trendLen);
  const atrArr = atr(bars, CFG.atrLen);
  const adxArr = adx(bars, CFG.adxLen);

  // Chạy lại toàn bộ lịch sử để đếm nến xác nhận, giống hệt Pine
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
    const inBull = rsiArr[i] >= CFG.bullLo && rsiArr[i] <= CFG.bullHi;
    const inBear = rsiArr[i] >= CFG.bearLo && rsiArr[i] <= CFG.bearHi;

    const bullRaw = isUp && inBull;
    const bearRaw = isDown && inBear;

    bullCount = bullRaw ? bullCount + 1 : 0;
    bearCount = bearRaw ? bearCount + 1 : 0;

    const bull = bullRaw && bullCount >= CFG.confirmBars;
    const bear = bearRaw && bearCount >= CFG.confirmBars;
    regime[i] = bull ? 1 : bear ? -1 : 0;
  }

  const n = bars.length - 1; // nến vừa đóng
  const state = regime[n];
  const prev = regime[n - 1];

  const chopOk = !CFG.useAdx || (adxArr[n] != null && adxArr[n] >= CFG.adxMin);
  const isLong = state === 1 && prev !== 1 && chopOk;
  const isShort = state === -1 && prev !== -1 && chopOk;

  // Pine: entry = close[1], tức nến ngay trước nến tín hiệu
  const entry = closes[n - 1] + ENTRY_SHIFT;
  const a = atrArr[n];
  const band = a == null ? null : a * ENTRY_BAND_ATR;

  const levels =
    a == null
      ? null
      : isLong
      ? {
          entryLo: entry - band,
          entryHi: entry + band,
          sl: entry - a * CFG.slMult,
          tp1: entry + a * CFG.tp1Mult,
          tp2: entry + a * CFG.tp2Mult,
          tp3: entry + a * CFG.tp3Mult,
        }
      : {
          entryLo: entry - band,
          entryHi: entry + band,
          sl: entry + a * CFG.slMult,
          tp1: entry - a * CFG.tp1Mult,
          tp2: entry - a * CFG.tp2Mult,
          tp3: entry - a * CFG.tp3Mult,
        };

  return {
    signal: isLong ? "long" : isShort ? "short" : null,
    levels,
    barTime: bars[n].datetime,
    barTs: bars[n].ts,
    reason: {
      rsi: rsiArr[n],
      close: closes[n],
      sma50: maArr[n],
      adx: adxArr[n],
    },
    debug: {
      close: closes[n],
      rsi: round(rsiArr[n], 2),
      sma50: round(maArr[n], 3),
      atr: round(a, 3),
      adx: round(adxArr[n], 2),
      regimeNow: state,
      regimePrev: prev,
    },
  };
}

function round(v, d) {
  return v == null ? null : Number(v.toFixed(d));
}

function p(v) {
  return v.toFixed(PRICE_DECIMALS);
}

// ── LÝ DO VÀO LỆNH (ngắn gọn) ──────────────────────────────────
function buildReason(dir, r) {
  const isBuy = dir === "long";
  const vung = isBuy
    ? `vùng tăng (${CFG.bullLo}–${CFG.bullHi})`
    : `vùng giảm (${CFG.bearLo}–${CFG.bearHi})`;
  const viTri = isBuy ? "trên" : "dưới";
  return `RSI ${r.rsi.toFixed(1)} nằm trong ${vung}, giá nằm ${viTri} SMA50.`;
}

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

function buildMessage(dir, lv, reason) {
  const side = dir === "long" ? "BUY" : "SELL";

  const lines = [
    `<b>${side}: ${p(lv.entryLo)} - ${p(lv.entryHi)}</b>`,
    `SL: <code>${p(lv.sl)}</code>`,
    `TP1: <code>${p(lv.tp1)}</code>`,
    `TP2: <code>${p(lv.tp2)}</code>`,
  ];

  if (SHOW_TP3) lines.push(`TP3: <code>${p(lv.tp3)}</code>`);

  lines.push(``, `📌 <b>Lý do vào lệnh:</b>`, buildReason(dir, reason));

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
      if (bars.length < CFG.trendLen + 5) {
        results.push({ symbol, error: "Không đủ dữ liệu", bars: bars.length });
        continue;
      }

      const r = analyze(bars);
      const barAgeMin = Math.round((Date.now() - (r.barTs + 3600 * 1000)) / 60000);
      const isFresh = barAgeMin <= MAX_BAR_AGE_MIN;

      let sent = false;
      let skipReason = null;
      let telegram = null;

      if (testMode && r.levels) {
        telegram = await sendMessage(
          buildMessage(r.signal || "short", r.levels, r.reason) +
            `\n\n⚠️ <i>Tin nhắn thử — không phải tín hiệu thật</i>`
        );
        sent = telegram?.ok === true;
      } else if (r.signal && !r.levels) {
        skipReason = "thiếu ATR";
      } else if (r.signal && !isFresh) {
        skipReason = "nến cũ, bỏ qua để tránh gửi trùng";
      } else if (r.signal) {
        telegram = await sendMessage(buildMessage(r.signal, r.levels, r.reason));
        sent = telegram?.ok === true;
      }

      results.push({
        symbol,
        signal: r.signal,
        sent,
        skipReason,
        telegramError: telegram && !telegram.ok ? telegram.description : null,
        barTime: r.barTime,
        barAgeMin,
        isFresh,
        barsUsed: bars.length,
        ...(debugMode ? { debug: r.debug, levels: r.levels } : {}),
      });
    } catch (err) {
      console.error(`Lỗi với ${symbol}:`, err.message);
      results.push({ symbol, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
}
