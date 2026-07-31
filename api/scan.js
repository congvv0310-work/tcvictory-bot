// api/scan.js — Tự tính tín hiệu Cardwell trên khung H1, gửi lên Telegram
// Biến môi trường cần có: BOT_TOKEN, GROUP_ID, TD_API_KEY, CRON_SECRET
// Tùy chọn: SYMBOLS (mặc định "XAU/USD", nhiều cặp ngăn bằng dấu phẩy)

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const TD_API_KEY = process.env.TD_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";

const SYMBOLS = (process.env.SYMBOLS || "XAU/USD")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── CẤU HÌNH — khớp với input mặc định của indicator ───────────
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
  digits: 3, // số chữ số thập phân khi hiển thị giá
};

const BARS = 400; // số nến tải về, đủ để chỉ báo ổn định

// Nến vừa đóng phải "tươi" hơn ngưỡng này thì mới gửi tín hiệu.
// Đặt dưới 60 phút để lần chạy sau không đọc lại đúng cây nến cũ → chặn trùng.
const MAX_BAR_AGE_MIN = 55;

// ── HÀM CHỈ BÁO (mô phỏng cách tính của Pine Script) ───────────

// Làm trơn kiểu Wilder — Pine gọi là ta.rma
function rma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i] ?? 0;
    if (i < len - 1) {
      sum += v;
    } else if (i === len - 1) {
      sum += v;
      out[i] = sum / len;
    } else {
      out[i] = (out[i - 1] * (len - 1) + v) / len;
    }
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

// ADX theo công thức ta.dmi của Pine
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

// ── LOGIC TÍN HIỆU ──────────────────────────────────────────────
function analyze(bars) {
  const closes = bars.map((b) => b.close);
  const rsiArr = rsi(closes, CFG.rsiLen);
  const maArr = sma(closes, CFG.trendLen);
  const atrArr = atr(bars, CFG.atrLen);
  const adxArr = adx(bars, CFG.adxLen);

  // Chạy lại toàn bộ lịch sử để đếm số nến xác nhận, giống hệt Pine
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

  // Pine dùng entry = close[1], tức nến ngay trước nến tín hiệu
  const entry = closes[n - 1];
  const a = atrArr[n];

  const levels =
    a == null
      ? null
      : isLong
      ? {
          entry,
          sl: entry - a * CFG.slMult,
          tp1: entry + a * CFG.tp1Mult,
          tp2: entry + a * CFG.tp2Mult,
          tp3: entry + a * CFG.tp3Mult,
        }
      : {
          entry,
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
    debug: {
      close: closes[n],
      rsi: round(rsiArr[n], 2),
      sma50: round(maArr[n], CFG.digits),
      atr: round(a, CFG.digits),
      adx: round(adxArr[n], 2),
      regimeNow: state,
      regimePrev: prev,
    },
  };
}

function round(v, d) {
  return v == null ? null : Number(v.toFixed(d));
}

function fmt(v) {
  return v.toFixed(CFG.digits);
}

// ── TẢI DỮ LIỆU ─────────────────────────────────────────────────
async function fetchBars(symbol) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1h&outputsize=${BARS}&order=ASC&timezone=UTC&apikey=${TD_API_KEY}`;

  const res = await fetch(url);
  const json = await res.json();

  if (json.status === "error" || !Array.isArray(json.values)) {
    throw new Error(json.message || "Không lấy được dữ liệu");
  }

  const bars = json.values.map((v) => ({
    datetime: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    // Twelve Data trả giờ dạng "YYYY-MM-DD HH:mm:ss", ép về UTC
    ts: Date.parse(v.datetime.replace(" ", "T") + "Z"),
  }));

  // Bỏ cây nến đang chạy dở, chỉ giữ nến đã đóng
  const now = Date.now();
  return bars.filter((b) => b.ts + 3600 * 1000 <= now);
}

// ── GỬI TELEGRAM ────────────────────────────────────────────────
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

function buildMessage(symbol, dir, lv, barTime) {
  const isBuy = dir === "long";
  return [
    `${isBuy ? "🟢" : "🔴"} <b>${isBuy ? "BUY" : "SELL"}</b> — <b>${symbol}</b> (H1)`,
    ``,
    `Entry: <code>${fmt(lv.entry)}</code>`,
    `SL: <code>${fmt(lv.sl)}</code>`,
    `TP1: <code>${fmt(lv.tp1)}</code>`,
    `TP2: <code>${fmt(lv.tp2)}</code>`,
    `TP3: <code>${fmt(lv.tp3)}</code>`,
    ``,
    `<i>Cardwell RSI · nến ${barTime} UTC</i>`,
  ].join("\n");
}

// ── HANDLER ─────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Chặn người lạ gọi bừa
  if (CRON_SECRET) {
    const key = req.headers["x-cron-key"] || req.query?.key;
    if (key !== CRON_SECRET) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }
  }

  const debugMode = req.query?.debug === "1";
  const testMode = req.query?.test === "1"; // gửi thử tin nhắn, bỏ qua kiểm tra độ tươi
  const results = [];

  // Cảnh báo sớm nếu quên khai báo biến môi trường
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

      // Nến này đóng cách đây bao nhiêu phút?
      const barAgeMin = Math.round((Date.now() - (r.barTs + 3600 * 1000)) / 60000);
      const isFresh = barAgeMin <= MAX_BAR_AGE_MIN;

      let sent = false;
      let skipReason = null;
      let telegram = null;

      if (testMode && r.levels) {
        telegram = await sendMessage(
          buildMessage(symbol, r.signal || "long", r.levels, r.barTime) +
            `\n\n⚠️ <i>Tin nhắn thử — không phải tín hiệu thật</i>`
        );
        sent = telegram?.ok === true;
      } else if (r.signal && !r.levels) {
        skipReason = "thiếu ATR";
      } else if (r.signal && !isFresh) {
        // Nến cũ: hoặc dữ liệu chưa cập nhật, hoặc đã kiểm ở lần chạy trước
        skipReason = "nến cũ, bỏ qua để tránh gửi trùng";
      } else if (r.signal) {
        telegram = await sendMessage(buildMessage(symbol, r.signal, r.levels, r.barTime));
        sent = telegram?.ok === true;
      }

      results.push({
        symbol,
        signal: r.signal,
        sent,
        skipReason,
        // Telegram từ chối thì ghi rõ lý do ở đây
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
