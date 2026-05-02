import 'dotenv/config';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';
import sharp from 'sharp';
import { Input, Telegraf } from 'telegraf';
import Database from 'better-sqlite3';
import cron from 'node-cron';

const execFileAsync = promisify(execFile);

// ======================
// CONFIG
// ======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_OVERLAY_FONT_PATH = path.join(MODULE_DIR, 'NotoSans-Bold.ttf');
const OVERLAY_FONT_CANDIDATES = [
  process.env.OVERLAY_FONT_PATH,
  PROJECT_OVERLAY_FONT_PATH,
  'C:\\Windows\\Fonts\\arialbd.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
].filter(Boolean);

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

db.prepare(`
  CREATE TABLE IF NOT EXISTS caption_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    template TEXT NOT NULL
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY,
    overlay_name TEXT
  )
`).run();

db.prepare(`
  UPDATE subscriptions
  SET chat_id = substr(chat_id, 1, length(chat_id) - 2)
  WHERE chat_id LIKE '%.0'
`).run();

db.prepare(`
  UPDATE caption_templates
  SET chat_id = substr(chat_id, 1, length(chat_id) - 2)
  WHERE chat_id LIKE '%.0'
`).run();

db.prepare(`
  UPDATE chat_settings
  SET chat_id = substr(chat_id, 1, length(chat_id) - 2)
  WHERE chat_id LIKE '%.0'
`).run();

// ======================
// HELPERS
// ======================
function normalizeChatId(value) {
  return String(value).replace(/\.0$/, '');
}

function getChatId(ctx) {
  return normalizeChatId(ctx.chat?.id ?? ctx.message?.chat?.id ?? ctx.channelPost?.chat?.id);
}

function getMessageText(ctx) {
  return ctx.message?.text || ctx.channelPost?.text || ctx.editedMessage?.text || ctx.editedChannelPost?.text || '';
}

function getCommandArgs(ctx) {
  return getMessageText(ctx).split(' ').slice(1).join(' ').trim();
}

function getCommandName(ctx) {
  const text = getMessageText(ctx).trim();
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/);
  return match ? match[1].toLowerCase() : null;
}

function getFontMimeType(fontPath) {
  const extension = path.extname(fontPath).toLowerCase();

  switch (extension) {
    case '.otf':
      return { mimeType: 'font/otf', format: 'opentype' };
    case '.woff':
      return { mimeType: 'font/woff', format: 'woff' };
    case '.woff2':
      return { mimeType: 'font/woff2', format: 'woff2' };
    case '.ttf':
    default:
      return { mimeType: 'font/ttf', format: 'truetype' };
  }
}

async function findFirstExistingPath(paths) {
  for (const candidatePath of paths) {
    try {
      await fs.access(candidatePath);
      return candidatePath;
    } catch {
      // Continue until a usable font file is found.
    }
  }

  return null;
}

let overlayFontPromise;

async function getOverlayFont() {
  if (!overlayFontPromise) {
    overlayFontPromise = (async () => {
      const fontPath = await findFirstExistingPath(OVERLAY_FONT_CANDIDATES);

      if (!fontPath) {
        throw new Error(`No overlay font file found. Checked: ${OVERLAY_FONT_CANDIDATES.join(', ')}`);
      }

      const fontBuffer = await fs.readFile(fontPath);
      const { mimeType, format } = getFontMimeType(fontPath);

      console.log(`🔤 Using overlay font: ${fontPath}`);

      return {
        fontPath,
        css: `
          <style>
            @font-face {
              font-family: 'ClippingBotOverlay';
              src: url("data:${mimeType};base64,${fontBuffer.toString('base64')}") format('${format}');
              font-weight: 700;
              font-style: normal;
            }
          </style>
        `
      };
    })();
  }

  return overlayFontPromise;
}

function extractUsername(input) {
  if (!input) return null;
  return input
    .replace("https://www.tiktok.com/@", "")
    .replace("http://www.tiktok.com/@", "")
    .replace("@", "")
    .trim();
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function applyTemplateVariables(template, payload) {
  return template
    .replace(/\{username\}/gi, `@${payload.username}`)
    .replace(/\{description\}/gi, payload.description || '');
}

function extractHashtags(text) {
  const matches = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set(matches.map((tag) => tag.trim()))];
}

