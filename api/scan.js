// api/scan.js — OBV Signal Confluence [MarkitTick] trên khung H1 → Telegram
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
  maType: "SMA", // SMA | RMA | WMA | VWMA
  maLen: 21,
  atrLen: 14,
  slMult: 1.5,
  tp1Rr: 1.0,
  tp2Rr: 2.0,
  tp3Rr: 3.0,
  // Bộ lọc — indicator mặc định tắt hết
  useAdx: false,
  adxLen: 14,
  adxMin: 20.0,
  useVol: false,
  volMult: 1.0,
  digits: 3,
};

const BARS = 400;
const MAX_BAR_AGE_MIN = 55; // chặn gửi trùng khi cron chạy lại cùng một nến

// ── HÀM CHỈ BÁO ────────────────────────────────────────────────
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

function wma(src, len) {
  const out = new Array(src.length).fill(null);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0;
    for (let k = 0; k < len; k++) acc += src[i - k] * (len - k);
    out[i] = acc / denom;
  }
  return out;
}

function vwma(src, vols, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    let num = 0;
    let den = 0;
    for (let k = 0; k < len; k++) {
      num += src[i - k] * vols[i - k];
      den += vols[i - k];
    }
    out[i] = den === 0 ? null : num / den;
  }
  return out;
}

function movingAverage(src, vols, type, len) {
  if (type === "RMA") return rma(src, len);
  if (type === "WMA") return wma(src, len);
  if (type === "VWMA") return vwma(src, vols, len);
  return sma(src, len);
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

// OBV = cộng dồn (dấu thay đổi giá × volume)
// Giá trị tuyệt đối lệch TradingView vì mình chỉ có 400 nến,
// nhưng điểm cắt với MA thì giống hệt (cả hai cùng lệch một hằng số).
function obvSeries(closes, vols) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const sign = ch > 0 ? 1 : ch < 0 ? -1 : 0;
    out.push(out[i - 1] + sign * vols[i]);
  }
  return out;
}

// ── LOGIC TÍN HIỆU ─────────────────────────────────────────────
function analyze(bars) {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);

  const obv = obvSeries(closes, vols);
  const obvMa = movingAverage(obv, vols, CFG.maType, CFG.maLen);
  const atrArr = atr(bars, CFG.atrLen);
  const adxArr = adx(bars, CFG.adxLen);
  const volAvg = sma(vols, 20);

  const n = bars.length - 1; // nến vừa đóng

  // Cắt lên / cắt xuống tại nến vừa đóng
  const canCross =
    obvMa[n] != null && obvMa[n - 1] != null && obv[n] != null && obv[n - 1] != null;
  const crossBull = canCross && obv[n] > obvMa[n] && obv[n - 1] <= obvMa[n - 1];
  const crossBear = canCross && obv[n] < obvMa[n] && obv[n - 1] >= obvMa[n - 1];

  const adxOk = !CFG.useAdx || (adxArr[n] != null && adxArr[n] >= CFG.adxMin);
  const volOk =
    !CFG.useVol || (volAvg[n] != null && vols[n] >= volAvg[n] * CFG.volMult);

  const isLong = crossBull && adxOk && volOk;
  const isShort = crossBear && adxOk && volOk;

  // Pine: entry = close[1], tức nến ngay trước nến tín hiệu
  const entry = closes[n - 1];
  const a = atrArr[n];
  const risk = a == null ? null : a * CFG.slMult;

  const levels =
    risk == null
      ? null
      : isShort
      ? {
          entry,
          sl: entry + risk,
          tp1: entry - risk * CFG.tp1Rr,
          tp2: entry - risk * CFG.tp2Rr,
          tp3: entry - risk * CFG.tp3Rr,
        }
      : {
          entry,
          sl: entry - risk,
          tp1: entry + risk * CFG.tp1Rr,
          tp2: entry + risk * CFG.tp2Rr,
          tp3: entry + risk * CFG.tp3Rr,
        };

  return {
    signal: isLong ? "long" : isShort ? "short" : null,
    levels,
    barTime: bars[n].datetime,
    barTs: bars[n].ts,
    debug: {
      close: closes[n],
      obv: Math.round(obv[n]),
      obvMa: obvMa[n] == null ? null : Math.round(obvMa[n]),
      obvHist: obvMa[n] == null ? null : Math.round(obv[n] - obvMa[n]),
      obvHistTruoc: obvMa[n - 1] == null ? null : Math.round(obv[n - 1] - obvMa[n - 1]),
      xuHuong: obvMa[n] == null ? "?" : obv[n] > obvMa[n] ? "Bull" : obv[n] < obvMa[n] ? "Bear" : "Neutral",
      atr: round(a, CFG.digits),
      adx: round(adxArr[n], 2),
      volumeNenNay: vols[n],
    },
  };
}

function round(v, d) {
  return v == null ? null : Number(v.toFixed(d));
}

function fmt(v) {
  return v.toFixed(CFG.digits);
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
    volume: parseFloat(v.volume ?? 0) || 0,
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
    `<i>OBV Confluence · nến ${barTime} UTC</i>`,
  ].join("\n");
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
      if (bars.length < CFG.maLen + 30) {
        results.push({ symbol, error: "Không đủ dữ liệu", bars: bars.length });
        continue;
      }

      // ── CHẨN ĐOÁN VOLUME ────────────────────────────────────
      // OBV chạy hoàn toàn bằng volume. Không có volume = không có tín hiệu.
      const volsAll = bars.map((b) => b.volume);
      const soNenCoVolume = volsAll.filter((v) => v > 0).length;
      const coVolume = soNenCoVolume > 0;
      const tyLeCoVolume = Math.round((soNenCoVolume / volsAll.length) * 100);

      if (!coVolume) {
        results.push({
          symbol,
          LOI_NGHIEM_TRONG: "Nguồn dữ liệu KHÔNG có volume — chỉ báo OBV không thể chạy",
          giaiThich:
            "OBV = cộng dồn(dấu × volume). Volume toàn bằng 0 nên OBV phẳng, không bao giờ cắt MA.",
          soNenCoVolume,
          tongSoNen: volsAll.length,
          volume5NenCuoi: volsAll.slice(-5),
          barsUsed: bars.length,
        });
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
          buildMessage(symbol, r.signal || "long", r.levels, r.barTime) +
            `\n\n⚠️ <i>Tin nhắn thử — không phải tín hiệu thật</i>`
        );
        sent = telegram?.ok === true;
      } else if (r.signal && !r.levels) {
        skipReason = "thiếu ATR";
      } else if (r.signal && !isFresh) {
        skipReason = "nến cũ, bỏ qua để tránh gửi trùng";
      } else if (r.signal) {
        telegram = await sendMessage(buildMessage(symbol, r.signal, r.levels, r.barTime));
        sent = telegram?.ok === true;
      }

      results.push({
        symbol,
        indicator: "OBV Signal Confluence",
        signal: r.signal,
        sent,
        skipReason,
        telegramError: telegram && !telegram.ok ? telegram.description : null,
        barTime: r.barTime,
        barAgeMin,
        isFresh,
        barsUsed: bars.length,
        coVolume,
        tyLeNenCoVolume: tyLeCoVolume + "%",
        ...(debugMode ? { debug: r.debug, levels: r.levels } : {}),
      });
    } catch (err) {
      console.error(`Lỗi với ${symbol}:`, err.message);
      results.push({ symbol, error: err.message });
    }
  }

  return res.status(200).json({ ok: true, checkedAt: new Date().toISOString(), results });
}
