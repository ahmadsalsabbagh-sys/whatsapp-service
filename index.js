const express = require('express');
const http = require('http');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = baileys;

const app = express();
const server = http.createServer(app);

// تهيئة Socket.IO للريال تايم اللحظي
let io = null;
try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: '*' } });
} catch (e) {
    console.log('Socket.io library not installed yet, falling back to HTTP');
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";
const PHP_WEBHOOK_URL = "https://blue-crane-604835.hostingersite.com/whatsapp/webhook.php"; 

let sock = null;
let qrCodeData = null;
let isConnected = false;

// متجر جهات الاتصال في الذاكرة
const contactsStore = {};

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_session_super');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['SocialTech WA', 'Chrome', '120.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            getMessage: async () => ({ conversation: 'hello' })
        });

        sock.ev.on('creds.update', saveCreds);

        // التقاط جهات الاتصال ومزامنتها
        const updateContacts = (list) => {
            if (Array.isArray(list)) {
                for (const c of list) {
                    if (c.id && c.id.endsWith('@s.whatsapp.net')) {
                        contactsStore[c.id] = { ...(contactsStore[c.id] || {}), ...c };
                    }
                }
            }
        };

        sock.ev.on('contacts.set', ({ contacts }) => updateContacts(contacts));
        sock.ev.on('contacts.upsert', (contacts) => updateContacts(contacts));
        sock.ev.on('contacts.update', (updates) => updateContacts(updates));

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
                console.log('✅ WhatsApp Connected Successfully!');
            }
        });

        // مراقبة قراءة وتسليم الرسائل
        sock.ev.on('messages.update', async updates => {
            for (const update of updates) {
                if (update.update?.status) {
                    const statusVal = update.update.status;
                    let statusStr = 'sent';
                    if (statusVal === 3 || statusVal === 'DELIVERY_ACK') statusStr = 'delivered';
                    if (statusVal === 4 || statusVal === 'READ') statusStr = 'read';

                    if (io) {
                        io.emit('status_update', {
                            messageId: update.key.id,
                            chatId: update.key.remoteJid,
                            status: statusStr
                        });
                    }

                    fetch(PHP_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET },
                        body: JSON.stringify({
                            event: 'status_update',
                            messageId: update.key.id,
                            chatId: update.key.remoteJid,
                            status: statusStr
                        })
                    }).catch(() => {});
                }
            }
        });

        // استقبال الرسائل والوسائط
        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const senderJid = msg.key.remoteJid;
                const isGroup = senderJid.endsWith('@g.us');
                
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || '';
                             
                const pushName = msg.pushName || 'مستخدم';

                let profilePic = null;
                try {
                    const fetchPic = sock.profilePictureUrl(senderJid, 'image');
                    const timeout = new Promise((_, r) => setTimeout(() => r(null), 2000));
                    profilePic = await Promise.race([fetchPic, timeout]).catch(() => null);
                } catch (error) { profilePic = null; }

                let mediaBase64 = null;
                let mediaType = 'text';
                
                try {
                    if (msg.message.stickerMessage) {
                        mediaType = 'sticker';
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
                        mediaBase64 = buffer.toString('base64');
                    } else if (msg.message.imageMessage || msg.message.videoMessage) {
                        mediaType = msg.message.imageMessage ? 'image' : 'video';
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
                        mediaBase64 = buffer.toString('base64');
                    } else if (msg.message.audioMessage) {
                        mediaType = 'audio';
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console, reuploadRequest: sock.updateMediaMessage });
                        mediaBase64 = buffer.toString('base64');
                    }
                } catch (err) {}

                // إرسال الرسالة عبر Socket.IO فوراً للشاشة
                if (io) {
                    io.emit('new_message', {
                        chatId: senderJid,
                        senderName: pushName,
                        text: text,
                        mediaType: mediaType,
                        mediaBase64: mediaBase64,
                        profilePic: profilePic,
                        isGroup: isGroup,
                        messageId: msg.key.id
                    });
                }

                // إرسالها لـ PHP لحفظها في قاعدة البيانات
                fetch(PHP_WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET },
                    body: JSON.stringify({
                        chatId: senderJid,
                        senderName: pushName,
                        messageText: text,
                        mediaType: mediaType,
                        mediaBase64: mediaBase64,
                        profilePic: profilePic,
                        isGroup: isGroup,
                        messageId: msg.key.id
                    })
                }).catch(() => {});
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

