require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');

const app = express();
app.use(express.json());
const port = process.env.PORT || 3000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'change-this-secret';
const startupTime = Math.floor(Date.now() / 1000);

// ==========================================
// Command Queue (in-memory bridge)
// ==========================================
// pending: { id, chatId, text, timestamp }
// results: { id, output }
const pendingCommands = new Map();
const pendingResults  = new Map(); // id -> resolve callback

let cmdCounter = 0;
function newCmdId() { return `cmd_${++cmdCounter}_${Date.now()}`; }

// ==========================================
// AI Caller (Groq — for direct answers)
// ==========================================
const SYSTEM_PROMPT = `أنت وكيل ذكاء اصطناعي يعمل على نظام Windows. إذا كان الطلب سؤالاً معرفياً أجب مباشرة بـ [Answer].
إذا كان الطلب يتطلب تنفيذ أمر على حاسوب المستخدم أجب بـ [LOCAL_COMMAND] ثم الأمر فقط.

قواعد مهمة جداً:
- النظام هو Windows — استخدم أوامر PowerShell/CMD فقط.
- سطح المكتب يقع في: C:\\Users\\info_sob\\Desktop
- لإنشاء مجلد: mkdir "C:\\Users\\info_sob\\Desktop\\اسم المجلد"
- لإنشاء ملف: New-Item "C:\\path\\file.txt" -ItemType File
- لا تستخدم أوامر Linux مثل: mkdir ~/Desktop أو ls أو rm
- استخدم بدلاً منها: dir, del, copy, move, New-Item, Remove-Item
- إذا كان الاسم يحتوي على مسافة ضعه بين قوسين: mkdir "اسم به مسافة"
- لا تشرح، فقط اتبع التنسيق بدقة.`;

async function callAI(userMessage) {
  const res = await axios.post(
    process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1/chat/completions',
    {
      model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ]
    },
    { headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

// ==========================================
// Bridge API (consumed by Local Agent)
// ==========================================

// Auth middleware
function authCheck(req, res, next) {
  const secret = req.headers['x-bridge-secret'];
  if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  next();
}

// Local agent polls here for new commands
app.get('/api/pending', authCheck, (req, res) => {
  const commands = [...pendingCommands.values()];
  res.json(commands);
});

// Local agent posts result here
app.post('/api/result', authCheck, async (req, res) => {
  const { id, output, chatId } = req.body;
  const resolve = pendingResults.get(id);
  if (resolve) {
    resolve(output);
    pendingResults.delete(id);
    pendingCommands.delete(id);
  }
  res.json({ ok: true });
});

// Health check
app.get('/', (req, res) => res.send('☁️ Cloud Bot Bridge Online'));

// ==========================================
// Telegram Bot
// ==========================================
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) => ctx.reply(
  '☁️ Cloud Bot متصل!\n' +
  '• للأسئلة المعرفية: أجيب مباشرة\n' +
  '• للأوامر المحلية: تُرسل لجهازك\n' +
  '• اكتب /status لمعرفة حالة الجهاز'
));

bot.command('status', (ctx) => {
  const count = pendingCommands.size;
  ctx.reply(count === 0
    ? '✅ لا توجد أوامر معلقة — الجهاز المحلي متزامن'
    : `⏳ يوجد ${count} أمر(اً) معلق بانتظار الجهاز المحلي`
  );
});

bot.on('text', async (ctx) => {
  if (ctx.message.date < startupTime) return;
  if (ctx.message.text.startsWith('/')) return;

  const userMessage = ctx.message.text;
  const chatId = ctx.message.chat.id;

  await ctx.reply('⏳ جاري التحليل...');

  try {
    const aiResponse = await callAI(userMessage);

    if (aiResponse.includes('[LOCAL_COMMAND]')) {
      // Extract command
      const command = aiResponse.replace(/\[LOCAL_COMMAND\]/i, '').trim();
      const id = newCmdId();

      // Queue the command
      pendingCommands.set(id, { id, chatId, command, timestamp: Date.now() });
      await ctx.reply(`⚙️ إرسال الأمر للجهاز المحلي:\n\`${command}\`\n⏳ بانتظار التنفيذ...`, { parse_mode: 'Markdown' });

      // Wait for result (timeout: 60s)
      const output = await new Promise((resolve, reject) => {
        pendingResults.set(id, resolve);
        setTimeout(() => {
          if (pendingCommands.has(id)) {
            pendingCommands.delete(id);
            pendingResults.delete(id);
            reject(new Error('انتهت مهلة الانتظار (60 ثانية). تأكد من تشغيل العميل المحلي.'));
          }
        }, 60000);
      });

      const truncated = output.length > 3000 ? output.substring(0, 3000) + '\n...[Truncated]' : output;
      await ctx.reply(`✅ نتيجة التنفيذ:\n\`\`\`\n${truncated}\n\`\`\``, { parse_mode: 'Markdown' });

    } else {
      // Direct AI answer
      const answer = aiResponse.replace(/\[Answer\]/i, '').trim();
      await ctx.reply(`💡 ${answer}`);
    }
  } catch (e) {
    await ctx.reply(`❌ خطأ: ${e.message}`);
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('☁️ Cloud Bot running!'))
  .catch(err => console.error('Launch error:', err));

app.listen(port, () => console.log(`🌐 Bridge API on port ${port}`));
