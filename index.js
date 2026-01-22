const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Estado global
let currentQR = null;
let connectionStatus = 'disconnected';
let clientInfo = null;

// Cliente WhatsApp com Puppeteer configurado
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    executablePath: puppeteer.executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

// Servidor HTTP
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = (data) => {
  const message = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(message);
  });
};

// Eventos WhatsApp
client.on('qr', async (qr) => {
  console.log('QR Code gerado');
  currentQR = await QRCode.toDataURL(qr);
  connectionStatus = 'qr_required';
  broadcast({ type: 'qr', qr: currentQR });
});

client.on('ready', () => {
  console.log('WhatsApp conectado!');
  currentQR = null;
  connectionStatus = 'connected';
  clientInfo = client.info;
  broadcast({ type: 'connected' });
});

client.on('disconnected', (reason) => {
  console.log('Desconectado:', reason);
  connectionStatus = 'disconnected';
  currentQR = null;
  broadcast({ type: 'disconnected' });
});

client.on('message', async (msg) => {
  broadcast({
    type: 'message',
    message: {
      id: msg.id._serialized,
      conversationId: msg.from,
      fromMe: msg.fromMe,
      contactId: msg.from,
      type: msg.type,
      content: msg.body,
      timestamp: new Date(msg.timestamp * 1000),
      status: 'received'
    }
  });
});

// ENDPOINTS

app.get('/health', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQR,
    info: clientInfo ? { pushname: clientInfo.pushname } : null
  });
});

app.get('/qr', (req, res) => {
  if (currentQR) {
    res.json({ qr: currentQR });
  } else {
    res.status(404).json({ error: 'QR not available' });
  }
});

app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await client.getContacts();
    const formatted = contacts
      .filter(c => c.isMyContact && c.id.user)
      .map(c => ({
        id: c.id._serialized,
        phone: c.id.user,
        name: c.name || c.pushname || c.id.user,
        pushName: c.pushname,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const chats = await client.getChats();
    const formatted = await Promise.all(
      chats.slice(0, 50).map(async (chat) => {
        const contact = await chat.getContact();
        return {
          id: chat.id._serialized,
          contact: {
            id: contact.id._serialized,
            phone: contact.id.user,
            name: contact.name || contact.pushname || contact.id.user,
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          unreadCount: chat.unreadCount,
          updatedAt: new Date(chat.timestamp * 1000)
        };
      })
    );
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages/:conversationId', async (req, res) => {
  try {
    const chat = await client.getChatById(req.params.conversationId);
    const messages = await chat.fetchMessages({ limit: 50 });
    const formatted = messages.map(msg => ({
      id: msg.id._serialized,
      conversationId: msg.from,
      fromMe: msg.fromMe,
      contactId: msg.fromMe ? 'me' : msg.from,
      type: msg.type,
      content: msg.body,
      timestamp: new Date(msg.timestamp * 1000),
      status: msg.ack >= 2 ? 'read' : 'sent'
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { to, content } = req.body;
    const chatId = to.includes('@') ? to : `${to}@c.us`;
    const msg = await client.sendMessage(chatId, content);
    res.json({
      id: msg.id._serialized,
      conversationId: chatId,
      fromMe: true,
      type: 'text',
      content: content,
      timestamp: new Date(),
      status: 'sent'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

console.log('Iniciando WhatsApp...');
client.initialize();

