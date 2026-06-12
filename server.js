require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const PORT = process.env.PORT || 3000;
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OCR_PROVIDER = process.env.OCR_PROVIDER || (GOOGLE_VISION_API_KEY ? 'google' : (OPENAI_API_KEY ? 'openai' : 'none'));
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const OPENAI_VISION_PROMPT = process.env.OPENAI_VISION_PROMPT || 'Transcribe all visible text from this prescription or medicine box image. Return only the extracted text, preserving line breaks when helpful.';

// ----------------------------------------------------
// Firebase init
// ----------------------------------------------------
let db = null;

function initFirebase() {
  try {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (serviceAccountJson) {
      const serviceAccount = JSON.parse(serviceAccountJson);
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      }
      db = admin.firestore();
      console.log('✅ Firebase inicializado desde FIREBASE_SERVICE_ACCOUNT_JSON');
      return;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (projectId && clientEmail && privateKey) {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey
          })
        });
      }
      db = admin.firestore();
      console.log('✅ Firebase inicializado desde variables individuales');
      return;
    }

    console.warn('⚠️ Firebase no está configurado. El catálogo no funcionará.');
  } catch (error) {
    console.error('❌ Error inicializando Firebase:', error.message);
  }
}

initFirebase();

// ----------------------------------------------------
// Session memory
// ----------------------------------------------------
const sessions = new Map();
const processedInboundMessages = new Map();
let botEnabled = true;
const BOT_ADMIN_NUMBER = '584128840350';
const INBOUND_MESSAGE_DEDUP_TTL_MS = 5 * 60 * 1000;
const INBOUND_MESSAGE_NO_ID_DEDUP_WINDOW_MS = 2500;

function cleanupProcessedInboundMessages(now = Date.now()) {
  for (const [key, value] of processedInboundMessages.entries()) {
    if (!value || now - value.seenAt > INBOUND_MESSAGE_DEDUP_TTL_MS) {
      processedInboundMessages.delete(key);
    }
  }
}

function extractMessageId(payload) {
  const node = unwrapMessagePayload(payload) || {};
  const messageId =
    node?.Info?.MessageID ||
    node?.Info?.MessageId ||
    node?.Info?.ID ||
    node?.messageId ||
    node?.messageID ||
    node?.id ||
    node?.key?.id ||
    node?.message?.key?.id ||
    node?.data?.key?.id ||
    node?.messages?.[0]?.key?.id ||
    '';

  return String(messageId || '').trim();
}

function isDuplicateInboundMessage(payload, from, body) {
  const now = Date.now();
  cleanupProcessedInboundMessages(now);

  const messageId = extractMessageId(payload);
  if (messageId) {
    const key = `id:${messageId}`;
    if (processedInboundMessages.has(key)) return true;
    processedInboundMessages.set(key, { seenAt: now });
    return false;
  }

  const fallbackKey = `fallback:${normalizeText(from)}:${normalizeText(body)}`;
  const previous = processedInboundMessages.get(fallbackKey);
  if (previous && now - previous.seenAt < INBOUND_MESSAGE_NO_ID_DEDUP_WINDOW_MS) {
    return true;
  }

  processedInboundMessages.set(fallbackKey, { seenAt: now });
  return false;
}

function registerOutboundMessageId(messageId) {
  if (!messageId) return;
  processedInboundMessages.set(`out:${String(messageId).trim()}`, { seenAt: Date.now() });
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      mode: 'idle',
      humanHandoff: false,
      lastSearch: null,
      pendingSelectionResults: null,
      catalogHistory: [],
      selectedProducts: [],
      updatedAt: Date.now()
    });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, {
    mode: 'idle',
    humanHandoff: false,
    lastSearch: null,
    pendingSelectionResults: null,
    catalogHistory: [],
    selectedProducts: [],
    updatedAt: Date.now()
  });
}

function enableHumanHandoff(session) {
  session.humanHandoff = true;
  session.mode = 'human_handoff';
  session.pendingSelectionResults = null;
  touchSession(session);
}

function disableHumanHandoff(session) {
  session.humanHandoff = false;
  if (session.mode === 'human_handoff') session.mode = 'idle';
  touchSession(session);
}

function touchSession(session) {
  if (session) session.updatedAt = Date.now();
}

