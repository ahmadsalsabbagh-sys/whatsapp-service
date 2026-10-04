const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore } = baileys;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";

let sock = null;
let qrCodeData = null;
let isConnected = false;

const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });
const groupCache = new Map();

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_session_v2');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Social Tech Hub", "Chrome", "20.0.04"],
            cachedGroupMetadata: async (jid) => groupCache.get(jid),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            getMessage: async (key) => {
                if (store) {
                    const msg = await store.loadMessage(key.remoteJid, key.id);
                    return msg?.message || undefined;
                }
                return { conversation: 'hello' };
            }
        });

        store.bind(sock.ev);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCodeData = await QRCode.toDataURL(qr);
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                isConnected = false;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                console.log('✅ WhatsApp Connected Successfully!');
                
                try {
                    const participating = await sock.groupFetchAllParticipating();
                    for (const [id, meta] of Object.entries(participating)) {
                        groupCache.set(id, meta);
                    }
                    console.log(`⚡ تم تسريع ${groupCache.size} قروب بنجاح!`);
                } catch (e) {}
            }
        });

        sock.ev.on('groups.update', async (events) => {
            for (const event of events) {
                try {
                    const meta = await sock.groupMetadata(event.id);
                    groupCache.set(event.id, meta);
                } catch (e) {}
            }
        });

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1></div>`);
    }
    if (!qrCodeData) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري تجهيز كود الـ QR...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    }
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل بالسيرفر' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [id, meta] of Object.entries(groups)) {
            groupCache.set(id, meta);
        }
        const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🚀 مسار الإرسال المحمي ضد التعليق والـ Timeout
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(500).json({ success: false, error: 'الواتساب غير متصل حالياً بالسيرفر' });
    }

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'البيانات غير مكتملة' });

    // فلترة المعرف واستخراج الأرقام فقط
    let rawTarget = decodeURIComponent(String(to).trim());
    let cleanId = rawTarget.replace(/[^0-9-]/g, ''); 
    
    let target = '';
    if (cleanId.length >= 17 || cleanId.includes('-')) {
        target = `${cleanId}@g.us`;
    } else {
        target = `${cleanId}@s.whatsapp.net`;
    }

    try {
        console.log(`[جاري الإرسال] محاولة الإرسال إلى: ${target}`);

        // 🛡️ درع الحماية: فحص صارم للقروبات قبل الإرسال لمنع التعليق
        if (target.endsWith('@g.us')) {
            let meta = groupCache.get(target);
            if (!meta) {
                try {
                    console.log(`⏳ جلب بيانات القروب من سيرفر واتساب: ${target}`);
                    meta = await sock.groupMetadata(target);
                    groupCache.set(target, meta);
                } catch(e) {
                    // إذا لم يجد القروب، يتم الرفض فوراً بدلاً من تعليق السيرفر
                    console.error(`❌ رفض الإرسال: البوت ليس عضواً في القروب ${target}`);
                    return res.status(400).json({ 
                        success: false, 
                        error: `عذراً، رقم الواتساب المربوط بالمنصة ليس عضواً في هذا القروب، أو المعرف غير صحيح.` 
                    });
                }
            }
        }

        // ⏱️ الإرسال الفعلي مع حد أقصى 15 ثانية فقط
        const sendPromise = (async () => {
            if (mediaType === 'image' && mediaUrl) {
                return await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message });
            } else {
                return await sock.sendMessage(target, { text: String(message) });
            }
        })();

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 15000)
        );

        const sentMsg = await Promise.race([sendPromise, timeoutPromise]);

        console.log(`✅ تم التسليم بنجاح! ID: ${sentMsg?.key?.id}`);
        res.json({ success: true, messageId: sentMsg?.key?.id });

    } catch (e) {
        console.error(`❌ فشل الإرسال الفعلي:`, e.message);
        
        let errorMessage = e.message;
        if (errorMessage === 'TIMEOUT_ERROR') {
            errorMessage = 'تعذر الوصول لخوادم واتساب حالياً، يرجى المحاولة بعد قليل.';
        }
        
        res.status(500).json({ success: false, error: errorMessage });
    }
});

app.post('/groups/create', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });
    const { name, participants } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'اسم القروب مطلوب' });

    try {
        let users = [];
        if (participants && Array.isArray(participants)) {
            users = participants.map(p => p.includes('@') ? p : `${p.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
        }
        const group = await sock.groupCreate(name, users);
        groupCache.set(group.id, group);
        res.json({ success: true, group: { id: group.id, name: group.subject } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
