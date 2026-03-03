const express = require("express");
const app = express();
app.use(express.json());

// ── CORS：允许你的 Netlify 域名访问 ──────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── 保活：每14分钟 ping 自己，防止 Render 免费版休眠 ────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL; // Render 自动注入
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/ping`);
      console.log("[keepalive] pinged", new Date().toISOString());
    } catch (e) {
      console.warn("[keepalive] failed:", e.message);
    }
  }, 14 * 60 * 1000);
}

app.get("/ping", (req, res) => res.json({ ok: true }));

// ── 主代理接口 ───────────────────────────────────────────────────────
app.post("/", async (req, res) => {
  const API_KEY = process.env.API_KEY;
  const MODEL   = process.env.MODEL || "deepseek-chat";

  if (!API_KEY) {
    return res.status(500).json({ error: "API_KEY not configured" });
  }

  // 根据 MODEL 判断调用哪个 API
  const isAnthropic = MODEL.startsWith("claude");

  try {
    let response, data;

    if (isAnthropic) {
      // ── Anthropic Claude ─────────────────────────────────────────
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":         "application/json",
          "x-api-key":            API_KEY,
          "anthropic-version":    "2023-06-01",
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: req.body.max_tokens || 8192,
          messages:   req.body.messages,
        }),
      });
      data = await response.json();

      // 统一转成前端期望的 OpenAI 格式
      const text = data?.content?.[0]?.text || "解读生成失败，请重试。";
      return res.json({
        choices: [{ message: { content: text } }],
      });

    } else {
      // ── DeepSeek ─────────────────────────────────────────────────
      response = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: req.body.max_tokens || 8192,
          messages:   req.body.messages,
        }),
      });
      data = await response.json();
      return res.json(data);
    }

  } catch (err) {
    console.error("[proxy error]", err.message);
    return res.status(502).json({ error: "Upstream API error", detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tarot proxy running on port ${PORT}`));