function ensureSelectedProducts(session) {
  if (!session.selectedProducts) session.selectedProducts = [];
  return session.selectedProducts;
}

function clearPendingSearch(session) {
  session.pendingSelectionResults = null;
  if (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global') session.mode = 'idle';
}

function clearSelectionState(session) {
  session.pendingSelectionResults = null;
  if (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global') {
    session.mode = 'idle';
  }
}

function getCatalogSelectionHistory(session) {
  if (!Array.isArray(session.catalogHistory)) session.catalogHistory = [];
  return session.catalogHistory;
}

function rememberCatalogSnapshot(session, resultSet, label, message) {
  const options = Array.isArray(resultSet) ? resultSet.map((item) => ({
    title: item.title,
    priceUsd: item.priceUsd,
    priceBs: item.priceBs,
    raw: item.raw || null
  })) : [];

  if (!options.length) return;

  const history = getCatalogSelectionHistory(session);
  history.push({
    id: `cat_${Date.now()}_${history.length + 1}`,
    label: String(label || 'MEDICAMENTO').trim(),
    message: String(message || '').trim(),
    options,
    createdAt: Date.now()
  });

  while (history.length > 5) history.shift();
}

function getPreviousCatalogSnapshot(session) {
  const history = Array.isArray(session.catalogHistory) ? session.catalogHistory : [];
  if (history.length < 2) return null;
  for (let i = history.length - 2; i >= 0; i--) {
    const snapshot = history[i];
    if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length) return snapshot;
  }
  return null;
}

function isPreviousCatalogRequest(value) {
  const text = normalizeText(value);
  return /\b(lista\s+anterior|resultados\s+anteriores|volver\s+a\s+la\s+lista|volver\s+a\s+resultados|ver\s+lista\s+anterior|lista\s+previa|resultado\s+anterior)\b/.test(text);
}

function getLatestCatalogSnapshot(session) {
  const history = Array.isArray(session.catalogHistory) ? session.catalogHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const snapshot = history[i];
    if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length) return snapshot;
  }
  return null;
}

function resolveSelectionResults(session) {
  if (Array.isArray(session?.pendingSelectionResults) && session.pendingSelectionResults.length > 0) {
    return session.pendingSelectionResults;
  }

  const latestSnapshot = getLatestCatalogSnapshot(session);
  if (latestSnapshot && Array.isArray(latestSnapshot.options) && latestSnapshot.options.length > 0) {
    return latestSnapshot.options;
  }

  if (session?.lastSearch && Array.isArray(session.lastSearch.matches) && session.lastSearch.matches.length > 0) {
    return session.lastSearch.matches;
  }

  return [];
}

function resolveSelectionByHistory(session, optionNumber) {
  const results = resolveSelectionResults(session);
  const parsedOption = Number(optionNumber);
  if (!Number.isInteger(parsedOption) || parsedOption <= 0) return { results, selected: null };
  return { results, selected: results[parsedOption - 1] || null };
}

function pushSelectionHistory(session, selected, quantity) {
  if (!selected) return;
  const history = getCatalogSelectionHistory(session);
  history.push({
    type: 'selection',
    title: selected.title,
    quantity,
    priceUsd: selected.priceUsd,
    priceBs: selected.priceBs,
    createdAt: Date.now()
  });
  while (history.length > 20) history.shift();
}


function getCartTotals(session) {
  const items = ensureSelectedProducts(session);
  const totalUsd = items.reduce((sum, item) => sum + (Number(item.priceUsd) || 0) * (Number(item.quantity) || 0), 0);
  const totalBs = items.reduce((sum, item) => sum + (Number(item.priceBs) || 0) * (Number(item.quantity) || 0), 0);
  return { totalUsd, totalBs };
}

