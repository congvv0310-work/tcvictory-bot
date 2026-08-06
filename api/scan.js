// api/scan.js — Quét tín hiệu M5 từ UT Bot + Nadaraya-Watson Envelope → Telegram
// Chỉ báo: UT Bot Alerts + Nadaraya-Watson Envelope (LuxAlgo) + veto thân nến
// Bản non-repaint (endpoint) — tín hiệu chốt tại GIÁ ĐÓNG CỬA của nến đã đóng.
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

// ── KHUNG THỜI GIAN ────────────────────────────────────────────
const INTERVAL = "5min";       // khung M5
const BAR_SECONDS = 300;       // 1 nến = 300 giây
const BARS = 500;
const MAX_BAR_AGE_MIN = 6;     // chỉ bắn ngay sau khi nến M5 đóng (tránh gửi trùng)

// ── HIỂN THỊ ───────────────────────────────────────────────────
const ENTRY_BAND_ATR = 0.1;
const PRICE_DECIMALS = 0;
const ENTRY_SHIFT = 0;

// ── CẤU HÌNH CHỈ BÁO ───────────────────────────────────────────
const UTNWE = {
  // UT Bot Alerts
  utKey: 1.0,        // Key Value (sensitivity)
  utAtrLen: 10,      // ATR Period

  // Nadaraya-Watson Envelope (non-repaint / endpoint)
  nwH: 8.0,          // Bandwidth
  nwMult: 3.0,       // hệ số độ rộng band
  nwWindow: 500,     // số nến trong kernel Gauss

  // Veto kích thước thân nến (open→close, KHÔNG tính râu)
  bodyAtrLen: 14,
  maxBodyAtr: 1.5,

  // SL/TP — cách tính theo OBV Signal Confluence [MarkitTick]
  slAtrLen: 14,
  slMult: 1.5,        // SL = 1.5 × ATR(14) → risk
  tp1R: 1.0, tp2R: 2.0, // TP1 = 1R, TP2 = 2R (đã bỏ TP3)
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
    entry,
    entryLo: entry - band,
    entryHi: entry + band,
    sl: entry - d * risk,
    tp1: entry + d * risk * mults[0],
    tp2: entry + d * risk * mults[1],
  };
}

// ── UT BOT: đường trailing-stop theo ATR ───────────────────────
function utTrailingStop(bars, keyValue, atrLen) {
  const closes = bars.map((b) => b.close);
  const xATR = atr(bars, atrLen);
  const stop = new Array(bars.length).fill(null);
  let prev = 0; // nz(prev, 0) như Pine

  for (let i = 0; i < bars.length; i++) {
    const nLoss = xATR[i] != null ? keyValue * xATR[i] : 0;
    const src = closes[i];
    const src1 = i > 0 ? closes[i - 1] : closes[i];

    let cur;
    if (src > prev && src1 > prev) cur = Math.max(prev, src - nLoss);
    else if (src < prev && src1 < prev) cur = Math.min(prev, src + nLoss);
    else if (src > prev) cur = src - nLoss;
    else cur = src + nLoss;

    stop[i] = cur;
    prev = cur;
  }
  return stop;
}

// ── NADARAYA-WATSON: đường trung tâm non-repaint (endpoint) ─────
function nwEndpoint(bars, h, window) {
  const closes = bars.map((b) => b.close);
  const N = Math.min(window, 500);
  const coefs = new Array(N);
  let den = 0;
  for (let i = 0; i < N; i++) {
    coefs[i] = Math.exp(-(i * i) / (h * h * 2));
    den += coefs[i];
  }
  const out = new Array(bars.length).fill(null);
  for (let t = 0; t < bars.length; t++) {
    let s = 0;
    const lim = Math.min(N - 1, t);
    for (let i = 0; i <= lim; i++) s += closes[t - i] * coefs[i];
    out[t] = s / den; // trọng số Gauss suy giảm nhanh nên chia den đầy đủ vẫn khớp
  }
  return out;
}

