// api/check.js — Kiểm tra dữ liệu thô Twelve Data trả về (nhất là volume)
// Dùng 1 lần để quyết định kiến trúc, sau đó có thể xoá.

const TD_API_KEY = process.env.TD_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "";

export default async function handler(req, res) {
  if (CRON_SECRET) {
    const key = req.headers["x-cron-key"] || req.query?.key;
    if (key !== CRON_SECRET) {
      return res.status(401).json({ ok: false, reason: "unauthorized" });
    }
  }

  const symbol = req.query?.symbol || "XAU/USD";

  try {
    const url =
      `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
      `&interval=1h&outputsize=20&order=DESC&timezone=UTC&apikey=${TD_API_KEY}`;

    const json = await (await fetch(url)).json();

    if (json.status === "error" || !Array.isArray(json.values)) {
      return res.status(200).json({ ok: false, error: json.message || "lỗi không rõ" });
    }

    const vols = json.values.map((v) => parseFloat(v.volume ?? 0));
    const coVolume = vols.some((v) => v > 0);

    return res.status(200).json({
      ok: true,
      symbol,
      coVolume,
      ketLuan: coVolume
        ? "Có volume — dùng được OBV, MFI, Squeeze theo bản gốc"
        : "KHÔNG có volume — phải sửa hoặc bỏ các chỉ báo phụ thuộc volume",
      volume20NenGanNhat: vols,
      nenMoiNhat: json.values[0],
      exchange: json.meta?.exchange,
      currency: json.meta?.currency,
    });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