function finalizeCaption(caption, template) {
  const templateHashtags = extractHashtags(template);
  const captionWithoutHashtags = caption.replace(/\s*#[\p{L}\p{N}_]+/gu, '').trim();

  if (templateHashtags.length === 0) {
    return caption.trim();
  }

  return `${captionWithoutHashtags}\n\n${templateHashtags.join(' ')}`.trim();
}

function getOverlayName(chatId) {
  return db.prepare(`SELECT overlay_name FROM chat_settings WHERE chat_id = ?`).get(normalizeChatId(chatId))?.overlay_name || null;
}

function setOverlayName(chatId, overlayName) {
  db.prepare(`
    INSERT INTO chat_settings (chat_id, overlay_name)
    VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET overlay_name = excluded.overlay_name
  `).run(normalizeChatId(chatId), overlayName);
}

function pickCaptionTemplate(chatId) {
  return db.prepare(`
    SELECT template
    FROM caption_templates
    WHERE chat_id = ?
    ORDER BY RANDOM()
    LIMIT 1
  `).get(normalizeChatId(chatId))?.template || null;
}

async function refreshCaption(chatId, payload) {
  const template = pickCaptionTemplate(chatId);
  const fallbackCaption = template
    ? applyTemplateVariables(template, payload)
    : `🔥 New TikTok from @${payload.username}${payload.description ? `\n${payload.description}` : ''}`;

  if (!template || !OPENAI_API_KEY) {
    return finalizeCaption(fallbackCaption, template || '');
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.9,
        max_tokens: 160,
        messages: [
          {
            role: 'system',
            content: 'You rewrite Telegram post captions. Keep them concise, natural, and ready to post. Preserve the template\'s hashtag strategy, and place all hashtags at the very bottom of the caption. Return only the final caption text.'
          },
          {
            role: 'user',
            content: [
              `Refresh this caption template into a fresh Telegram caption: ${template}`,
              `Creator: @${payload.username}`,
              `TikTok description: ${payload.description || 'No description provided.'}`,
              `Template hashtags that must stay at the bottom: ${extractHashtags(template).join(' ') || 'none'}`,
              'Preserve the template\'s tone, but vary the wording.'
            ].join('\n')
          }
        ]
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.log(`❌ OpenAI error: ${res.status} ${errorText}`);
      return finalizeCaption(fallbackCaption, template);
    }

    const data = await res.json();
    const caption = data.choices?.[0]?.message?.content?.trim();

    return finalizeCaption(caption || fallbackCaption, template);
  } catch (err) {
    console.log('❌ Caption refresh error:', err.message);
    return finalizeCaption(fallbackCaption, template);
  }
}

async function downloadFile(url, targetPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed with status ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
}

async function createOverlayImage(label, overlayPath) {
  const safeLabel = label.startsWith('@') ? label : `@${label}`;
  const width = Math.max(170, safeLabel.length * 18 + 28);
  const overlayFont = await getOverlayFont();
  const svg = `
    <svg width="${width}" height="64" viewBox="0 0 ${width} 64" xmlns="http://www.w3.org/2000/svg">
      ${overlayFont.css}
      <rect x="0" y="0" width="${width}" height="64" rx="18" ry="18" fill="white" fill-opacity="0.96" />
      <text x="${width / 2}" y="42" text-anchor="middle" font-family="ClippingBotOverlay" font-size="28" font-weight="700" fill="black">${escapeXml(safeLabel)}</text>
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(overlayPath);
  console.log(`🖼 Overlay image created for ${safeLabel} at ${overlayPath}`);
}

async function prepareVideoForTelegram(chatId, videoUrl) {
  const normalizedChatId = normalizeChatId(chatId);
  const overlayName = getOverlayName(normalizedChatId);

  console.log(`🎬 Preparing video for chat ${normalizedChatId}. Overlay name: ${overlayName || 'not set'}`);

  if (!overlayName) {
    console.log(`ℹ️ No overlay configured for chat ${normalizedChatId}. Sending original video.`);
    return {
      video: videoUrl,
      cleanup: async () => {}
    };
  }

  if (!ffmpegPath) {
    console.log('❌ FFmpeg binary is not available. Sending original video.');
    return {
      video: videoUrl,
      cleanup: async () => {}
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clippingbot-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const overlayPath = path.join(tempDir, 'overlay.png');
  const outputPath = path.join(tempDir, 'output.mp4');

  try {
    console.log(`⬇️ Downloading source video for chat ${normalizedChatId} to ${inputPath}`);
    await downloadFile(videoUrl, inputPath);
    await createOverlayImage(overlayName, overlayPath);
    console.log(`🎞 Running FFmpeg overlay for chat ${normalizedChatId}`);

    const ffmpegResult = await execFileAsync(ffmpegPath, [
      '-y',
      '-i', inputPath,
      '-i', overlayPath,
      '-filter_complex', '[0:v:0][1:v:0]overlay=20:(H-h)*0.62:format=auto[v]',
      '-map', '[v]',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ]);

    console.log(`✅ FFmpeg overlay complete for chat ${normalizedChatId}. Output: ${outputPath}`);
    if (ffmpegResult.stderr?.trim()) {
      console.log(ffmpegResult.stderr.trim());
    }

    return {
      video: Input.fromLocalFile(outputPath),
      cleanup: async () => {
        console.log(`🧹 Cleaning up temp files for chat ${normalizedChatId}`);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    };
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log(`❌ FFmpeg processing error for chat ${normalizedChatId}:`, err.message);
    if (err.stderr?.trim()) {
      console.log(err.stderr.trim());
    }

    return {
      video: videoUrl,
      cleanup: async () => {}
    };
  }
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
✍️ /addcaption your caption template
🧠 /captions
🏷 /setname name

Example:
/add https://www.tiktok.com/@example
`);
});

