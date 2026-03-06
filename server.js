const express = require("express");
const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── 保活：每14分钟 ping 自己，防止 Render 免费版休眠 ──────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
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

// ── 每日星象全局缓存（内存，按北京时间日期为 key）────────────────────
// { date: "2026-03-07", data: {...}, generatedAt: "..." }
let astroCache = null;

// 获取当前北京时间的日期字符串 YYYY-MM-DD
function getBeijingDate() {
  const now = new Date();
  // UTC+8
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bjTime.toISOString().slice(0, 10);
}

// 生成星象 prompt
function buildAstroPrompt() {
  const bjDate = getBeijingDate();
  const d = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
  const weekdays = ["周日","周一","周二","周三","周四","周五","周六"];
  const dateStr = `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日${weekdays[d.getUTCDay()]}`;

  return `今天是北京时间${dateStr}。请根据真实天文历法推算今日月相与行星能量，生成今日详细专业星象解读。

严格输出JSON，不要任何其他文字：
{
  "phase": "月相名称（娥眉月/上弦月/盈凸月/满月/亏凸月/下弦月/残月/新月之一）",
  "phase_degree": "月亮所在星座与度数，如「双鱼座14°」",
  "keyword": "今日总体能量关键词，3-5字",
  "guide": "今日总览一句话，20-28字，有诗意有温度",
  "sun_sign": "太阳当前所在星座，如「双鱼座」",
  "sun_note": "太阳能量简述，25-35字，说明太阳在该星座的能量特质与今日影响",
  "moon_sign": "月亮当前所在星座，如「天蝎座」",
  "moon_note": "月亮能量简述，25-35字，说明月亮在该星座的情绪与直觉影响",
  "rising_note": "上升点能量提示，20-30字，说明今日整体外在展现与行动方式",
  "key_planets": [
    {"planet": "水星", "state": "所在星座+顺/逆行", "influence": "30-40字，说明对思维/沟通/行动的具体影响"},
    {"planet": "金星", "state": "所在星座+顺/逆行", "influence": "30-40字，说明对感情/美/财的具体影响"},
    {"planet": "火星", "state": "所在星座+顺/逆行", "influence": "30-40字，说明对行动力/冲突/欲望的具体影响"}
  ],
  "key_aspect": "今日最重要的行星相位，如「太阳三分木星」，20-30字说明其影响",
  "overall_reading": "今日整体星象深度解读，150-200字，结合月相、太阳、月亮、主要行星状态及相位，描述今日整体能量场，语言专业典雅有温度，不使用Markdown格式",
  "dims": [
    {"name":"事业","pct":数字,"note":"35-45字，结合今日行星能量给出事业方面的具体指引，有实际建议"},
    {"name":"财运","pct":数字,"note":"35-45字，结合今日行星能量给出财运方面的具体指引，有实际建议"},
    {"name":"感情","pct":数字,"note":"35-45字，结合今日行星能量给出感情方面的具体指引，有实际建议"},
    {"name":"身心","pct":数字,"note":"35-45字，结合今日行星能量给出身心状态的具体指引，有实际建议"},
    {"name":"学业","pct":数字,"note":"35-45字，结合今日行星能量给出学业/学习方面的具体指引，有实际建议"}
  ],
  "yi": "今日宜，12字以内，结合星象特质给出具体行动",
  "ji": "今日忌，12字以内，结合星象特质给出具体提醒",
  "core_guide": "一句话核心指引，18-24字，有力量感，帮助用户带着清晰的方向度过今天"
}`;
}

// ── 每日星象接口（GET）────────────────────────────────────────────────
app.get("/astro", async (req, res) => {
  const todayBJ = getBeijingDate();
  const API_KEY = process.env.API_KEY;
  const MODEL   = process.env.MODEL || "deepseek-chat";

  // 命中缓存：直接返回
  if (astroCache && astroCache.date === todayBJ) {
    console.log(`[astro] cache hit for ${todayBJ}`);
    return res.json({ date: todayBJ, data: astroCache.data, cached: true });
  }

  // 未命中：调用 AI 生成
  console.log(`[astro] generating for ${todayBJ}...`);

  if (!API_KEY) {
    return res.status(500).json({ error: "API_KEY not configured" });
  }

  try {
    const prompt = buildAstroPrompt();
    const aiRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const raw = (aiData.choices?.[0]?.message?.content) || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // 存入全局缓存
    astroCache = { date: todayBJ, data: parsed, generatedAt: new Date().toISOString() };
    console.log(`[astro] generated and cached for ${todayBJ}`);

    return res.json({ date: todayBJ, data: parsed, cached: false });

  } catch (e) {
    console.error("[astro] generation failed:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── 主代理接口（POST /）用于塔罗占卜 ───────────────────────────────────
app.post("/", async (req, res) => {
  const API_KEY = process.env.API_KEY;
  const MODEL   = process.env.MODEL || "deepseek-chat";

  if (!API_KEY) {
    return res.status(500).json({ error: "API_KEY not configured" });
  }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ ...req.body, model: MODEL }),
    });

    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