function parseSelectionAndQuantity(text) {
  const normalized = normalizeText(text)
    .replace(/\b(quiero|quisiera|dame|agregar|agrega|sumar|sumame|añadir|anadir|seleccionar|selecciona|elegir|elige|escoger|escoje|de|la|el|las|los|porfavor|por favor)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const optionMatch = normalized.match(/\b(?:opcion|opci[oó]n)\s*(?:nro\.?|numero|número)?\s*(\d+)\b/i);
  const optionAfter = normalized.match(/\b(\d+)\s*(?:de\s+la\s+|de\s+)?(?:opcion|opci[oó]n)\b/i);
  const quantityMatch = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/i);
  const quantityBeforeOption = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\s*(?:de\s+la\s+|de\s+)?(?:opcion|opci[oó]n)\s*(\d+)\b/i);
  const optionBeforeQuantity = normalized.match(/\b(?:opcion|opci[oó]n)\s*(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\s*(\d+)?\b/i);
  const compactPattern = normalized.match(/^(\d+)\s*x\s*(\d+)$/i);

  if (quantityBeforeOption) {
    const quantity = Number(quantityBeforeOption[1]);
    const option = Number(quantityBeforeOption[2]);
    if (Number.isInteger(option) && option > 0 && Number.isInteger(quantity) && quantity > 0) {
      return { option, quantity };
    }
  }

  if (optionMatch || optionAfter || optionBeforeQuantity) {
    const option = Number((optionMatch || optionAfter || optionBeforeQuantity)[1]);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : (optionBeforeQuantity && optionBeforeQuantity[2] ? Number(optionBeforeQuantity[2]) : 1);
    if (Number.isInteger(option) && option > 0 && Number.isInteger(quantity) && quantity > 0) {
      return { option, quantity };
    }
  }

  if (compactPattern) {
    const option = Number(compactPattern[1]);
    const quantity = Number(compactPattern[2]);
    if (Number.isInteger(option) && option > 0 && Number.isInteger(quantity) && quantity > 0) {
      return { option, quantity };
    }
  }

  const quantityOnlyMatch = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/i);
  if (quantityOnlyMatch) {
    const quantity = Number(quantityOnlyMatch[1]);
    if (Number.isInteger(quantity) && quantity > 0) {
      return { option: 1, quantity };
    }
  }

  const optionQuantityPattern = normalized.match(/^(?:opcion|opci[oó]n)\s*(\d+)\s*(?:x|por|de)?\s*(\d+)?$/i);
  if (optionQuantityPattern) {
    const option = Number(optionQuantityPattern[1]);
    const quantity = optionQuantityPattern[2] ? Number(optionQuantityPattern[2]) : 1;
    if (Number.isInteger(option) && option > 0 && Number.isInteger(quantity) && quantity > 0) {
      return { option, quantity };
    }
  }

  const shortPattern = normalized.match(/^(\d+)\s+(\d+)$/);
  if (shortPattern) {
    const option = Number(shortPattern[1]);
    const quantity = Number(shortPattern[2]);
    if (Number.isInteger(option) && option > 0 && Number.isInteger(quantity) && quantity > 0) {
      return { option, quantity };
    }
  }

  const numbers = normalized.match(/\d+/g) || [];
  if (!numbers.length) return null;

  const option = Number(numbers[0]);
  const quantity = numbers.length >= 2 ? Number(numbers[1]) : 1;

  if (!Number.isInteger(option) || option <= 0) return null;
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  return { option, quantity };
}

function isSelectionPhrase(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x)\b/.test(text) && /\d+/.test(text);
}


function isSelectionIntent(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|seleccionar|selecciona|agregar|agrega|quiero|quisiera|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x)\b/.test(text) && /\d+/.test(text);
}


function formatSelectionSavedMessage(item, quantity, session) {
  const title = item.title || 'Medicamento';
  const usdUnit = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
  const bsUnit = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
  const totalUsd = item.priceUsd !== null ? `$${formatPrice((Number(item.priceUsd) || 0) * quantity)}` : 'No disponible';
  const totalBs = item.priceBs !== null ? `Bs ${formatPrice((Number(item.priceBs) || 0) * quantity)}` : 'No disponible';
  const { totalUsd: cartUsd, totalBs: cartBs } = getCartTotals(session);

  return [
    '✅ *Agregado a tu selección*',
    `💊 *${title}*`,
    `Cantidad: *${quantity}*`,
    `Unitario: ${usdUnit}  |  ${bsUnit}`,
    `Subtotal: ${totalUsd}  |  ${totalBs}`,
    '',
    `🧾 Tu carrito actual: *$${formatPrice(cartUsd)}*  |  *Bs ${formatPrice(cartBs)}*`,
    'Puedes seguir agregando opciones de esta misma lista o escribir *LISTO* para ver el pedido completo.'
  ].join('\n');
}

