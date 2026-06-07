require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';

const EVOLUTION_API_KEY =
  process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';

const INSTANCE_NAME = process.env.INSTANCE_NAME || 'Gentefarma';

app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gentefarma-webhook',
    timestamp: new Date().toISOString()
  });
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));

    const event =
      req.body?.event ||
      req.body?.type ||
      req.body?.data?.event ||
      'Message';

    const data = req.body?.data || req.body;

    console.log('📩 Evento recibido:', event);

    // Responder rápido al proveedor y procesar en segundo plano
    res.status(200).json({
      status: 'success',
      message: 'Webhook recibido correctamente',
      event,
      timestamp: new Date().toISOString()
    });

    setImmediate(() => {
      handleEvent(event, data).catch((error) => {
        console.error('❌ Error procesando evento en background:', error);
      });
    });
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

async function handleEvent(event, data) {
  const normalizedEvent = String(event || '').toLowerCase();

  if (
    normalizedEvent === 'messages.upsert' ||
    normalizedEvent === 'message' ||
    normalizedEvent === 'messages' ||
    normalizedEvent === 'upsert'
  ) {
    await processIncomingMessage(data);
    return;
  }

  if (
    normalizedEvent === 'messages.update' ||
    normalizedEvent === 'message.update' ||
    normalizedEvent === 'update'
  ) {
    await processMessageUpdate(data);
    return;
  }

  console.log('ℹ️ Evento ignorado:', event);
}
async function processIncomingMessage(payload) {
  try {
    console.log('📨 Payload del mensaje:', JSON.stringify(payload, null, 2));

    const from = extractFrom(payload);
    const body = extractBody(payload);
    const fromMe = extractFromMe(payload);

    console.log('🔎 Extraído:', { from, body, fromMe });

    if (fromMe) {
      console.log('↩️ Mensaje propio, ignorado.');
      return;
    }

    if (!from) {
      console.log('⚠️ No se pudo obtener el remitente.');
      return;
    }

    if (!body) {
      console.log('⚠️ No se pudo obtener el texto del mensaje.');
      return;
    }

    const autoResponse = await generateAutoResponse(body, from);

    if (autoResponse) {
      await sendWhatsAppMessage(from, autoResponse);
    }
  } catch (error) {
    console.error('❌ Error procesando mensaje:', error);
  }
}
async function processMessageUpdate(messageUpdate) {
  try {
    console.log('📊 Actualización de mensaje:', JSON.stringify(messageUpdate, null, 2));
  } catch (error) {
    console.error('❌ Error en processMessageUpdate:', error);
  }
}

function extractFrom(payload) {
  const jid =
    payload?.Info?.Sender ||
    payload?.Info?.Chat ||
    payload?.Sender ||
    payload?.sender ||
    payload?.from ||
    payload?.key?.remoteJid ||
    '';

  // Convierte "584128009482@s.whatsapp.net" -> "584128009482"
  return String(jid).replace(/@s\.whatsapp\.net$/, '').trim();
}

function extractBody(payload) {
  return (
    payload?.Message?.conversation ||
    payload?.Message?.extendedTextMessage?.text ||
    payload?.Message?.text ||
    payload?.body ||
    payload?.text ||
    payload?.data?.body ||
    ''
  );
}

function extractFromMe(payload) {
  return Boolean(
    payload?.Info?.IsFromMe ??
      payload?.fromMe ??
      payload?.key?.fromMe ??
      payload?.data?.fromMe ??
      false
  );
}
async function sendWhatsAppMessage(phone, text) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/send/text`,
      {
        number: phone,
        text: text,
        formatJid: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY
        },
        timeout: 30000
      }
    );

    console.log('✅ Mensaje enviado por WhatsApp:', response.data);
    return response.data;
  } catch (error) {
    console.error(
      '❌ Error enviando WhatsApp:',
      error.response?.data || error.message
    );
    throw error;
  }
}

async function generateAutoResponse(message, phone) {
  const lowerMsg = String(message || '').toLowerCase().trim();

  if (lowerMsg.match(/hola|buenos|buenas|hi|hey/)) {
    return `🏥 *GENTEFARMA* - Tu Farmacia Virtual 💊

¡Hola! Bienvenido a Gentefarma 🎉

Soy tu asistente virtual y puedo ayudarte con:

🔍 Consultar productos y medicamentos
📦 Realizar pedidos
💰 Ver precios y disponibilidad
📍 Horarios y ubicación
👤 Hablar con un humano

¿En qué puedo ayudarte hoy?`;
  }

  if (lowerMsg.match(/producto|medicamento|farmacia/)) {
    return `📦 *PRODUCTOS DISPONIBLES*

Tenemos una amplia variedad de productos farmacéuticos:

💊 Medicamentos
🧴 Cuidado personal
🍎 Vitaminas y suplementos
👶 Productos infantiles
🩺 Material médico

¿Qué medicamento o producto necesitas?`;
  }

  if (lowerMsg.match(/gracias|hasta|adios|adiós/)) {
    return `👋 ¡Gracias por contactar a Gentefarma!

Tu pedido será procesado en breve.
¿Hay algo más en lo que pueda ayudarte?`;
  }

  return `🤖 *Asistente Gentefarma*

No estoy seguro de entenderte. ¿Podrías aclararme?

¿En qué puedo ayudarte?
1️⃣ Consultar productos
2️⃣ Realizar pedido
3️⃣ Información general`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Gentefarma Webhook Service running on port ${PORT}`);
});