const commandHandlers = {};

commandHandlers.add = (ctx) => {
  const input = getCommandArgs(ctx);
  const username = extractUsername(input);
  const chatId = getChatId(ctx);

  if (!username) return ctx.reply("❌ Usage: /add username_or_link");

  try {
    db.prepare(`INSERT INTO subscriptions (chat_id, username) VALUES (?, ?)`)
      .run(chatId, username);

    ctx.reply(`✅ Added @${username} for this chat.`);
  } catch (err) {
    if (err.message.includes("UNIQUE")) {
      ctx.reply(`⚠️ Already subscribed to @${username} in this chat.`);
    } else {
      ctx.reply("❌ Error adding subscription");
    }
  }
};

commandHandlers.remove = (ctx) => {
  const input = getCommandArgs(ctx);
  const username = extractUsername(input);
  const chatId = getChatId(ctx);

  if (!username) return ctx.reply("❌ Usage: /remove username");

  const result = db.prepare(`
    DELETE FROM subscriptions 
    WHERE chat_id = ? AND username = ?
  `).run(chatId, username);

  if (result.changes > 0) {
    ctx.reply(`🗑 Removed @${username}`);
  } else {
    ctx.reply(`⚠️ Not subscribed to @${username}`);
  }
};

commandHandlers.list = (ctx) => {
  const subs = db.prepare(`
    SELECT username FROM subscriptions WHERE chat_id = ?
  `).all(getChatId(ctx));

  if (subs.length === 0) return ctx.reply("📭 No subscriptions yet.");

  const list = subs.map(s => `• @${s.username}`).join('\n');
  ctx.reply(`📋 Your subscriptions:\n${list}`);
};

commandHandlers.addcaption = (ctx) => {
  const template = getCommandArgs(ctx);

  if (!template) {
    return ctx.reply('❌ Usage: /addcaption your caption template');
  }

  db.prepare(`INSERT INTO caption_templates (chat_id, template) VALUES (?, ?)`)
    .run(getChatId(ctx), template);

  ctx.reply('✅ Caption template added for this chat.');
};

commandHandlers.captions = (ctx) => {
  const templates = db.prepare(`
    SELECT id, template
    FROM caption_templates
    WHERE chat_id = ?
    ORDER BY id ASC
  `).all(getChatId(ctx));

  if (templates.length === 0) {
    return ctx.reply('📭 No caption templates set for this chat.');
  }

  const message = templates
    .map((item) => `${item.id}. ${item.template}`)
    .join('\n\n');

  ctx.reply(`🧠 Caption templates for this chat:\n\n${message}`);
};

commandHandlers.setname = (ctx) => {
  const rawName = getCommandArgs(ctx);

  if (!rawName) {
    return ctx.reply('❌ Usage: /setname name');
  }

  if (rawName.toLowerCase() === 'off') {
    setOverlayName(getChatId(ctx), null);
    return ctx.reply('✅ Name overlay disabled for this chat.');
  }

  const normalizedName = rawName.replace(/^@+/, '').trim();

  if (!normalizedName) {
    return ctx.reply('❌ Usage: /setname name');
  }

  setOverlayName(getChatId(ctx), normalizedName);
  ctx.reply(`✅ Overlay name set to @${normalizedName} for this chat.`);
};

for (const [command, handler] of Object.entries(commandHandlers)) {
  bot.command(command, handler);
}

bot.on('channel_post', (ctx, next) => {
  const command = getCommandName(ctx);
  const handler = command ? commandHandlers[command] : null;

  if (!handler) {
    return next();
  }

  return handler(ctx);
});

// ======================
// CRON JOB
// ======================
cron.schedule('*/20 * * * *', async () => {
  console.log("🔄 Checking TikTok accounts...");

  const subs = db.prepare(`SELECT * FROM subscriptions`).all();

  for (const sub of subs) {
    const latest = await getLatestVideo(sub.username);
    if (!latest) continue;

    if (latest.id !== sub.last_video_id) {
      console.log(`🆕 New video detected for @${sub.username} in chat ${normalizeChatId(sub.chat_id)}: ${latest.id}`);
      const caption = await refreshCaption(sub.chat_id, {
        username: sub.username,
        description: latest.desc || ''
      });

      const preparedVideo = await prepareVideoForTelegram(sub.chat_id, latest.link);

      try {
        await bot.telegram.sendVideo(
          sub.chat_id,
          preparedVideo.video,
          {
            caption
          }
        );

        db.prepare(`
          UPDATE subscriptions 
          SET last_video_id = ? 
          WHERE id = ?
        `).run(latest.id, sub.id);

        console.log(`✅ Sent update for @${sub.username} in chat ${normalizeChatId(sub.chat_id)}`);
      } catch (err) {
        console.log("❌ Telegram send error:", err.message);
      } finally {
        await preparedVideo.cleanup();
      }
    }
  }
});

// ======================
// START BOT
// ======================
bot.launch({
  allowedUpdates: ['message', 'channel_post']
});
console.log("🚀 Bot is running...");

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));