// ── CHỈ BÁO: UT BOT + NADARAYA-WATSON ──────────────────────────
function analyzeUtNwe(bars) {
  const U = UTNWE;
  const n = bars.length - 1;
  if (n < 3) return { signal: null, levels: null, reason: "", debug: { thieuDuLieu: true } };

  const closes = bars.map((b) => b.close);
  const stop = utTrailingStop(bars, U.utKey, U.utAtrLen);
  const out = nwEndpoint(bars, U.nwH, U.nwWindow);
  const atrBody = atr(bars, U.bodyAtrLen);
  const atrSl = atr(bars, U.slAtrLen);

  // mae = SMA( |close - out|, 499 ) × mult  → band trên/dưới tại nến n
  let sum = 0, cnt = 0;
  for (let t = Math.max(0, n - 498); t <= n; t++) {
    if (out[t] == null) continue;
    sum += Math.abs(closes[t] - out[t]);
    cnt++;
  }
  const mae = cnt ? (sum / cnt) * U.nwMult : null;
  const upper = out[n] != null && mae != null ? out[n] + mae : null;
  const lower = out[n] != null && mae != null ? out[n] - mae : null;

  // UT Bot crossover tại nến n (close cắt trailing-stop)
  const c = closes[n], cP = closes[n - 1];
  const sN = stop[n], sP = stop[n - 1];
  const buyRaw = c > sN && cP <= sP;    // crossover(close, stop)
  const sellRaw = c < sN && cP >= sP;   // crossunder(close, stop)

  // Veto thân nến (không tính râu)
  const body = Math.abs(bars[n].close - bars[n].open);
  const bodyOk = atrBody[n] != null && body <= U.maxBodyAtr * atrBody[n];

  // Tín hiệu: cần chạm band NWE + qua veto
  const plotBuy = buyRaw && lower != null && bars[n].low <= lower && bodyOk;
  const plotSell = sellRaw && upper != null && bars[n].high >= upper && bodyOk;

  const debug = {
    close: round(c, 3),
    trailingStop: round(sN, 3),
    nwCenter: round(out[n], 3),
    bandTren: round(upper, 3),
    bandDuoi: round(lower, 3),
    bodyOk,
    bodyAtr: round(atrBody[n], 3),
  };

  if (!plotBuy && !plotSell) {
    return { signal: null, levels: null, reason: "", debug };
  }

  const isLong = plotBuy;
  const a = atrSl[n];
  if (a == null) return { signal: null, levels: null, reason: "", debug };

  const levels = makeLevels(isLong, c, a * U.slMult, a, [U.tp1R, U.tp2R]);

  const reason = isLong
    ? `UT Bot đảo chiều tăng (giá đóng cửa cắt lên trailing-stop), nến tín hiệu chạm/thủng band dưới Nadaraya-Watson, thân nến ≤ ${U.maxBodyAtr}×ATR.`
    : `UT Bot đảo chiều giảm (giá đóng cửa cắt xuống trailing-stop), nến tín hiệu chạm/vượt band trên Nadaraya-Watson, thân nến ≤ ${U.maxBodyAtr}×ATR.`;

  return { signal: isLong ? "long" : "short", levels, reason, debug };
}

// ── DANH SÁCH CHỈ BÁO ──────────────────────────────────────────
const INDICATORS = [
  { ten: "UT Bot + Nadaraya-Watson", chay: analyzeUtNwe },
];

// ── TẢI DỮ LIỆU ────────────────────────────────────────────────
async function fetchBars(symbol) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${INTERVAL}&outputsize=${BARS}&order=ASC&timezone=UTC&apikey=${TD_API_KEY}`;

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
  // Chỉ giữ nến đã đóng: thời điểm mở + độ dài nến ≤ hiện tại
  return bars.filter((b) => b.ts + BAR_SECONDS * 1000 <= now);
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
    `<b>${side}: ${p(lv.entry)}</b>`,
    `SL: <code>${p(lv.sl)}</code>`,
    `TP1: <code>${p(lv.tp1)}</code>`,
    `TP2: <code>${p(lv.tp2)}</code>`,
  ];
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
      const barAgeMin = Math.round((Date.now() - (lastTs + BAR_SECONDS * 1000)) / 60000);
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
