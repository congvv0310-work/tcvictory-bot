// api/signal.js — Nhận alert từ TradingView, gửi tín hiệu lên nhóm Telegram
// Biến môi trường cần có trên Vercel: BOT_TOKEN, GROUP_ID
// Tùy chọn: WEBHOOK_SECRET (khuyến nghị, xem hướng dẫn)

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Chỉ nhận khung H1. Muốn nhận thêm khung khác thì thêm vào mảng, vd: ["60","240"]
const ALLOWED_TF = ["60"];

// Có gửi thông báo đóng lệnh (closelong/closeshort) lên nhóm không?
const SEND_CLOSE_SIGNAL = false;

async function sendMessage(text) {
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
  return res.json();
}

// Đổi mã khung thời gian của TradingView sang tên dễ đọc
function tfLabel(tf) {
  const map = {
    "1": "M1", "3": "M3", "5": "M5", "15": "M15", "30": "M30",
    "60": "H1", "120": "H2", "240": "H4",
    "D": "D1", "1D": "D1", "W": "W1", "M": "MN",
  };
  return map[String(tf)] || String(tf);
}

function buildMessage(d) {
  const dir = String(d.direction || "").toLowerCase();
  const isBuy = dir === "long";
  const side = isBuy ? "BUY" : "SELL";
  const icon = isBuy ? "🟢" : "🔴";

  const lines = [
    `${icon} <b>${side}</b> — <b>${d.ticker || "?"}</b> (${tfLabel(d.tf)})`,
    ``,
    `Entry: <code>${d.entry}</code>`,
    `SL: <code>${d.sl}</code>`,
    `TP1: <code>${d.tp1}</code>`,
    `TP2: <code>${d.tp2}</code>`,
    `TP3: <code>${d.tp3}</code>`,
  ];

  if (d.source) lines.push(``, `<i>Nguồn: ${d.source}</i>`);
  return lines.join("\n");
}

function buildCloseMessage(d) {
  const dir = String(d.direction || "").toLowerCase();
  const what = dir === "closelong" ? "LONG" : "SHORT";
  return `⚪️ <b>ĐÓNG ${what}</b> — <b>${d.ticker || "?"}</b> (${tfLabel(d.tf)})`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Signal endpoint đang chạy!");
  }

  try {
    // TradingView có thể gửi body dạng chuỗi, cần parse thủ công
    let data = req.body;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        console.error("Body không phải JSON hợp lệ:", data);
        return res.status(200).json({ ok: false, reason: "invalid_json" });
      }
    }
    if (!data || typeof data !== "object") {
      return res.status(200).json({ ok: false, reason: "empty_body" });
    }

    // Kiểm tra mã bí mật (nếu có cấu hình)
    if (WEBHOOK_SECRET && data.secret !== WEBHOOK_SECRET) {
      console.warn("Sai secret, bỏ qua request");
      return res.status(200).json({ ok: false, reason: "bad_secret" });
    }

    // Lọc khung thời gian — chỉ lấy H1
    if (!ALLOWED_TF.includes(String(data.tf))) {
      console.log("Bỏ qua khung:", data.tf);
      return res.status(200).json({ ok: false, reason: "tf_filtered" });
    }

    const dir = String(data.direction || "").toLowerCase();

    if (dir === "long" || dir === "short") {
      await sendMessage(buildMessage(data));
    } else if (dir === "closelong" || dir === "closeshort") {
      if (SEND_CLOSE_SIGNAL) await sendMessage(buildCloseMessage(data));
    } else {
      console.log("Direction không nhận dạng được:", dir);
      return res.status(200).json({ ok: false, reason: "unknown_direction" });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Lỗi xử lý signal:", err);
    return res.status(200).json({ ok: false });
  }
}