function buildSelectedProductsSummary(session) {
  const items = ensureSelectedProducts(session);
  if (!items.length) {
    return '🧾 Aún no has agregado medicamentos a tu pedido.';
  }

  const { totalUsd, totalBs } = getCartTotals(session);
  const lines = ['🧾 *Resumen de medicamentos seleccionados*', ''];

  items.forEach((item, idx) => {
    const qty = Number(item.quantity) || 1;
    const unitUsd = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const unitBs = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    const subtotalUsd = item.priceUsd !== null ? `$${formatPrice((Number(item.priceUsd) || 0) * qty)}` : 'No disponible';
    const subtotalBs = item.priceBs !== null ? `Bs ${formatPrice((Number(item.priceBs) || 0) * qty)}` : 'No disponible';

    lines.push(`${idx + 1}. ${item.title || 'Medicamento'}`);
    lines.push(`   Cantidad: ${qty}`);
    lines.push(`   Unitario: ${unitUsd} | ${unitBs}`);
    lines.push(`   Subtotal: ${subtotalUsd} | ${subtotalBs}`);
    lines.push('');
  });

  lines.push(`💰 *Total pedido:* $${formatPrice(totalUsd)}  |  Bs ${formatPrice(totalBs)}`);
  lines.push('');
  lines.push('Perfecto! 🎉 Hemos recibido tu pedido.');
  lines.push('');
  lines.push('En breve, uno de nuestros colaboradores de Gentefarma se pondrá en contacto contigo para tramitarlo. 😊');

  return lines.join('\n').trim();
}

function addItemToCart(session, item, quantity) {
  const cart = ensureSelectedProducts(session);
  const existingIndex = cart.findIndex((x) => normalizeText(x.title) === normalizeText(item.title));
  const cartItem = {
    title: item.title,
    quantity,
    priceUsd: item.priceUsd,
    priceBs: item.priceBs,
    basePriceUsd: item.basePriceUsd,
    basePriceBs: item.basePriceBs,
    feeRate: item.feeRate,
    feeAmountUsd: item.feeAmountUsd,
    raw: item.raw
  };

  if (existingIndex >= 0) {
    cart[existingIndex].quantity += quantity;
    cart[existingIndex].priceUsd = item.priceUsd;
    cart[existingIndex].priceBs = item.priceBs;
    cart[existingIndex].basePriceUsd = item.basePriceUsd;
    cart[existingIndex].basePriceBs = item.basePriceBs;
    cart[existingIndex].feeRate = item.feeRate;
    cart[existingIndex].feeAmountUsd = item.feeAmountUsd;
    return cart[existingIndex];
  }

  cart.push(cartItem);
  return cartItem;
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.updatedAt > 1000 * 60 * 60 * 6) {
      sessions.delete(phone);
    }
  }
}, 1000 * 60 * 60);

// ----------------------------------------------------
// Basic routes
// ----------------------------------------------------
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

// ----------------------------------------------------
// Webhook
// ----------------------------------------------------
app.post('/webhook', async (req, res) => {
  try {
    console.log('📦 Body recibido:', JSON.stringify(req.body, null, 2));

    const event = req.body?.event || req.body?.type || req.body?.data?.event || 'Message';
    const data = req.body?.data || req.body;

    console.log('📩 Evento recibido:', event);

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
    if (!res.headersSent) {
      res.status(500).json({
        status: 'error',
        message: error.message
      });
    }
  }
});

// ----------------------------------------------------
// Event routing
// ----------------------------------------------------
async function handleEvent(event, data) {
  const normalizedEvent = normalizeText(String(event || ''));

  if (
    normalizedEvent === 'message' ||
    normalizedEvent === 'messages upsert' ||
    normalizedEvent === 'messages' ||
    normalizedEvent === 'upsert'
  ) {
    await processIncomingMessage(data);
    return;
  }

  if (
    normalizedEvent === 'messages update' ||
    normalizedEvent === 'message update' ||
    normalizedEvent === 'update'
  ) {
    await processMessageUpdate(data);
    return;
  }

  console.log('ℹ️ Evento ignorado:', event);
}

