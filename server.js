// بوت الرد على كومنتات صفحة فيسبوك + رسالة خاصة للعميل
// يحتاج Node.js 18 أو أحدث. مفيش أي مكتبات لازم تتثبت.

const http = require('http');
const crypto = require('crypto');

// ====== الإعدادات (بتتحط كـ Environment Variables) ======
const {
  PAGE_ACCESS_TOKEN, // توكن الصفحة (Long-lived)
  PAGE_ID,           // رقم الصفحة
  VERIFY_TOKEN,      // أي كلمة سر تختارها، وتحطها نفسها في Webhooks على Meta
  APP_SECRET,        // اختياري لكن مهم: App Secret من إعدادات التطبيق (للتأكد إن الطلب جاي من Meta)
  PORT = 3000,
} = process.env;

// نصوص الرد (عدّلها زي ما تحب)
const PUBLIC_REPLY =
  process.env.PUBLIC_REPLY || 'شكرًا على تعليقك 🌷 بعتنالك رسالة خاصة.';
const PRIVATE_REPLY =
  process.env.PRIVATE_REPLY || 'أهلًا بيك! شكرًا على تواصلك معانا، تحب نساعدك في إيه؟';

// true = يرد كمان على الردود اللي جوه الكومنتات (مش بس الكومنتات الأساسية)
const REPLY_TO_REPLIES = false;

const GRAPH = 'https://graph.facebook.com/v25.0';

for (const [k, v] of Object.entries({ PAGE_ACCESS_TOKEN, PAGE_ID, VERIFY_TOKEN })) {
  if (!v) {
    console.error(`Missing environment variable: ${k}`);
    process.exit(1);
  }
}

// ====== منع الرد مرتين على نفس الكومنت (فيسبوك ساعات بيبعت الإشعار أكتر من مرة) ======
const seen = new Set();
function alreadyHandled(id) {
  if (seen.has(id)) return true;
  if (seen.size > 5000) seen.clear();
  seen.add(id);
  return false;
}

// ====== نداء Graph API ======
async function graphPost(path, body) {
  try {
    const res = await fetch(`${GRAPH}/${path}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error('Graph error on', path, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error('Network error on', path, err.message);
    return null;
  }
}

// ====== معالجة الكومنت ======
async function handleComment(v) {
  if (!v || v.item !== 'comment' || v.verb !== 'add') return;
  if (v.from && v.from.id === PAGE_ID) return; // كومنت من الصفحة نفسها (عشان متردش على نفسها)
  if (!REPLY_TO_REPLIES && v.parent_id && v.parent_id !== v.post_id) return; // رد جوه كومنت
  if (alreadyHandled(v.comment_id)) return;

  console.log('New comment:', v.comment_id, '-', (v.message || '').slice(0, 60));

  // 1) رد علني على الكومنت
  await graphPost(`${v.comment_id}/comments`, { message: PUBLIC_REPLY });

  // 2) رسالة خاصة لصاحب الكومنت (رسالة واحدة بس، خلال 7 أيام من الكومنت)
  await graphPost(`${PAGE_ID}/messages`, {
    recipient: { comment_id: v.comment_id },
    message: { text: PRIVATE_REPLY },
  });
}

// ====== التأكد إن الطلب جاي من Meta ======
function validSignature(raw, header) {
  if (!APP_SECRET) return true; // لو مش محطوط، متتحققش
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ====== السيرفر ======
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname !== '/webhook') {
    res.writeHead(200);
    return res.end('Bot is running');
  }

  // Meta بتبعت GET مرة واحدة للتحقق وقت ربط الـ Webhook
  if (req.method === 'GET') {
    if (
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === VERIFY_TOKEN
    ) {
      res.writeHead(200);
      return res.end(url.searchParams.get('hub.challenge'));
    }
    res.writeHead(403);
    return res.end();
  }

  // الإشعارات الفعلية
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);

      if (!validSignature(raw, req.headers['x-hub-signature-256'])) {
        res.writeHead(403);
        return res.end();
      }

      // لازم نرد 200 بسرعة، وبعدين نشتغل
      res.writeHead(200);
      res.end('EVENT_RECEIVED');

      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (body.object !== 'page') return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'feed') {
            handleComment(change.value).catch((e) => console.error(e));
          }
        }
      }
    });
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
