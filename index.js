import 'dotenv/config';
import { Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import cron from 'node-cron';

// ======================
// CONFIG
// ======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in .env");
  process.exit(1);
}

if (!RAPIDAPI_KEY) {
  console.error("❌ Missing RAPIDAPI_KEY in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ======================
// DATABASE
// ======================
const db = new Database('subs.db');

db.prepare(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    username TEXT,
    last_video_id TEXT,
    UNIQUE(chat_id, username)
  )
`).run();

// ======================
// HELPERS
// ======================
function extractUsername(input) {
  if (!input) return null;
  return input
    .replace("https://www.tiktok.com/@", "")
    .replace("http://www.tiktok.com/@", "")
    .replace("@", "")
    .trim();
}

// 🔥 NEW API VERSION
async function getLatestVideo(username) {
  try {
    const res = await fetch(
      `https://tiktok-api6.p.rapidapi.com/user/videos?username=${username}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-rapidapi-host": "tiktok-api6.p.rapidapi.com",
          "x-rapidapi-key": RAPIDAPI_KEY
        }
      }
    );

    const data = await res.json();

    if (!data || !data.videos || data.videos.length === 0) {
      console.log(`⚠️ No videos found for @${username}`);
      return null;
    }

    const video = data.videos[0]; // most recent

    return {
      id: video.video_id,
      desc: video.description || "",
      link: video.unwatermarked_download_url
    };

  } catch (err) {
    console.log(`❌ API error for ${username}:`, err.message);
    return null;
  }
}

// ======================
// COMMANDS
// ======================
bot.start((ctx) => {
  ctx.reply(`🤖 TikTok Alert Bot Ready!

Commands:
➕ /add username_or_link
➖ /remove username
📋 /list

Example:
/add https://www.tiktok.com/@example
`);
});

bot.command('add', (ctx) => {
  const input = ctx.message.text.split(' ')[1];
  const username = extractUsername(input);

  if (!username) return ctx.reply("❌ Usage: /add username_or_link");

  try {
    db.prepare(`INSERT INTO subscriptions (chat_id, username) VALUES (?, ?)`)
      .run(ctx.chat.id, username);

    ctx.reply(`✅ Added @${username}`);
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      ctx.reply(`⚠️ Already subscribed to @${username}`);
    } else {
      ctx.reply("❌ Error adding subscription");
    }
  }
});

bot.command('remove', (ctx) => {
  const input = ctx.message.text.split(' ')[1];
  const username = extractUsername(input);

  if (!username) return ctx.reply("❌ Usage: /remove username");

  const result = db.prepare(`
    DELETE FROM subscriptions 
    WHERE chat_id = ? AND username = ?
  `).run(ctx.chat.id, username);

  if (result.changes > 0) {
    ctx.reply(`🗑 Removed @${username}`);
  } else {
    ctx.reply(`⚠️ Not subscribed to @${username}`);
  }
});

bot.command('list', (ctx) => {
  const subs = db.prepare(`
    SELECT username FROM subscriptions WHERE chat_id = ?
  `).all(ctx.chat.id);

  if (subs.length === 0) return ctx.reply("📭 No subscriptions yet.");

  const list = subs.map(s => `• @${s.username}`).join('\n');
  ctx.reply(`📋 Your subscriptions:\n${list}`);
});

// ======================
// CRON JOB
// ======================
cron.schedule('*/10 * * * *', async () => {
  console.log("🔄 Checking TikTok accounts...");

  const subs = db.prepare(`SELECT * FROM subscriptions`).all();

  for (const sub of subs) {
    const latest = await getLatestVideo(sub.username);
    if (!latest) continue;

    if (latest.id !== sub.last_video_id) {
      try {
        await bot.telegram.sendVideo(
          sub.chat_id,
          latest.link,
          {
            caption: `🔥 New TikTok from @${sub.username}\n${latest.desc || ''}`
          }
        );

        db.prepare(`
          UPDATE subscriptions 
          SET last_video_id = ? 
          WHERE id = ?
        `).run(latest.id, sub.id);

        console.log(`✅ Sent update for @${sub.username}`);
      } catch (err) {
        console.log("❌ Telegram send error:", err.message);
      }
    }
  }
});

// ======================
// START BOT
// ======================
bot.launch();
console.log("🚀 Bot is running...");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));