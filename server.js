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

    const autoResponse = await generateAutoResponse(body, from);

    if (!autoResponse) {
      console.log('⚠️ No se generó respuesta automática.');
      return;
    }

    console.log('➡️ Enviando respuesta a:', from);
    console.log('✉️ Respuesta:', autoResponse);

    await sendWhatsAppMessage(from, autoResponse);
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
  return (
    payload?.from ||
    payload?.sender ||
    payload?.key?.remoteJid ||
    payload?.data?.from ||
    payload?.message?.remoteJid ||
    payload?.remoteJid ||
    ''
  );
}

function extractBody(payload) {
  return (
    payload?.body ||
    payload?.text ||
    payload?.message?.conversation ||
