const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = baileys;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";
// ضع رابط موقعك هنا لكي يرسل له الرسائل الواردة
const PHP_WEBHOOK_URL = "https://blue-crane-604835.hostingersite.com/whatsapp/webhook.php"; 

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_session_super');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false, // نمنع سحب التاريخ القديم جداً كي لا ينهار السيرفر
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            getMessage: async () => { return { conversation: 'hello' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCodeData = await QRCode.toDataURL(qr);
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                isConnected = false;
                if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                console.log('✅ WhatsApp Connected Successfully! (Pro Mode)');
            }
        });

        // 🌟 السر هنا: سحب الرسائل الواردة وإرسالها لموقعك PHP
        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return; // تجاهل رسائلك الخاصة

                const senderJid = msg.key.remoteJid;
                // إذا كانت رسالة نصية أو صورة فيها نص
                const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
                const pushName = msg.pushName || 'مستخدم';

                try {
                    // إرسال البيانات إلى Webhook الخاص بك في PHP
                    await fetch(PHP_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET },
                        body: JSON.stringify({
                            chatId: senderJid,
                            senderName: pushName,
                            messageText: text,
                            mediaType: msg.message.imageMessage ? 'image' : 'text'
                        })
                    });
                    console.log(`📩 تم تحويل رسالة جديدة من ${pushName} إلى المنصة بنجاح.`);
                } catch (err) {
                    console.error('❌ فشل إرسال الرسالة إلى الـ Webhook الخاص بك.');
                }
            }
        });

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (isConnected) return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل وجاهز!</h1></div>`);
    if (!qrCodeData) return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري التجهيز...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) return res.status(403).json({ success: false, error: 'Unauthorized' });
    next();
});

app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل بالسيرفر' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🌟 مسار الإرسال المطور (يدعم الصور، الفيديوهات، القروبات، والأفراد)
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'الرقم مفقود' });

    let rawTarget = decodeURIComponent(String(to).trim());
    let cleanId = rawTarget.replace(/[^0-9-]/g, ''); 
    
    // التمييز بين القروب (أطول من 17 رقم) والفرد (أقل)
    let target = (cleanId.length >= 17 || cleanId.includes('-')) ? `${cleanId}@g.us` : `${cleanId}@s.whatsapp.net`;

    try {
        console.log(`[جاري الإرسال] إلى: ${target} | نوع الميديا: ${mediaType || 'text'}`);

        if (target.endsWith('@g.us')) {
            try {
                await sock.groupMetadata(target);
                await sock.presenceSubscribe(target);
                await delay(1000);
            } catch (e) {
                return res.status(400).json({ success: false, error: 'الرقم ليس عضواً في القروب.' });
            }
        } else {
            // إذا كان الإرسال لفرد، نخبر الواتساب أننا نكتب رسالة (Typing...) لكسر الحظر
            await sock.presenceSubscribe(target);
            await sock.sendPresenceUpdate('composing', target);
            await delay(1500);
            await sock.sendPresenceUpdate('paused', target);
        }

        const sendPromise = (async () => {
            // 🌟 إرسال الصور أو الفيديوهات إذا توفر الرابط
            if (mediaType === 'image' && mediaUrl) {
                return await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message });
            } else if (mediaType === 'video' && mediaUrl) {
                return await sock.sendMessage(target, { video: { url: mediaUrl }, caption: message });
            } else {
                return await sock.sendMessage(target, { text: String(message) });
            }
        })();

        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 25000));
        const sentMsg = await Promise.race([sendPromise, timeoutPromise]);

        console.log(`✅ تم الإرسال بنجاح!`);
        res.json({ success: true, messageId: sentMsg?.key?.id });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message === 'TIMEOUT_ERROR' ? 'تأخر الرد' : e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