// ----------------------------------------------------
// Main message processor
// ----------------------------------------------------
async function processIncomingMessage(payload) {
  try {
    console.log('📨 Payload del mensaje:', JSON.stringify(payload, null, 2));

    const from = extractFrom(payload);
    const fromMe = extractFromMe(payload);
    const adminRecipient = extractRecipient(payload);
    const media = extractMediaDescriptor(payload);
    const mediaAnalysis = media ? await analyzeIncomingMedia(media) : null;
    const body = extractBody(payload) || mediaAnalysis?.text || '';
    const normalizedBody = normalizeText(body);
    const normalizedFrom = normalizeText(from);
    const normalizedRecipient = normalizeText(adminRecipient);
    const isAdmin = isAdminSender(from) || isAdminSender(adminRecipient);
    const isControlMessage = isBotControlMessage(body);
    const isControlCommand = isControlMessage && isAdmin;

    console.log('🔎 Extraído:', { from, adminRecipient, body, fromMe, media: media ? { mimeType: media.mimeType, url: media.url ? '[url]' : '', fileName: media.fileName || '' } : null });
    console.log('🔎 Control bot:', { normalizedFrom, normalizedRecipient, isAdmin, isControlMessage, fromMe, botEnabled });

    if (!from) {
      console.log('⚠️ No se pudo obtener el remitente.');
      return;
    }

    if (!body && !mediaAnalysis?.text) {
      console.log('⚠️ No se pudo obtener el texto del mensaje ni OCR de imagen/documento.');
      return;
    }

    const dedupeBody = body || mediaAnalysis?.signature || media?.url || media?.fileName || '';
    if (isDuplicateInboundMessage(payload, from, dedupeBody)) {
      console.log('↩️ Mensaje duplicado detectado, ignorado.');
      return;
    }

    if (isControlCommand) {
      if (normalizedBody === 'bot off') {
        botEnabled = false;
        sessions.forEach((session) => {
          if (!session) return;
          session.humanHandoff = false;
          if (session.mode === 'human_handoff') session.mode = 'idle';
        });
        if (!fromMe) {
          await sendWhatsAppMessage(from, '⛔ Bot desactivado.');
        }
        return;
      }

      if (normalizedBody === 'bot on') {
        botEnabled = true;
        if (!fromMe) {
          await sendWhatsAppMessage(from, '🤖 Bot activado.');
        }
        return;
      }

      if (normalizedBody === 'bot status') {
        if (!fromMe) {
          await sendWhatsAppMessage(from, botEnabled ? '🤖 Bot activo.' : '⛔ Bot desactivado.');
        }
        return;
      }
    }

    if (fromMe) {
      console.log('↩️ Mensaje propio, ignorado.');
      return;
    }

    if (!botEnabled) {
      console.log('⛔ Bot apagado, mensaje ignorado.');
      return;
    }

    const session = getSession(from);
    touchSession(session);

    const response = await routeMessage(from, body, session);
    if (response) {
      await sendWhatsAppMessage(from, response);
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

async function analyzeIncomingMedia(media) {
  if (!media || (!media.url && !media.downloadMessage)) return null;

  const mimeType = String(media.mimeType || '').toLowerCase();
  const isImage = /^image\//.test(mimeType);
  const isPdf = mimeType.includes('pdf');
  if (!isImage && !isPdf) return null;

  try {
    const text = await extractTextFromMedia(media);
    if (!text) return null;
    return {
      text,
      signature: normalizeText(text).slice(0, 140)
    };
  } catch (error) {
    console.error('❌ Error analizando media entrante:', error.message);
    return null;
  }
}

async function extractTextFromMedia(media) {
  const buffer = await downloadMediaBuffer(media);
  if (!buffer || !buffer.length) return '';

  const mimeType = String(media.mimeType || '').toLowerCase();
  const imageBase64 = buffer.toString('base64');

  if (OCR_PROVIDER === 'openai' && OPENAI_API_KEY) {
    const openaiText = await callOpenAIVision(imageBase64, mimeType || 'image/jpeg');
    if (openaiText) return openaiText;
  }

  if (OCR_PROVIDER === 'google' && GOOGLE_VISION_API_KEY) {
    const visionText = await callGoogleVisionOCR(imageBase64);
    if (visionText) return visionText;
  }

  if (OCR_PROVIDER === 'auto') {
    if (GOOGLE_VISION_API_KEY) {
      const visionText = await callGoogleVisionOCR(imageBase64);
      if (visionText) return visionText;
    }
    if (OPENAI_API_KEY) {
      const openaiText = await callOpenAIVision(imageBase64, mimeType || 'image/jpeg');
      if (openaiText) return openaiText;
    }
  }

  return '';
}

async function downloadMediaBuffer(media) {
  const downloadMessage = media?.downloadMessage || null;
  if (downloadMessage) {
    try {
      const response = await axios.post(
        `${EVOLUTION_API_URL}/message/downloadimage`,
        { message: downloadMessage },
        {
          timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            apikey: EVOLUTION_API_KEY
          }
        }
      );

      const buffer = bufferFromEvolutionDownloadResponse(response?.data);
      if (buffer && buffer.length) return buffer;
    } catch (error) {
      console.error('❌ Error descargando media vía Evolution GO:', error.response?.data || error.message);
    }
  }

  const url = String(media?.url || '').trim();
  if (!url) return Buffer.alloc(0);

  const headers = media.headers || {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MEDIA_ANALYSIS_TIMEOUT_MS);
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
      headers,
      signal: controller.signal
    });
    return Buffer.from(response.data);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAIVision(imageBase64, mimeType) {
  const payload = {
    model: OPENAI_VISION_MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: OPENAI_VISION_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
      ]
    }],
    temperature: 0
  };

  const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
    timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return String(response?.data?.choices?.[0]?.message?.content || '').trim();
}

