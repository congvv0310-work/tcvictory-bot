const BOT_TOKEN = process.env.BOT_TOKEN;

async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot webhook đang chạy!");
  }
  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.trim();

      if (text === "/start") {
        await sendMessage(chatId, "Xin chào! Bot đã hoạt động 🚀");
      } else if (text === "/ping") {
        await sendMessage(chatId, "pong ✅");
      } else if (text === "/id") {
        await sendMessage(
          chatId,
          `Chat ID: ${chatId}\nLoại: ${message.chat.type}\nTên: ${message.chat.title || "-"}`
        );
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false });
  }
}
