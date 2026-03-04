import express from "express";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000); // 10 minutes

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
const downloadCache = new Map();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// Simple health check
app.get("/health", (req, res) => res.send("OK"));

function extractTikTokUrl(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  const candidates = trimmed.match(/https?:\/\/[^\s]+/gi) || [];
  const direct = candidates.find((u) =>
    /(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(u)
  );
  if (!direct && /(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(trimmed)) {
    candidates.push(trimmed);
  }
  const raw = direct || candidates[0] || null;
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (!/(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(parsed.hostname)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tryTikwm(url) {
  const apiUrl = `https://www.tikwm.com/api/?hd=1&url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(apiUrl);
  // Prefer smaller "play" URL first for faster Telegram delivery.
  const download = data?.data?.play || data?.data?.hdplay || null;
  if (!download || data?.code !== 0) {
    const reason = data?.msg || data?.message || "No downloadable URL returned";
    throw new Error(`tikwm: ${reason}`);
  }
  return {
    provider: "tikwm",
    title: data?.data?.title || null,
    author: data?.data?.author?.unique_id || null,
    download,
    video: {
      url: download,
      noWatermark: download
    }
  };
}

async function tryTymbax(url) {
  const apiUrl = `https://tymbax.github.io/tiktok-api-proxy/tn?url=${encodeURIComponent(url)}`;
  const data = await fetchJsonWithTimeout(apiUrl);
  const download =
    data?.video?.noWatermark || data?.video?.url || data?.download || null;
  if (!download) {
    throw new Error("tymbax: No downloadable URL returned");
  }
  return {
    provider: "tymbax",
    ...data,
    download,
    video: {
      ...(data?.video || {}),
      url: data?.video?.url || download,
      noWatermark: data?.video?.noWatermark || download
    }
  };
}

async function resolveDownloadWithFallback(url) {
  const now = Date.now();
  const cached = downloadCache.get(url);
  if (cached && cached.expiresAt > now) {
    return { ...cached.value, cached: true };
  }

  const providers = [tryTikwm, tryTymbax];
  const errors = [];

  for (const provider of providers) {
    try {
      const result = await provider(url);
      const response = { ok: true, ...result, cached: false };
      downloadCache.set(url, { value: response, expiresAt: now + CACHE_TTL_MS });
      return response;
    } catch (providerErr) {
      const message = providerErr?.message || String(providerErr);
      errors.push(message);
    }
  }

  return {
    ok: false,
    error: "All download providers failed",
    details: errors
  };
}

// API that returns a downloadable TikTok video link with provider fallback.
app.get("/api/download", async (req, res) => {
  const url = extractTikTokUrl(req.query.url);
  if (!url) return res.status(400).json({ error: "Missing or invalid TikTok url" });

  try {
    const result = await resolveDownloadWithFallback(url);
    if (!result.ok) {
      return res.status(502).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error("Download error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch video" });
  }
});

// Serve Mini App index.html (public/index.html)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Telegram bot commands and handlers ---
bot.start((ctx) => {
  ctx.reply(
    "Hello! Send me a TikTok link and I'll try to download the video for you. Or click the button to open the Web App.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Open TikTok Downloader",
              web_app: { url: process.env.WEB_APP_URL || "https://example.com" } // will be replaced with your ngrok public URL
            }
          ]
        ]
      }
    }
  );
});

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const tiktokUrl = extractTikTokUrl(text);
  if (!tiktokUrl) {
    return ctx.reply("Please send a valid TikTok link.");
  }

  await ctx.reply("Trying to fetch video...");
  await ctx.sendChatAction("upload_video");

  try {
    // Resolve directly to avoid localhost/self-call networking issues.
    const data = await resolveDownloadWithFallback(tiktokUrl);
    if (!data?.ok) {
      const details = Array.isArray(data?.details) ? ` (${data.details.join(" | ")})` : "";
      throw new Error((data?.error || "Downloader API failed") + details);
    }

    // This depends on the API response. Here's an example path:
    // data now should contain a 'video' object with a 'noWatermark' or 'url' field
    const videoUrl = (data && (data.video?.noWatermark || data.video?.url || data.download)) || null;

    if (videoUrl) {
      try {
        await ctx.replyWithVideo(
          { url: videoUrl },
          { supports_streaming: true, caption: data?.cached ? "From cache (fast)." : undefined }
        );
      } catch (sendVideoErr) {
        // Fallback: send as document when Telegram cannot process as video quickly.
        await ctx.replyWithDocument(
          { url: videoUrl },
          { caption: "Video sent as file for faster delivery." }
        );
      }
    } else if (data && data.message) {
      ctx.reply("API response: " + data.message);
    } else {
      ctx.reply("Couldn't extract the video URL. Try a different link.");
    }
  } catch (err) {
    console.error("Bot handler error:", err);
    ctx.reply("Error while downloading. Check server logs.");
  }
});

// Launch Express + start bot (polling)
(async () => {
  try {
    await bot.launch(); // uses long polling - easier for dev
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log("Bot launched (polling).");
    });

    // graceful stop
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
  } catch (err) {
    console.error("Startup error:", err);
  }
})();