async function callGoogleVisionOCR(imageBase64) {
  const response = await axios.post(
    `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`,
    {
      requests: [{
        image: { content: imageBase64 },
        features: [
          { type: 'DOCUMENT_TEXT_DETECTION' },
          { type: 'TEXT_DETECTION' }
        ]
      }]
    },
    {
      timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' }
    }
  );

  return String(response?.data?.responses?.[0]?.fullTextAnnotation?.text || response?.data?.responses?.[0]?.textAnnotations?.[0]?.description || '').trim();
}

function extractMediaDescriptor(payload) {
  const node = unwrapMessagePayload(payload) || {};
  const candidates = [
    node,
    node?.Message,
    node?.message,
    node?.data,
    node?.data?.Message,
    node?.data?.message,
    node?.messages?.[0],
    node?.messages?.[0]?.message,
    node?.key,
    node?.key?.message
  ].filter(Boolean);

  const mediaKeys = [
    'imageMessage',
    'documentMessage',
    'mediaMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage'
  ];

  const buildDescriptor = (media, mediaType) => {
    if (!media || !mediaType) return null;
    const cloned = JSON.parse(JSON.stringify(media));
    const url = cloned.URL || cloned.url || cloned.mediaUrl || cloned.directPath || cloned.thumbnailDirectPath || cloned.thumbnailUrl || cloned.filePath || cloned.path || '';

    return {
      ...cloned,
      mediaType,
      mimeType: cloned.mimeType || cloned.mimetype || '',
      url,
      directPath: cloned.directPath || '',
      fileName: cloned.fileName || cloned.filename || '',
      mediaKey: cloned.mediaKey || '',
      fileEncSHA256: cloned.fileEncSHA256 || '',
      fileSHA256: cloned.fileSHA256 || '',
      headers: cloned.headers || {},
      downloadMessage: { [mediaType]: cloned }
    };
  };

  for (const candidate of candidates) {
    for (const mediaKey of mediaKeys) {
      const media = candidate?.[mediaKey] || candidate?.message?.[mediaKey] || candidate?.Message?.[mediaKey];
      if (!media) continue;

      const descriptor = buildDescriptor(media, mediaKey);
      if (!descriptor) continue;
      if (!descriptor.url && !descriptor.directPath && !descriptor.mediaKey) continue;
      return descriptor;
    }
  }

  return null;
}

function bufferFromEvolutionDownloadResponse(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return Buffer.alloc(0);
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
      try { return Buffer.from(trimmed, 'base64'); } catch (_) {}
    }
    return Buffer.from(trimmed);
  }
  if (data?.base64) return Buffer.from(String(data.base64), 'base64');
  if (data?.image) return bufferFromEvolutionDownloadResponse(data.image);
  if (data?.data) return bufferFromEvolutionDownloadResponse(data.data);
  if (data?.buffer) return bufferFromEvolutionDownloadResponse(data.buffer);
  return Buffer.alloc(0);
}

// ... trimmed for remote update ...