// جلب القروبات مع صورها
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const myJid = sock.user.id.split(':')[0];

        const list = await Promise.all(Object.values(groups).map(async g => {
            let picUrl = null;
            try { 
                picUrl = await sock.profilePictureUrl(g.id, 'image'); 
            } catch (err) { picUrl = null; }

            const me = g.participants?.find(p => p.id.split('@')[0].split(':')[0] === myJid);
            const isAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));

            return {
                id: g.id,
                name: g.subject,
                description: g.desc ? g.desc.toString() : '',
                pic: picUrl,
                is_admin: isAdmin ? 1 : 0
            };
        }));

        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب جهات الاتصال بطريقة سريعة وبدون تعليق
app.get('/contacts', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });
    try {
        const contacts = Object.values(contactsStore)
            .filter(c => c.id && c.id.endsWith('@s.whatsapp.net') && !c.id.includes('status'))
            .map(c => ({
                id: c.id,
                name: c.name || c.notify || c.verifiedName || c.vname || c.id.split('@')[0],
                phone: c.id.split('@')[0]
            }));
        res.json({ success: true, count: contacts.length, contacts });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// جلب صورة بروفايل مخصصة عند الطلب الفردي (On-Demand) لمنع تعليق السيرفر
app.get('/profile-pic', async (req, res) => {
    const jid = req.query.jid;
    if (!jid || !sock) return res.json({ success: false, pic: null });
    try {
        const pic = await sock.profilePictureUrl(jid, 'image');
        res.json({ success: true, pic });
    } catch (e) {
        res.json({ success: false, pic: null });
    }
});

// إنشاء مجموعة جديدة
app.post('/groups/create', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });

    const { name, description, participants } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'اسم المجموعة مطلوب' });

    try {
        let members = Array.isArray(participants) ? participants.filter(p => p && p.includes('@s.whatsapp.net')) : [];
        if (members.length === 0) {
            const availableContacts = Object.keys(contactsStore).filter(jid => jid.endsWith('@s.whatsapp.net'));
            if (availableContacts.length > 0) {
                members.push(availableContacts[0]);
            }
        }

        if (members.length === 0) {
            return res.status(400).json({ success: false, error: 'يتطلب واتساب إضافة عضو واحد على الأقل لإنشاء المجموعة.' });
        }

        const group = await sock.groupCreate(name, members);

        if (description) {
            try { await sock.groupUpdateDescription(group.id, description); } catch(e) {}
        }

        res.json({
            success: true,
            group: {
                id: group.id,
                name: group.subject,
                description: description || ''
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// إرسال الرسائل والوسائط
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'المستلم مفقود' });

    let target = decodeURIComponent(String(to).trim());
    if (!target.includes('@')) {
        let cleanId = target.replace(/[^0-9-]/g, ''); 
        target = (cleanId.length >= 17 || cleanId.includes('-')) ? `${cleanId}@g.us` : `${cleanId}@s.whatsapp.net`;
    }

    try {
        let sentMsg;
        if (mediaType === 'sticker' && mediaUrl) {
            sentMsg = await sock.sendMessage(target, { sticker: { url: mediaUrl } });
        } else if (mediaType === 'image' && mediaUrl) {
            sentMsg = await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message });
        } else if (mediaType === 'video' && mediaUrl) {
            sentMsg = await sock.sendMessage(target, { video: { url: mediaUrl }, caption: message });
        } else if (mediaType === 'audio' && mediaUrl) {
            sentMsg = await sock.sendMessage(target, { audio: { url: mediaUrl }, ptt: true });
        } else {
            sentMsg = await sock.sendMessage(target, { text: String(message) });
        }

        res.json({ success: true, messageId: sentMsg?.key?.id, status: 'delivered' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// تعديل بيانات القروب
app.post('/groups/update-info', async (req, res) => {
    const { groupId, name, description } = req.body;
    if (!groupId) return res.status(400).json({ success: false, error: 'معرف القروب مفقود' });

    try {
        if (name) await sock.groupUpdateSubject(groupId, name);
        if (description !== undefined) await sock.groupUpdateDescription(groupId, description);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/groups/update-picture', async (req, res) => {
    const { groupId, pictureUrl } = req.body;
    if (!groupId || !pictureUrl) return res.status(400).json({ success: false, error: 'البيانات غير مكتملة' });

    try {
        await sock.updateProfilePicture(groupId, { url: pictureUrl });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/groups/participants', async (req, res) => {
    const { groupId, participantJid } = req.body;
    if (!groupId || !participantJid) return res.status(400).json({ success: false, error: 'المعلومات غير مكتملة' });

    try {
        const response = await sock.groupParticipantsUpdate(groupId, [participantJid], 'add');
        res.json({ success: true, response });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
