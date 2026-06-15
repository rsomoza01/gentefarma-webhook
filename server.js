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
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';
const PORT = process.env.PORT || 3000;
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
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

// ----------------------------------------------------
// WhatsApp send helper (defined early so it remains available even if the file is partially truncated)
// ----------------------------------------------------
async function sendOutboundWhatsAppMessage(phone, text) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/send/text`,
      {
        number: phone,
        text,
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

    const sentMessageId =
      response?.data?.key?.id ||
      response?.data?.messageId ||
      response?.data?.data?.key?.id ||
      response?.data?.data?.messageId ||
      null;

    registerOutboundMessageId(sentMessageId);

    console.log('✅ Mensaje enviado por WhatsApp:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.response?.data || error.message);
    throw error;
  }
}

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

function parseSelectionCommand(text) {
  const normalized = normalizeText(text)
    .replace(/\b(quiero|quisiera|dame|agregar|agrega|sumar|sumame|añadir|anadir|seleccionar|selecciona|elegir|elige|escoger|escoje|de|la|el|las|los|porfavor|por favor|solo)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const optionMarker = normalized.match(/\b(?:opcion|opci[oó]n)\s*(?:nro\.?|numero|número)?\s*(.+)$/i);
  const quantityBeforeOption = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\s*(?:de\s+la\s+|de\s+)?(?:opcion|opci[oó]n)\s*(.+)$/i);
  const quantityOnlyMatch = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/i);
  const compactPattern = normalized.match(/^(\d+)\s*x\s*(\d+(?:\s*[,y]\s*\d+)*)$/i);
  const shortPairPattern = normalized.match(/^(\d+)\s+(\d+(?:\s*[,y]\s*\d+)*)$/i);
  const optionOnlyPattern = normalized.match(/^\s*(?:opcion|opci[oó]n)\s*(\d+(?:\s*[,y]\s*\d+)*)\s*$/i);
  const plainListPattern = normalized.match(/^(?:\d+(?:\s*[,y]\s*\d+)+)$/i);

  const parseOptionList = (value) => {
    const matches = String(value || '').match(/\d+/g) || [];
    return [...new Set(matches.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];
  };

  const buildResult = (options, quantity, rawText = normalized) => {
    const uniqueOptions = [...new Set((options || []).filter((n) => Number.isInteger(n) && n > 0))];
    if (!uniqueOptions.length) return null;
    return {
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
      options: uniqueOptions,
      option: uniqueOptions[0],
      raw: rawText
    };
  };

  if (quantityBeforeOption) {
    const quantity = Number(quantityBeforeOption[1]);
    const options = parseOptionList(quantityBeforeOption[2]);
    const built = buildResult(options, quantity, normalized);
    if (built) return built;
  }

  if (optionMarker) {
    const options = parseOptionList(optionMarker[1]);
    const built = buildResult(options, quantityOnlyMatch ? Number(quantityOnlyMatch[1]) : 1, normalized);
    if (built) return built;
  }

  if (compactPattern) {
    const quantity = Number(compactPattern[1]);
    const options = parseOptionList(compactPattern[2]);
    const built = buildResult(options, quantity, normalized);
    if (built) return built;
  }

  if (shortPairPattern) {
    const quantity = Number(shortPairPattern[1]);
    const options = parseOptionList(shortPairPattern[2]);
    const built = buildResult(options, quantity, normalized);
    if (built) return built;
  }

  if (optionOnlyPattern) {
    const options = parseOptionList(optionOnlyPattern[1]);
    const built = buildResult(options, 1, normalized);
    if (built) return built;
  }

  if (plainListPattern) {
    const options = parseOptionList(normalized);
    const built = buildResult(options, 1, normalized);
    if (built) return built;
  }

  if (quantityOnlyMatch) {
    const quantity = Number(quantityOnlyMatch[1]);
    if (Number.isInteger(quantity) && quantity > 0) {
      const options = parseOptionList(normalized);
      if (options.length) return buildResult(options, quantity, normalized);
    }
  }

  const numbers = normalized.match(/\d+/g) || [];
  if (!numbers.length) return null;

  const quantity = quantityOnlyMatch ? Number(quantityOnlyMatch[1]) : 1;
  const options = parseOptionList(numbers.join(' '));
  return buildResult(options, quantity, normalized);
}

function isSelectionPhrase(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x|opciones)\b/.test(text) && /\d+/.test(text);
}


function isSelectionIntent(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|opciones|seleccionar|selecciona|agregar|agrega|quiero|quisiera|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x)\b/.test(text) && /\d+/.test(text);
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
    const sanitizedOcrText = mediaAnalysis?.text ? sanitizeRecipeText(mediaAnalysis.text) : '';
    const body = extractBody(payload) || sanitizedOcrText || '';
    const normalizedBody = normalizeText(body);

    if (mediaAnalysis?.text) {
      console.log('🧾 OCR text extracted:', mediaAnalysis.text.slice(0, 500));
      if (sanitizedOcrText && sanitizedOcrText !== mediaAnalysis.text) {
        console.log('🧽 OCR text sanitized:', sanitizedOcrText.slice(0, 500));
      }
      console.log('🔎 OCR routed to catalog search:', {
        textLength: mediaAnalysis.text.length,
        sanitizedTextLength: sanitizedOcrText.length,
        signature: mediaAnalysis.signature || ''
      });
    }

    if (!body && mediaAnalysis?.text) {
      console.log('ℹ️ OCR text available, using it as message body.');
    }

    if (mediaAnalysis?.text && !body) {
      // body already resolved from OCR; keep explicit log for traceability.
    }
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
          await sendOutboundWhatsAppMessage(from, '⛔ Bot desactivado.');
        }
        return;
      }

      if (normalizedBody === 'bot on') {
        botEnabled = true;
        if (!fromMe) {
          await sendOutboundWhatsAppMessage(from, '🤖 Bot activado.');
        }
        return;
      }

      if (normalizedBody === 'bot status') {
        if (!fromMe) {
          await sendOutboundWhatsAppMessage(from, botEnabled ? '🤖 Bot activo.' : '⛔ Bot desactivado.');
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

    const response = await routeMessage(from, body, session, { hasOcrText: Boolean(mediaAnalysis?.text) });
    if (response) {
      await sendOutboundWhatsAppMessage(from, response);
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
  const inlineBuffer = bufferFromInlineBase64(
    media?.base64 ||
    media?.inlineBase64 ||
    media?.rawBase64 ||
    media?.payloadBase64 ||
    media?.content ||
    media?.data
  );
  const hasInlineBase64 = Boolean(inlineBuffer && inlineBuffer.length);

  if (!media || (!hasInlineBase64 && !media.url && !media.downloadMessage)) return null;

  const mimeType = String(media.mimeType || media.mimetype || '').toLowerCase();
  const isImage = /^image\//.test(mimeType);
  const isPdf = mimeType.includes('pdf');
  if (!hasInlineBase64 && !isImage && !isPdf) return null;

  console.log(
    `🖼️ Analizando media: inlineBase64=${hasInlineBase64 ? inlineBuffer.length : 0} url=${media?.url || media?.URL || media?.mediaUrl || media?.directPath || ''}`
  );

  try {
    const text = await extractTextFromMedia(media);
    if (!text) return null;
    return {
      text,
      signature: media?.fileSHA256 || media?.fileEncSHA256 || media?.mediaKey || media?.url || media?.fileName || ''
    };
  } catch (error) {
    console.error('❌ Error analizando media:', error?.message || error);
    return null;
  }
}

async function extractTextFromMedia(media) {
  const inlineBuffer = bufferFromInlineBase64(media?.base64 || media?.inlineBase64 || media?.rawBase64 || media?.payloadBase64 || media?.content || media?.data);
  const buffer = (inlineBuffer && inlineBuffer.length) ? inlineBuffer : await downloadMediaBuffer(media);
  if (!buffer || !buffer.length) return '';

  const mimeType = String(media.mimeType || media.mimetype || '').toLowerCase();
  const imageBase64 = buffer.toString('base64');

  console.log('🧪 OCR media details:', {
    provider: OCR_PROVIDER,
    mimeType,
    inlineBytes: inlineBuffer?.length || 0,
    bufferBytes: buffer.length,
    hasGoogleKey: Boolean(GOOGLE_VISION_API_KEY),
    hasOpenAIKey: Boolean(OPENAI_API_KEY)
  });

  const openaiMimeType = mimeType || 'image/jpeg';
  const tryOpenAI = async (label) => {
    if (!OPENAI_API_KEY) return '';
    const text = await callOpenAIVision(imageBase64, openaiMimeType);
    console.log(`🧪 OCR openai${label ? `(${label})` : ''} result length:`, text ? text.length : 0);
    return text || '';
  };

  const shouldFallbackToOpenAI = (error) => {
    const status = error?.response?.status;
    const details = error?.response?.data;
    const payloadText = typeof details === 'string' ? details : JSON.stringify(details || {});
    return status === 403 || status === 401 || /API_KEY_SERVICE_BLOCKED|SERVICE_DISABLED|PERMISSION_DENIED|blocked/i.test(payloadText);
  };

  if (OCR_PROVIDER === 'openai' && OPENAI_API_KEY) {
    const openaiText = await tryOpenAI('openai');
    if (openaiText) return openaiText;
  }

  if (OCR_PROVIDER === 'google' && GOOGLE_VISION_API_KEY) {
    try {
      const visionText = await callGoogleVisionOCR(imageBase64);
      console.log('🧪 OCR google result length:', visionText ? visionText.length : 0);
      if (visionText) return visionText;
    } catch (error) {
      const status = error?.response?.status;
      const details = error?.response?.data;
      const errorText = typeof details === 'string' ? details : JSON.stringify(details || {}).slice(0, 500);
      console.warn('⚠️ Google Vision falló:', status || '', errorText);
      if (shouldFallbackToOpenAI(error)) {
        const openaiText = await tryOpenAI('fallback');
        if (openaiText) return openaiText;
      }
    }
  }

  if (OCR_PROVIDER === 'auto') {
    if (GOOGLE_VISION_API_KEY) {
      try {
        const visionText = await callGoogleVisionOCR(imageBase64);
        console.log('🧪 OCR google(auto) result length:', visionText ? visionText.length : 0);
        if (visionText) return visionText;
      } catch (error) {
        const status = error?.response?.status;
        const details = error?.response?.data;
        const errorText = typeof details === 'string' ? details : JSON.stringify(details || {}).slice(0, 500);
        console.warn('⚠️ Google Vision(auto) falló:', status || '', errorText);
        if (shouldFallbackToOpenAI(error)) {
          const openaiText = await tryOpenAI('auto-fallback');
          if (openaiText) return openaiText;
        }
      }
    }
    if (OPENAI_API_KEY) {
      const openaiText = await tryOpenAI('auto');
      if (openaiText) return openaiText;
    }
  }

  if (OPENAI_API_KEY && OCR_PROVIDER === 'google') {
    const openaiText = await tryOpenAI('google-fallback-final');
    if (openaiText) return openaiText;
  }

  console.warn('⚠️ OCR sin resultado. Revisa proveedor/configuración o calidad de la imagen.');
  return '';
}

function bufferFromInlineBase64(value) {
  const base64 = extractInlineBase64(value);
  if (!base64) return null;

  try {
    return Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
}

function extractInlineBase64(value) {
  if (!value) return '';

  const seen = new Set();
  const queue = [value];
  const nestedKeys = ['base64', 'dataUrl', 'dataURL', 'content', 'buffer'];

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;

    if (typeof current === 'string') {
      const text = current.trim();
      const base64Match = text.match(/^data:[^;]+;base64,(.+)$/i);
      if (base64Match) return base64Match[1].replace(/\s+/g, '');
      if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 32) {
        return text.replace(/\s+/g, '');
      }
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);

      for (const key of nestedKeys) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          queue.push(current[key]);
        }
      }
    }
  }

  return '';
}

async function downloadMediaBuffer(media) {
  const downloadMessage = media?.downloadMessage || null;
  if (downloadMessage) {
    const configuredEndpoints = String(process.env.EVOLUTION_MEDIA_DOWNLOAD_ENDPOINTS || '').trim();
    const endpoints = (configuredEndpoints
      ? configuredEndpoints.split(',').map((endpoint) => endpoint.trim()).filter(Boolean)
      : [
          '/message/downloadimage',
          '/message/downloadmedia'
        ]
    ).map((endpoint) => endpoint.startsWith('http') ? endpoint : `${EVOLUTION_API_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`);

    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const response = await axios.post(
          endpoint,
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

        console.error(`❌ Media descargada pero vacía desde ${endpoint}:`, typeof response?.data === 'string' ? response.data.slice(0, 120) : JSON.stringify(response?.data || {}).slice(0, 120));
      } catch (error) {
        const status = error.response?.status;
        const responseText = error.response?.data || error.message;
        lastError = { endpoint, status, responseText };
        console.error(`❌ Error descargando media vía Evolution GO (${endpoint}${status ? ` ${status}` : ''}):`, responseText);
        if (status && status !== 404) break;
      }
    }

    if (lastError) {
      console.error('⚠️ No se pudo descargar la media desde ningún endpoint configurado.', lastError);
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

function bufferFromEvolutionDownloadResponse(data) {
  if (!data) return null;

  const seen = new Set();
  const queue = [data];
  const nestedKeys = ['data', 'result', 'media', 'file', 'buffer', 'base64', 'dataUrl', 'dataURL', 'url', 'content'];

  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;

    if (Buffer.isBuffer(current)) return current;

    if (typeof current === 'string') {
      const text = current.trim();
      const base64Match = text.match(/^data:[^;]+;base64,(.+)$/i);
      if (base64Match) return Buffer.from(base64Match[1], 'base64');
      if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 32) {
        try {
          return Buffer.from(text.replace(/\s+/g, ''), 'base64');
        } catch {
          continue;
        }
      }
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) queue.push(item);
      continue;
    }

    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);

      for (const key of nestedKeys) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          queue.push(current[key]);
        }
      }
    }
  }

  return null;
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

  const isOpenRouter = /openrouter\.ai/i.test(OPENAI_BASE_URL);
  const response = await axios.post(`${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, payload, {
    timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      ...(isOpenRouter ? {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://gentefarma.app',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Gentefarma WhatsApp OCR'
      } : {})
    }
  });

  if (isOpenRouter) {
    console.log('🧪 OpenRouter OCR request sent:', {
      baseUrl: OPENAI_BASE_URL,
      model: OPENAI_VISION_MODEL,
      hasKey: Boolean(OPENAI_API_KEY),
      referer: process.env.OPENROUTER_HTTP_REFERER || 'https://gentefarma.app',
      title: process.env.OPENROUTER_APP_NAME || 'Gentefarma WhatsApp OCR'
    });
  }

  return String(response?.data?.choices?.[0]?.message?.content || '').trim();
}

async function callGoogleVisionOCR(imageBase64) {
  const visionEndpoint = 'https://vision.googleapis.com/v1/images:annotate';
  const serviceAccount = getGoogleVisionServiceAccount();

  const tryWithApiKey = async () => {
    if (!GOOGLE_VISION_API_KEY) return '';

    const response = await axios.post(
      `${visionEndpoint}?key=${encodeURIComponent(GOOGLE_VISION_API_KEY)}`,
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
  };

  const tryWithServiceAccount = async () => {
    if (!serviceAccount) return '';
    const accessToken = await getGoogleVisionAccessToken(serviceAccount);
    if (!accessToken) return '';

    const response = await axios.post(
      visionEndpoint,
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
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    return String(response?.data?.responses?.[0]?.fullTextAnnotation?.text || response?.data?.responses?.[0]?.textAnnotations?.[0]?.description || '').trim();
  };

  try {
    if (serviceAccount) {
      try {
        const text = await tryWithServiceAccount();
        if (text) return text;
      } catch (error) {
        const status = error.response?.status;
        const details = error.response?.data;
        console.warn('⚠️ Google Vision con service account falló:', status || '', typeof details === 'string' ? details : JSON.stringify(details || {}).slice(0, 300));
        if (status !== 403 && status !== 401) throw error;
      }
    }

    try {
      const text = await tryWithApiKey();
      if (text) return text;
    } catch (error) {
      const status = error.response?.status;
      const details = error.response?.data;
      const errorText = typeof details === 'string' ? details : JSON.stringify(details || {}).slice(0, 500);
      console.warn('⚠️ Google Vision con API key falló:', status || '', errorText);
      if (status !== 403 && status !== 401) throw error;
    }

    return '';
  } catch (error) {
    const status = error.response?.status;
    const details = error.response?.data;
    console.error('❌ Google Vision OCR error:', status || '', typeof details === 'string' ? details : JSON.stringify(details || {}).slice(0, 500));
    throw error;
  }
}

function getGoogleVisionServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

let googleVisionTokenCache = { token: '', expiresAt: 0 };

async function getGoogleVisionAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  if (googleVisionTokenCache.token && googleVisionTokenCache.expiresAt > now + 60) {
    return googleVisionTokenCache.token;
  }

  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(serviceAccount.private_key));

  const assertion = `${signingInput}.${signature}`;
  const form = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const response = await axios.post('https://oauth2.googleapis.com/token', form.toString(), {
    timeout: MEDIA_ANALYSIS_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const token = String(response?.data?.access_token || '');
  const expiresIn = Number(response?.data?.expires_in || 3600);
  if (token) {
    googleVisionTokenCache = {
      token,
      expiresAt: now + Math.max(60, expiresIn - 120)
    };
  }
  return token;
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
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
    node?.key?.message,
    payload,
    payload?.data,
    payload?.Message,
    payload?.message
  ].filter(Boolean);

  const mediaKeys = [
    'imageMessage',
    'documentMessage',
    'mediaMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage'
  ];

  const buildDownloadMessage = (media, mediaType) => {
    if (!media || !mediaType) return null;
    const cloned = JSON.parse(JSON.stringify(media));
    if (cloned.url && !cloned.URL) cloned.URL = cloned.url;
    if (cloned.mediaUrl && !cloned.URL) cloned.URL = cloned.mediaUrl;
    if (cloned.directPath && !cloned.URL) cloned.URL = cloned.directPath;
    if (cloned.mimetype && !cloned.mimeType) cloned.mimeType = cloned.mimetype;
    return {
      [mediaType]: cloned,
      mimeType: cloned.mimeType || cloned.mimetype || '',
      url: cloned.URL || cloned.url || cloned.mediaUrl || cloned.directPath || '',
      fileName: cloned.fileName || cloned.filename || '',
      headers: cloned.headers || {},
      downloadMessage: { [mediaType]: cloned },
      base64: cloned.base64 || cloned.inlineBase64 || cloned.rawBase64 || cloned.payloadBase64 || cloned.content || cloned.data || ''
    };
  };

  const collectBase64FromNode = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return '';
    return (
      candidate?.base64 ||
      candidate?.inlineBase64 ||
      candidate?.rawBase64 ||
      candidate?.payloadBase64 ||
      candidate?.content ||
      candidate?.data ||
      candidate?.Message?.base64 ||
      candidate?.Message?.inlineBase64 ||
      candidate?.Message?.rawBase64 ||
      candidate?.Message?.payloadBase64 ||
      candidate?.message?.base64 ||
      candidate?.message?.inlineBase64 ||
      candidate?.message?.rawBase64 ||
      candidate?.message?.payloadBase64 ||
      candidate?.data?.base64 ||
      candidate?.data?.inlineBase64 ||
      candidate?.data?.rawBase64 ||
      candidate?.data?.payloadBase64 ||
      ''
    );
  };

  for (const candidate of candidates) {
    const base64Value = collectBase64FromNode(candidate);
    const inlineBuffer = bufferFromInlineBase64(base64Value || candidate);
    if (inlineBuffer && inlineBuffer.length) {
      return {
        mimeType: String(candidate?.mimeType || candidate?.mimetype || 'image/jpeg'),
        url: candidate?.url || candidate?.URL || candidate?.mediaUrl || candidate?.directPath || '',
        fileName: candidate?.fileName || candidate?.filename || '',
        headers: candidate?.headers || {},
        base64: base64Value || candidate?.base64 || candidate?.inlineBase64 || candidate?.rawBase64 || candidate?.payloadBase64 || candidate?.content || candidate?.data || ''
      };
    }

    for (const mediaKey of mediaKeys) {
      const media = candidate?.[mediaKey] || candidate?.message?.[mediaKey] || candidate?.Message?.[mediaKey];
      if (!media) continue;

      const descriptor = buildDownloadMessage(media, mediaKey);
      if (!descriptor) continue;
      if (!descriptor.url && !descriptor.downloadMessage && !descriptor.base64) continue;
      return descriptor;
    }
  }

  return null;
}

// ----------------------------------------------------
// Conversation router
// ----------------------------------------------------
async function routeMessage(phone, text, session, context = {}) {
  const normalized = normalizeText(text);
  const hasOcrText = Boolean(context?.hasOcrText);

  if (/^(bot|agente|volver al bot|retomar bot|activar bot)$/i.test(normalized)) {
    disableHumanHandoff(session);
    return '🤖 *Asistente reactivado*\n\nYa puedo ayudarte nuevamente con medicamentos y pedidos.';
  }

  if (isHumanRequest(normalized)) {
    enableHumanHandoff(session);
    return buildHumanAgentMessage();
  }

  if (session.humanHandoff) {
    return null;
  }

  if (/^(listo|resumen)\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  if (isThanksMessage(normalized)) {
    return 'Con gusto. Estoy aquí para ayudarte cuando necesites buscar otro medicamento.';
  }

  if (isLocationQuestion(normalized)) {
    return buildLocationMessage();
  }

  if (isMoreInfoRequest(normalized)) {
    return buildMoreInfoMessage();
  }

  if (isPreviousCatalogRequest(normalized)) {
    const snapshot = getPreviousCatalogSnapshot(session) || getLatestCatalogSnapshot(session);
    if (!snapshot) {
      return '⚠️ Aún no tengo una lista anterior para mostrarte. Busca un medicamento primero.';
    }

    session.pendingSelectionResults = Array.isArray(snapshot.options) ? snapshot.options : null;
    session.mode = session.pendingSelectionResults && session.pendingSelectionResults.length ? 'awaiting_choice_global' : 'awaiting_product_name';
    touchSession(session);
    return snapshot.message || '🔎 *Lista anterior*\n\nBusca nuevamente el medicamento para volver a mostrar opciones.';
  }

  const directMedicineQuery = extractMedicineQuery(text);
  const medicineRequests = extractMedicineRequests(text);
  const hasSelectionResults = Array.isArray(session.pendingSelectionResults) && session.pendingSelectionResults.length > 0;
  const selectionCandidate = hasOcrText ? null : parseSelectionCommand(normalized);
  const hasMedicineSearchSignal = Boolean(
    directMedicineQuery ||
    medicineRequests.length > 0 ||
    isProductSearchRequest(normalized) ||
    (!selectionCandidate && looksLikeMedicineName(normalized) && !isSelectionPhrase(normalized))
  );

  if (hasOcrText && !hasSelectionResults) {
    clearSelectionState(session);
    return await searchAndBuildCatalogResponse(text, session);
  }

  if (hasMedicineSearchSignal && (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global' || hasSelectionResults)) {
    clearSelectionState(session);
    return await searchAndBuildCatalogResponse(text, session);
  }

  if (selectionCandidate && hasSelectionResults) {
    const results = resolveSelectionResults(session);
    const optionList = Array.isArray(selectionCandidate.options) && selectionCandidate.options.length
      ? selectionCandidate.options
      : [selectionCandidate.option].filter(Boolean);
    const quantity = Number(selectionCandidate.quantity) || 1;
    const selectedItems = [];
    const missingOptions = [];

    for (const optionNumber of optionList) {
      const selected = results[optionNumber - 1];
      if (!selected) {
        missingOptions.push(optionNumber);
        continue;
      }

      addItemToCart(session, selected, quantity);
      pushSelectionHistory(session, selected, quantity);
      selectedItems.push({ selected, quantity });
    }

    if (selectedItems.length) {
      touchSession(session);
      const savedLines = ['✅ *Agregado a tu selección*', ''];
      selectedItems.forEach(({ selected, quantity }, index) => {
        const title = selected.title || 'Medicamento';
        const usdUnit = selected.priceUsd !== null ? `$${formatPrice(selected.priceUsd)}` : 'No disponible';
        const bsUnit = selected.priceBs !== null ? `Bs ${formatPrice(selected.priceBs)}` : 'No disponible';
        const totalUsd = selected.priceUsd !== null ? `$${formatPrice((Number(selected.priceUsd) || 0) * quantity)}` : 'No disponible';
        const totalBs = selected.priceBs !== null ? `Bs ${formatPrice((Number(selected.priceBs) || 0) * quantity)}` : 'No disponible';
        savedLines.push(`${index + 1}. 💊 *${title}*`);
        savedLines.push(`   Cantidad: *${quantity}*`);
        savedLines.push(`   Unitario: ${usdUnit}  |  ${bsUnit}`);
        savedLines.push(`   Subtotal: ${totalUsd}  |  ${totalBs}`);
        savedLines.push('');
      });
      const { totalUsd, totalBs } = getCartTotals(session);
      savedLines.push(`🧾 Tu carrito actual: *$${formatPrice(totalUsd)}*  |  *Bs ${formatPrice(totalBs)}*`);
      if (missingOptions.length) {
        savedLines.push(`⚠️ No encontré la opción *${missingOptions.join(', ')}* en la lista actual.`);
      }
      savedLines.push('Puedes seguir agregando opciones de esta misma lista o escribir *LISTO* para ver el pedido completo.');
      return savedLines.join('\n').trim();
    }

    return `⚠️ No encontré ninguna de las opciones solicitadas: *${optionList.join(', ')}*.`;
  }

  if (selectionCandidate && (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global')) {
    return '⚠️ Primero debes ver los resultados del catálogo. Busca el medicamento y luego escribe el número de opción y la cantidad.';
  }

  if (selectionCandidate && isSelectionPhrase(normalized)) {
    const results = resolveSelectionResults(session);
    if (!results.length) {
      return '⚠️ Para agregar un producto, primero necesito la lista de opciones del medicamento. Busca el medicamento y luego escribe el número de opción y la cantidad.';
    }

    const optionList = Array.isArray(selectionCandidate.options) && selectionCandidate.options.length
      ? selectionCandidate.options
      : [selectionCandidate.option].filter(Boolean);
    const quantity = Number(selectionCandidate.quantity) || 1;
    const selectedItems = [];
    const missingOptions = [];

    for (const optionNumber of optionList) {
      const selected = results[optionNumber - 1];
      if (!selected) {
        missingOptions.push(optionNumber);
        continue;
      }

      addItemToCart(session, selected, quantity);
      pushSelectionHistory(session, selected, quantity);
      selectedItems.push({ selected, quantity });
    }

    if (!selectedItems.length) {
      return `⚠️ No encontré ninguna de las opciones solicitadas: *${optionList.join(', ')}*.`;
    }

    touchSession(session);
    const savedLines = ['✅ *Agregado a tu selección*', ''];
    selectedItems.forEach(({ selected, quantity }, index) => {
      const title = selected.title || 'Medicamento';
      const usdUnit = selected.priceUsd !== null ? `$${formatPrice(selected.priceUsd)}` : 'No disponible';
      const bsUnit = selected.priceBs !== null ? `Bs ${formatPrice(selected.priceBs)}` : 'No disponible';
      const totalUsd = selected.priceUsd !== null ? `$${formatPrice((Number(selected.priceUsd) || 0) * quantity)}` : 'No disponible';
      const totalBs = selected.priceBs !== null ? `Bs ${formatPrice((Number(selected.priceBs) || 0) * quantity)}` : 'No disponible';
      savedLines.push(`${index + 1}. 💊 *${title}*`);
      savedLines.push(`   Cantidad: *${quantity}*`);
      savedLines.push(`   Unitario: ${usdUnit}  |  ${bsUnit}`);
      savedLines.push(`   Subtotal: ${totalUsd}  |  ${totalBs}`);
      savedLines.push('');
    });
    const { totalUsd, totalBs } = getCartTotals(session);
    savedLines.push(`🧾 Tu carrito actual: *$${formatPrice(totalUsd)}*  |  *Bs ${formatPrice(totalBs)}*`);
    if (missingOptions.length) {
      savedLines.push(`⚠️ No encontré la opción *${missingOptions.join(', ')}* en la lista actual.`);
    }
    savedLines.push('Puedes seguir agregando opciones de esta misma lista o escribir *LISTO* para ver el pedido completo.');
    return savedLines.join('\n').trim();
  }

  if (session.mode === 'awaiting_choice') {
    const selectionIntent = selectionCandidate || isSelectionIntent(normalized);
    const results = resolveSelectionResults(session);
    if (selectionCandidate) {
      const selected = results[selectionCandidate.option - 1];
      if (!selected) {
        return `⚠️ La opción *${selectionCandidate.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
      }

      addItemToCart(session, selected, selectionCandidate.quantity);
      touchSession(session);
      clearSelectionState(session);

      return formatSelectionSavedMessage(selected, selectionCandidate.quantity, session);
    }

    if (!selectionIntent) {
      clearSelectionState(session);
    } else {
      return '⚠️ Escribe solo el número de opción y la cantidad. Ejemplos: *1 2*, *opción 1 cantidad 2*, *agregar 1 x 2*';
    }
  }

  if (session.mode === 'awaiting_choice_global') {
    const selectionIntent = selectionCandidate || isSelectionIntent(normalized);
    const results = resolveSelectionResults(session);
    if (selectionCandidate) {
      const selected = results[selectionCandidate.option - 1];
      if (!selected) {
        return `⚠️ La opción global *${selectionCandidate.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
      }

      addItemToCart(session, selected, selectionCandidate.quantity);
      touchSession(session);
      clearSelectionState(session);

      return formatSelectionSavedMessage(selected, selectionCandidate.quantity, session);
    }

    if (!selectionIntent) {
      clearSelectionState(session);
    } else {
      return '⚠️ Escribe solo el número global de opción y la cantidad. Ejemplos: *1 2*, *opción 1 cantidad 2*, *agregar 1 x 2*';
    }
  }

  const medicineSearchIntent = Boolean(
    directMedicineQuery ||
    medicineRequests.length > 0 ||
    (!isSelectionPhrase(normalized) && /(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina|dosis|presentacion|presentación)/.test(normalized)) ||
    (!isSelectionPhrase(normalized) && /\b(tienes?|tiene|hay|busco|busca|quiero|necesito|precio|costo|disponible|disponibilidad|medicamento|medicamentos|producto|productos)\b/.test(normalized))
  );

  if (medicineSearchIntent && !isGreetingOrMenu(normalized)) {
    if (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global' || session.mode === 'awaiting_product_name') {
      clearSelectionState(session);
    }
    return await searchAndBuildCatalogResponse(text, session);
  }

  if (isGreetingOrMenu(normalized)) {
    clearSelectionState(session);
    if (session.mode === 'awaiting_product_name') {
      return buildMenuMessage();
    }
    if (/^hola\b|^buenas\b|^ey\b|^alo\b/i.test(normalized)) {
      return buildMenuMessage();
    }
  }

  if (shouldSendInstagramReel(normalized, session)) {
    return buildInstagramReelMessage();
  }

  if (isInstagramInfoRequest(normalized)) {
    return buildInstagramReelMessage();
  }

  if (/^(resumen|listo)\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  if (session.mode === 'awaiting_choice') {
    const medicineRequests = extractMedicineRequests(text);
    if (medicineRequests.length > 0 || isProductSearchRequest(normalized)) {
      clearSelectionState(session);
      return await searchAndBuildCatalogResponse(text, session);
    }

    const parsed = parseSelectionCommand(normalized);
    if (parsed) {
      const results = session.pendingSelectionResults || [];
      const selected = results[parsed.option - 1];
      if (!selected) {
        return `⚠️ La opción *${parsed.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
      }

      addItemToCart(session, selected, parsed.quantity);
      touchSession(session);
      clearSelectionState(session);

      return formatSelectionSavedMessage(selected, parsed.quantity, session);
    }

    if (!isSelectionIntent(normalized)) {
      clearSelectionState(session);
    } else {
      return '⚠️ Escribe el número de opción y la cantidad. Ejemplos: *1 2*, *opción 1 cantidad 2*, *agregar 1 x 2*';
    }
  }

  if (session.mode === 'awaiting_choice_global') {
    const medicineRequests = extractMedicineRequests(text);
    if (medicineRequests.length > 0 || isProductSearchRequest(normalized)) {
      clearSelectionState(session);
      return await searchAndBuildCatalogResponse(text, session);
    }

    const parsed = parseSelectionCommand(normalized);
    if (parsed) {
      const results = session.pendingSelectionResults || [];
      const selected = results[parsed.option - 1];
      if (!selected) {
        return `⚠️ La opción global *${parsed.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
      }

      addItemToCart(session, selected, parsed.quantity);
      touchSession(session);
      clearSelectionState(session);

      return formatSelectionSavedMessage(selected, parsed.quantity, session);
    }

    if (!isSelectionIntent(normalized)) {
      clearSelectionState(session);
    } else {
      return '⚠️ Escribe el número global de opción y la cantidad. Ejemplos: *1 2*, *opción 1 cantidad 2*, *agregar 1 x 2*';
    }
  }

  if (session.mode === 'awaiting_product_name') {
    return await searchAndBuildCatalogResponse(text, session);
  }

  const multiMedicineRequests = extractMedicineRequests(text);
  if (multiMedicineRequests.length > 1) {
    return await searchAndBuildCatalogResponse(text, session);
  }

  const medicineQuery = extractMedicineQuery(text);
  if (isProductSearchRequest(normalized) || looksLikeMedicineName(normalized) || medicineQuery) {
    const productQuery = medicineQuery || text;
    const searchResult = await searchMedicinesByName(productQuery);

    if (!searchResult || !searchResult.matches.length) {
      session.mode = 'awaiting_product_name';
      return buildNoMatchMessage(productQuery);
    }

    session.pendingSelectionResults = searchResult.matches;
    session.mode = 'awaiting_choice';
    touchSession(session);

    return buildCatalogResponse(searchResult);
  }

  return buildMenuMessage();
}

function buildMenuMessage() {
  return `🏥 *GENTEFARMA*\n\n¡Hola! Soy *Robi*, el asistente virtual de Gentefarma. 🤖👋\n\nEstoy aquí para ayudarte a encontrar el medicamento que necesitas de forma rápida y sencilla.\n\n👉 Escríbeme el nombre del medicamento que estás buscando y te digo si está disponible.\n\nEjemplos:\n*atamel* ·\n*amoxicilina* ·\n*losartan*`;
}

function buildNoMatchMessage(query) {
  return `⚠️ *${query}* no está disponible en este momento.\n\nPrueba con otro nombre del medicamento o una presentación distinta.\nEjemplos:\n• *oxacilina*\n• *oxacilina 500mg*\n• *otro nombre del medicamento*`;
}

function buildNoMatchListMessage() {
  return `⚠️ Esa consulta no está disponible en este momento.\n\nPrueba enviándola de nuevo, uno por línea, por ejemplo:\n• Candesartan 160mg\n• Clopidogrel 75mg\n• Omeprazol 20mg`;
}

function buildSearchDiagnosticMessage(result, query) {
  const lines = [
    `🔎 *${result.query || query}*`,
    result.exchangeRate ? `💱 Tasa BCV: *Bs ${formatPrice(result.exchangeRate)}*` : null,

    ''
  ].filter(Boolean);
  lines.push('');

  (result.matches || []).forEach((item, index) => {
    const title = shortenText(item.title || 'Medicamento', 52);
    const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    lines.push(`💊 *${index + 1}. ${title}*`);
    lines.push(`   ${usdText}  |  ${bsText}`);
    lines.push('');
  });

  lines.push('👉 Para agregar: quiero X cajas de la opción Z');
  lines.push('Ejemplo: quiero 2 cajas de la opción 3');
  lines.push('🛒 ¿Otro medicamento? Escríbeme el nombre y lo agrego a tu lista.');
  lines.push('✅ Cuando termines, escribe *LISTO* y te muestro el resumen.');

  return lines.join('\n').trim();
}

function buildHumanAgentMessage() {
  return `👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.\n\nMientras esperas, también puedo ayudarte a buscar un medicamento.`;
}

function buildLocationMessage() {
  return `¡Hola!. Somos una plataforma online, no tenemos local físico. A través de nuestra web o número de WhatsApp te ayudamos a buscar tus medicinas y comparar precios, para que encuentres la opción que más te convenga. Sin salir de casa 😉. Visita http://www.gentefarma.com o escríbenos por WhatsApp y te ayudamos a gestionar tu pedido. 🙌`;
}

function buildMoreInfoMessage() {
  return `¡Hola! gracias por tu mensaje. Somos una plataforma online, no tenemos local físico. A través de nuestra web o número de WhatsApp te ayudamos a buscar tus medicinas y comparar precios, para que encuentres la opción que más te convenga. Sin salir de casa 😉. Visita http://www.gentefarma.com o escríbenos por WhatsApp y te ayudamos a gestionar tu pedido. 🙌\n\nhttps://www.instagram.com/reel/DU3hPpJDquf/?igsh=MWJnczFxMDgyMTh3aQ==`;
}

function isLocationQuestion(value) {
  const text = normalizeText(value);
  return /\b(donde estan ubicados|donde estan|ubicados|ubicacion|ubicación|direccion|dirección|local fisico|local físico|tienen local|donde queda|dónde queda)\b/.test(text);
}

function isMoreInfoRequest(value) {
  const text = normalizeText(value);
  return /\b(hola.*mas informacion|hola.*informacion|hola.*info|hola.*quiero mas informacion|hola.*quiero mas info|quiero mas informacion|quiero mas info|mas informacion|más informacion|informacion|info)\b/.test(text);
}

function shouldSendInstagramReel(value) {
  const text = normalizeText(value);
  const isGentefarmaContext = /\b(gentefarma|farmacia|farmacias|como funciona|cómo funciona|beneficios|promocion|promoción|promo|planes|servicio|servicios|pedido|pedidos|catalogo|catálogo|quienes somos|quiénes somos)\b/.test(text);
  const asksForMedia = /\b(reel|video|video de presentacion|presentacion|presentación|instagram|redes|publicacion|publicación)\b/.test(text);
  const wantsInfo = /\b(quiero|necesito|me interesa|puedo ver|dame|envíame|enviame|mostrar|muéstrame|mostrame)\b/.test(text);

  return Boolean((isGentefarmaContext && wantsInfo) || asksForMedia);
}

// ----------------------------------------------------
// Catalog search
// ----------------------------------------------------
async function searchAndBuildCatalogResponse(text, session) {
  if (!db) {
    return '⚠️ No tengo conexión al catálogo en este momento. Intenta de nuevo más tarde.';
  }

  const requestedMedicines = extractMedicineRequests(text);
  const fallbackMedicines = extractMedicineRequestsFromSegments(text);
  const recipeLineMedicines = typeof extractRecipeMedicineLines === 'function' ? extractRecipeMedicineLines(text) : [];
  const candidateMedicines = dedupeStrings([
    ...requestedMedicines,
    ...fallbackMedicines,
    ...recipeLineMedicines
  ]);

  if (candidateMedicines.length > 1) {
    const exchangeRate = await getBcvRate();
    const products = await fetchCatalogProducts(2000);
    const groups = [];
    const missingMedicines = [];
    const missingMedicineSet = new Set();

    for (const medicineQuery of candidateMedicines) {
      const result = await searchMedicinesByName(medicineQuery, { products, exchangeRate, strictListMode: true });
      if (result && result.matches && result.matches.length) {
        groups.push(result);
      } else {
        const normalizedMissing = normalizeText(medicineQuery);
        if (normalizedMissing && !missingMedicineSet.has(normalizedMissing)) {
          missingMedicineSet.add(normalizedMissing);
          missingMedicines.push(medicineQuery);
        }
      }
    }

    if (groups.length > 0 || missingMedicines.length > 0) {
      const flattenedOptions = flattenCatalogResults(groups);
      session.lastSearch = groups[0] || null;
      session.pendingSelectionResults = flattenedOptions.length ? flattenedOptions : null;
      session.mode = flattenedOptions.length ? 'awaiting_choice_global' : 'awaiting_product_name';
      rememberCatalogSnapshot(session, flattenedOptions, candidateMedicines.join(' • '), buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines));
      touchSession(session);
      return buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines);
    }

    session.mode = 'awaiting_product_name';
    return buildNoMatchListMessage();
  }

  const singleQuery = candidateMedicines[0] || extractMedicineQuery(text) || text;
  const result = await searchMedicinesByName(singleQuery);

  if (!result || !result.matches.length) {
    session.mode = 'awaiting_product_name';
    return `⚠️ *${singleQuery.trim()}* no está disponible en este momento.\n\nIntenta con el nombre del medicamento o una presentación distinta.\nEjemplos:\n• *atamel*\n• *histaler ped*\n• *desloratadina*\n• *ibuprofeno*`;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  touchSession(session);
  rememberCatalogSnapshot(session, result.matches, result.query || singleQuery, buildSearchDiagnosticMessage(result, singleQuery));

  return buildSearchDiagnosticMessage(result, singleQuery);
}

async function searchMedicinesByName(userQuery, options = {}) {
  if (!db) return null;

  const strictListMode = Boolean(options.strictListMode);
  const strictReferenceThreshold = strictListMode ? 0.93 : 0.88;

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!queryTokens.length) return null;

  const exchangeRate = options.exchangeRate ?? await getBcvRate();
  const products = options.products ?? await fetchCatalogProducts(2000);
  const catalogHealth = summarizeCatalogHealth(products);
  if (catalogHealth.available === 0) {
    return { query, queryTokens, exchangeRate, matches: [] };
  }

  const exactQuery = query;
  const exactRoot = queryTokens.join(' ');
  const dosageLessQuery = queryTokens
    .filter((token) => !/^(\d+(?:[.,]\d+)?)$/.test(token))
    .filter((token) => !/^(mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/.test(token))
    .join(' ')
    .trim();
  const matchQuery = dosageLessQuery || query;
  const matchTokens = tokenize(matchQuery).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!matchTokens.length) return { query, queryTokens, exchangeRate, matches: [] };

  const isDosageToken = (token) => /^(\d+(?:[.,]\d+)?)$/.test(token) || /^(mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/.test(token);
  const focusTokens = matchTokens.filter((token) => !isDosageToken(token));
  const primaryTokens = focusTokens.length ? focusTokens : matchTokens;
  const primaryRoot = primaryTokens.join(' ');
  const dosagePattern = /\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|gr|ml|cc|ui|iu)\b/gi;
  const extractDosageSignatures = (value) => {
    const normalizedValue = normalizeText(value);
    if (!normalizedValue) return [];
    const signatures = [];
    let match;
    while ((match = dosagePattern.exec(normalizedValue))) {
      const amount = String(match[1]).replace(',', '.');
      const unit = String(match[2]).replace(/mL/i, 'ml').toLowerCase();
      signatures.push(`${amount}${unit}`);
    }
    dosagePattern.lastIndex = 0;
    return [...new Set(signatures)];
  };
  const queryDosageSignatures = extractDosageSignatures(query);
  const hasQueryDosage = queryDosageSignatures.length > 0;

  function jaroWinklerSimilarity(a, b) {
    const left = normalizeText(a);
    const right = normalizeText(b);
    if (!left || !right) return 0;
    if (left === right) return 1;

    const leftLen = left.length;
    const rightLen = right.length;
    const matchDistance = Math.max(Math.floor(Math.max(leftLen, rightLen) / 2) - 1, 0);

    const leftMatches = new Array(leftLen).fill(false);
    const rightMatches = new Array(rightLen).fill(false);

    let matches = 0;
    for (let i = 0; i < leftLen; i++) {
      const start = Math.max(0, i - matchDistance);
      const end = Math.min(i + matchDistance + 1, rightLen);
      for (let j = start; j < end; j++) {
        if (rightMatches[j]) continue;
        if (left[i] !== right[j]) continue;
        leftMatches[i] = true;
        rightMatches[j] = true;
        matches += 1;
        break;
      }
    }

    if (!matches) return 0;

    let transpositions = 0;
    for (let i = 0, j = 0; i < leftLen; i++) {
      if (!leftMatches[i]) continue;
      while (j < rightLen && !rightMatches[j]) j += 1;
      if (j < rightLen && left[i] !== right[j]) transpositions += 1;
      j += 1;
    }

    transpositions /= 2;

    const jaro = (
      (matches / leftLen) +
      (matches / rightLen) +
      ((matches - transpositions) / matches)
    ) / 3;

    let prefix = 0;
    for (let i = 0; i < Math.min(4, leftLen, rightLen); i++) {
      if (left[i] !== right[i]) break;
      prefix += 1;
    }

    return jaro + (prefix * 0.1 * (1 - jaro));
  }

  function tokenSimilarity(a, b) {
    const left = normalizeText(a);
    const right = normalizeText(b);
    if (!left || !right) return 0;
    if (left === right) return 1;

    const maxLen = Math.max(left.length, right.length);
    const lengthGap = Math.abs(left.length - right.length);
    if (lengthGap > 4) return 0;

    const distance = levenshteinDistance(left, right);
    const jw = jaroWinklerSimilarity(left, right);

    if (maxLen <= 5) {
      return (distance <= 1 || jw >= 0.94) ? Math.max(1 - (distance / maxLen), jw) : 0;
    }

    if (maxLen <= 8) {
      return (distance <= 2 || jw >= 0.9) ? Math.max(1 - (distance / maxLen), jw) : 0;
    }

    return (distance <= 3 || jw >= 0.84) ? Math.max(1 - (distance / maxLen), jw) : 0;
  }
  const vitaminPhrases = extractVitaminFocusPhrases(matchQuery);
  const vitaminFocusWord = extractVitaminFocusTokens(matchQuery)[0] || '';
  const isVitaminQuery = /\bvitamina\b/.test(matchQuery) || /\bvit\.?\b/.test(matchQuery);

  function buildCatalogSignal(doc) {
    const productTitleFull = normalizeText(doc?.ProductTitle || '');
    const titleArrayTextFull = Array.isArray(doc?.productTitleArray)
      ? normalizeText(doc.productTitleArray.join(' '))
      : '';
    const ingredient = normalizeText(doc?.activeIngredient || doc?.active_ingredient || doc?.ingredient || '');
    const productText = normalizeText(buildProductSearchText(doc));
    const titleTokens = tokenize(productTitleFull);
    const arrayTokens = tokenize(titleArrayTextFull);
    const ingredientTokens = tokenize(ingredient);
    const searchTokens = tokenize([productTitleFull, titleArrayTextFull, ingredient, productText].filter(Boolean).join(' '));
    const tokenSet = new Set([...titleTokens, ...arrayTokens, ...ingredientTokens, ...searchTokens]);

    return {
      doc,
      title: buildShortProductLabel(doc),
      productTitleFull,
      titleArrayTextFull,
      ingredient,
      productText,
      titleTokens,
      arrayTokens,
      ingredientTokens,
      searchTokens,
      tokenSet
    };
  }

  function signalHasToken(signal, token) {
    if (!token) return false;
    if (signal.tokenSet.has(token)) return true;

    const normalizedToken = normalizeText(token);
    if (!normalizedToken) return false;

    return signal.searchTokens.includes(normalizedToken)
      || signal.titleTokens.includes(normalizedToken)
      || signal.arrayTokens.includes(normalizedToken)
      || signal.ingredientTokens.includes(normalizedToken);
  }

  function signalMatchesVitaminFocus(signal, focus) {
    if (!focus) return false;

    const normalizedFocus = normalizeText(focus);
    const hasVitaminFamily = signalHasToken(signal, 'vitamina') || signalHasToken(signal, 'vit');
    const hasFocusToken = signalHasToken(signal, normalizedFocus);
    const titlePhraseHit = signal.productTitleFull.includes(`vitamina ${normalizedFocus}`) || signal.titleArrayTextFull.includes(`vitamina ${normalizedFocus}`);
    const compactPhraseHit = signal.productTitleFull.includes(`vit ${normalizedFocus}`) || signal.titleArrayTextFull.includes(`vit ${normalizedFocus}`);

    return (hasVitaminFamily && hasFocusToken) || titlePhraseHit || compactPhraseHit;
  }

  function scoreSignal(signal) {
    let score = 0;

    const tokenHitsTitle = primaryTokens.filter((token) => signal.titleTokens.includes(token)).length;
    const tokenHitsArray = primaryTokens.filter((token) => signal.arrayTokens.includes(token)).length;
    const tokenHitsIngredient = primaryTokens.filter((token) => signal.ingredientTokens.includes(token)).length;
    const bestTokenHits = Math.max(tokenHitsTitle, tokenHitsArray, tokenHitsIngredient);
    const strongTokenCoverage = primaryTokens.length > 0 && bestTokenHits / primaryTokens.length >= 0.8;
    const fullFocusMatch = primaryTokens.length > 0 && (
      (tokenHitsTitle === primaryTokens.length) ||
      (tokenHitsArray === primaryTokens.length) ||
      (tokenHitsIngredient === primaryTokens.length)
    );

    const referenceCandidates = [matchQuery, primaryRoot, exactRoot].filter(Boolean);
    const candidateTexts = [signal.productTitleFull, signal.titleArrayTextFull, signal.ingredient, signal.productText].filter(Boolean);
    let referenceSimilarity = 0;
    for (const reference of referenceCandidates) {
      for (const candidateText of candidateTexts) {
        const similarity = jaroWinklerSimilarity(reference, candidateText);
        if (similarity > referenceSimilarity) referenceSimilarity = similarity;
        if (referenceSimilarity >= 0.98) break;
      }
      if (referenceSimilarity >= 0.98) break;
    }

    const candidateDosageSignatures = extractDosageSignatures([signal.productTitleFull, signal.titleArrayTextFull, signal.ingredient, signal.productText].filter(Boolean).join(' '));
    const dosageExactMatch = !hasQueryDosage || queryDosageSignatures.some((sig) => candidateDosageSignatures.includes(sig));

    if (signal.productTitleFull === matchQuery) score += 600;
    if (signal.titleArrayTextFull === matchQuery) score += 560;
    if (signal.ingredient === matchQuery) score += 420;

    if (referenceSimilarity >= strictReferenceThreshold + 0.03) score += 420;
    else if (referenceSimilarity >= strictReferenceThreshold) score += 260;
    else if (referenceSimilarity >= strictReferenceThreshold - 0.03) score += strictListMode ? 80 : 120;
    else if (strictListMode) score -= 500;

    if (signal.productTitleFull.includes(matchQuery) || matchQuery.includes(signal.productTitleFull)) score += 320;
    if (signal.titleArrayTextFull.includes(matchQuery) || matchQuery.includes(signal.titleArrayTextFull)) score += 280;
    if (signal.ingredient.includes(matchQuery) || matchQuery.includes(signal.ingredient)) score += 200;

    if (hasQueryDosage && !dosageExactMatch) score -= strictListMode ? 700 : 500;
    if (hasQueryDosage && dosageExactMatch) score += 260;

    if (primaryTokens.length > 1) {
      if (signal.productTitleFull.includes(primaryRoot)) score += 240;
      if (signal.titleArrayTextFull.includes(primaryRoot)) score += 260;
      if (signal.ingredient.includes(primaryRoot)) score += 160;
      if (primaryRoot && signal.productText.includes(primaryRoot)) score += 120;
    }

    if (hasQueryDosage) {
      const queryHasAmount = /\b\d+(?:[.,]\d+)?\b/.test(query);
      const queryHasUnit = /\b(mg|mcg|g|gr|ml|cc|ui|iu)\b/.test(query);
      const candidateText = [signal.productTitleFull, signal.titleArrayTextFull, signal.ingredient, signal.productText].filter(Boolean).join(' ');
      const candidateHasAmount = /\b\d+(?:[.,]\d+)?\b/.test(candidateText);
      const candidateHasUnit = /\b(mg|mcg|g|gr|ml|cc|ui|iu)\b/.test(candidateText);
      if (queryHasAmount && queryHasUnit && !(candidateHasAmount && candidateHasUnit)) {
        score -= strictListMode ? 800 : 600;
      }
    }

    if (primaryTokens.length > 0) {
      score += (tokenHitsTitle / primaryTokens.length) * 180;
      score += (tokenHitsArray / primaryTokens.length) * 240;
      score += (tokenHitsIngredient / primaryTokens.length) * 120;
    }

    for (const token of primaryTokens) {
      if (signal.productTitleFull.includes(token)) score += 28;
      if (signal.titleArrayTextFull.includes(token)) score += 42;
      if (signal.ingredient.includes(token)) score += 16;

      if (!signal.productTitleFull.includes(token) && !signal.titleArrayTextFull.includes(token) && !signal.ingredient.includes(token)) {
        let bestSimilarity = 0;
        for (const candidate of [...signal.titleTokens, ...signal.arrayTokens, ...signal.ingredientTokens]) {
          const similarity = tokenSimilarity(token, candidate);
          if (similarity > bestSimilarity) bestSimilarity = similarity;
          if (bestSimilarity >= 0.92) break;
        }

        if (bestSimilarity >= 0.95) score += 24;
        else if (bestSimilarity >= 0.9) score += 18;
        else if (bestSimilarity >= 0.85) score += 10;
        else if (bestSimilarity >= 0.8) score += 4;
      }
    }

    if (primaryTokens.length > 1) {
      if (signal.productTitleFull.startsWith(primaryRoot)) score += 120;
      if (signal.titleArrayTextFull.startsWith(primaryRoot)) score += 160;
      if (signal.ingredient.startsWith(primaryRoot)) score += 70;
    }

    if (strongTokenCoverage) score += 120;
    if (fullFocusMatch) score += 260;
    else if (primaryTokens.length > 1 && bestTokenHits === 0) score -= 500;
    else if (primaryTokens.length > 1 && bestTokenHits === 1) score -= 220;
    else if (primaryTokens.length > 1 && bestTokenHits === 2) score -= 80;

    if (isVitaminQuery && vitaminFocusWord && signalMatchesVitaminFocus(signal, vitaminFocusWord)) {
      score += 420;
    }

    if (isVitaminQuery && vitaminPhrases.length) {
      for (const phrase of vitaminPhrases) {
        if (signal.productTitleFull.includes(phrase) || signal.titleArrayTextFull.includes(phrase) || signal.ingredient.includes(phrase)) {
          score += 300;
          break;
        }
      }
    }

    const exactPhraseHit = Boolean(
      signal.productTitleFull === matchQuery ||
      signal.titleArrayTextFull === matchQuery ||
      signal.productTitleFull.includes(matchQuery) ||
      signal.titleArrayTextFull.includes(matchQuery) ||
      signal.ingredient.includes(matchQuery)
    );

    const phraseHit = primaryTokens.length > 1 && (
      signal.productTitleFull.includes(matchQuery) ||
      signal.titleArrayTextFull.includes(matchQuery) ||
      signal.ingredient.includes(matchQuery) ||
      signal.productTitleFull.includes(primaryRoot) ||
      signal.titleArrayTextFull.includes(primaryRoot) ||
      signal.ingredient.includes(primaryRoot) ||
      (isVitaminQuery && vitaminPhrases.some((phrase) => signal.productTitleFull.includes(phrase) || signal.titleArrayTextFull.includes(phrase) || signal.ingredient.includes(phrase)))
    );

    return {
      score,
      referenceSimilarity,
      tokenHitsTitle,
      tokenHitsArray,
      tokenHitsIngredient,
      bestTokenHits,
      strongTokenCoverage,
      fullFocusMatch,
      exactPhraseHit,
      phraseHit,
      dosageExactMatch,
      vitaminHit: isVitaminQuery
        ? (vitaminFocusWord
            ? signalMatchesVitaminFocus(signal, vitaminFocusWord)
            : (signalHasToken(signal, 'vitamina') || signalHasToken(signal, 'vit')))
        : false,
      titleContentMatch: signal.productTitleFull.includes(matchQuery) || matchQuery.includes(signal.productTitleFull),
      arrayContentMatch: signal.titleArrayTextFull.includes(matchQuery) || matchQuery.includes(signal.titleArrayTextFull)
    };
}

  const scoredProducts = products
    .map((doc) => {
      const signal = buildCatalogSignal(doc);
      const metrics = scoreSignal(signal);
      const basePriceUsd = getPrice(doc);
      const basePriceBs = getPriceBs(doc, exchangeRate);
      const pricing = applySalesPricing(basePriceUsd, exchangeRate);
      const exactHit = metrics.exactPhraseHit || metrics.strongTokenCoverage || metrics.vitaminHit || metrics.titleContentMatch || metrics.arrayContentMatch;

      return {
        ...signal,
        score: metrics.score,
        referenceSimilarity: metrics.referenceSimilarity,
        exactHit,
        fullFocusMatch: metrics.fullFocusMatch,
        phraseHit: metrics.phraseHit,
        vitaminHit: metrics.vitaminHit,
        tokenCoverage: Math.max(metrics.tokenHitsTitle, metrics.tokenHitsArray, metrics.tokenHitsIngredient),
        basePriceUsd,
        basePriceBs,
        priceUsd: pricing.displayUsd,
        priceBs: pricing.displayBs,
        feeRate: pricing.feeRate,
        feeAmountUsd: pricing.feeAmountUsd
      };
    })
    .sort((a, b) => {
      const vitaminA = a.vitaminHit ? 1 : 0;
      const vitaminB = b.vitaminHit ? 1 : 0;
      if (vitaminA !== vitaminB) return vitaminB - vitaminA;

      const exactA = a.exactHit ? 1 : 0;
      const exactB = b.exactHit ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;

      const phraseA = a.phraseHit ? 1 : 0;
      const phraseB = b.phraseHit ? 1 : 0;
      if (phraseA !== phraseB) return phraseB - phraseA;

      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;

      const priceA = a.priceUsd ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.priceUsd ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  let candidateMatches = [];

  if (isVitaminQuery) {
    const focusedVitaminMatches = scoredProducts.filter((item) => item.vitaminHit);

    if (!focusedVitaminMatches.length) {
      return { query, queryTokens, exchangeRate, matches: [] };
    }

    candidateMatches = focusedVitaminMatches;
  } else {
    const similarityMatches = scoredProducts.filter((item) => item.fullFocusMatch || item.exactHit || item.phraseHit || (item.score ?? 0) >= 120 || (item.referenceSimilarity ?? 0) >= 0.93);
    candidateMatches = similarityMatches.filter((item) => {
      if (item.fullFocusMatch || item.exactHit || item.phraseHit) return true;
      return (item.referenceSimilarity ?? 0) >= 0.93 || (item.score ?? 0) >= 180;
    });

    if (hasQueryDosage) {
      candidateMatches = candidateMatches.filter((item) => {
        const candidateText = [item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText].filter(Boolean).join(' ');
        const candidateHasAmount = /\b\d+(?:[.,]\d+)?\b/.test(candidateText);
        const candidateHasUnit = /\b(mg|mcg|g|gr|ml|cc|ui|iu)\b/.test(candidateText);
        return candidateHasAmount && candidateHasUnit && item.dosageExactMatch;
      });

      if (!candidateMatches.length) {
        const relaxedTokens = primaryTokens.length > 0 ? primaryTokens : matchTokens;
        candidateMatches = scoredProducts.filter((item) => {
          const candidateText = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText].filter(Boolean).join(' '));
          if (!candidateText) return false;

          const tokenOverlap = relaxedTokens.some((token) => candidateText.includes(token));
          const dosageOverlap = candidateText.includes(matchQuery) || candidateText.includes(dosageLessQuery) || candidateText.includes(exactRoot);
          const relaxedScore = (item.score ?? 0) >= 80 || item.fullFocusMatch || item.exactHit || item.phraseHit;

          return tokenOverlap && (dosageOverlap || relaxedScore);
        });
      }
    }

    if (!candidateMatches.length) {
      const queryCore = normalizeText(dosageLessQuery || exactRoot || query);
      const alternativeTokens = tokenize(queryCore).filter((token) => !STOPWORDS.has(token) && token.length > 1);
      const degradedMatches = scoredProducts.filter((item) => {
        const candidateCore = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
        if (!candidateCore) return false;

        const tokenOverlap = alternativeTokens.length === 0
          ? candidateCore.includes(queryCore)
          : alternativeTokens.some((token) => {
              if (candidateCore.includes(token)) return true;
              return tokenize(candidateCore).some((candidateToken) => tokenSimilarity(token, candidateToken) >= 0.9);
            });

        const dosageOverlap = !hasQueryDosage || candidateCore.includes(matchQuery) || candidateCore.includes(dosageLessQuery) || candidateCore.includes(exactRoot);
        const softScore = (item.score ?? 0) >= 40 || (item.referenceSimilarity ?? 0) >= 0.78 || item.fullFocusMatch || item.exactHit || item.phraseHit;

        return tokenOverlap && (dosageOverlap || softScore);
      });

      if (degradedMatches.length) {
        candidateMatches = degradedMatches;
      }
    }

    if (!candidateMatches.length) {
      return { query, queryTokens, exchangeRate, matches: [] };
    }
  }

  const topMatches = candidateMatches
    .slice(0, 5)
    .sort((a, b) => {
      const exactA = a.exactHit ? 1 : 0;
      const exactB = b.exactHit ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;

      const phraseA = a.phraseHit ? 1 : 0;
      const phraseB = b.phraseHit ? 1 : 0;
      if (phraseA !== phraseB) return phraseB - phraseA;

      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;

      const priceA = a.priceUsd ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.priceUsd ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  const normalizedQuery = normalizeText(query);
  const normalizedQueryTokens = tokenize(normalizedQuery).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  const leadingQueryTokens = normalizedQueryTokens.slice(0, 3);
  const isShortNonDosageQuery = !isVitaminQuery && !hasQueryDosage && normalizedQueryTokens.length <= 2;
  const isSingleTokenQuery = !isVitaminQuery && !hasQueryDosage && normalizedQueryTokens.length === 1;
  const strictQueryTokens = isSingleTokenQuery ? normalizedQueryTokens : leadingQueryTokens;

  const filteredTopMatches = strictQueryTokens.length
    ? topMatches.filter((item) => {
        const candidateText = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
        if (!candidateText) return false;

        if (isSingleTokenQuery) {
          const queryToken = strictQueryTokens[0];
          const candidateTokens = tokenize(candidateText);
          const exactWordMatch = candidateTokens.includes(queryToken) || candidateText.includes(` ${queryToken} `) || candidateText.startsWith(`${queryToken} `) || candidateText.endsWith(` ${queryToken}`) || candidateText === queryToken;
          const closeWordMatch = exactWordMatch || candidateTokens.some((candidateToken) => tokenSimilarity(queryToken, candidateToken) >= 0.95);
          return closeWordMatch;
        }

        return strictQueryTokens.every((token) => {
          if (candidateText.includes(token)) return true;
          for (const candidateToken of tokenize(candidateText)) {
            if (candidateToken === token) return true;
            const similarity = tokenSimilarity(token, candidateToken);
            if (similarity >= 0.9) return true;
          }
          return false;
        });
      })
    : topMatches;

  const finalMatches = isShortNonDosageQuery
    ? filteredTopMatches
    : (filteredTopMatches.length ? filteredTopMatches : topMatches);

  return {
    query,
    queryTokens,
    exchangeRate,
    matches: finalMatches.map((item) => ({
      title: item.title,
      basePriceUsd: item.priceUsd,
      basePriceBs: item.priceBs,
      priceUsd: item.priceUsd,
      priceBs: item.priceBs,
      feeRate: item.feeRate,
      feeAmountUsd: item.feeAmountUsd,
      raw: item.doc,
      score: item.score,
      phraseHit: item.phraseHit,
      tokenCoverage: item.tokenCoverage,
      exactHit: item.exactHit,
      focusTitleHit: item.vitaminHit
    }))
  };
}

function buildCatalogResponse(result) {
  if (!result || !result.matches || !result.matches.length) {
    return '⚠️ Necesito un poco más de detalle para ayudarte.';
  }

  const lines = [];
  lines.push(`🔎 *${result.query}*`);
  if (result.exchangeRate) {
    lines.push(`💱 Tasa BCV: *Bs ${formatPrice(result.exchangeRate)}*`);
  }
  lines.push('');

  result.matches.forEach((item, index) => {
    const title = shortenText(item.title || 'Medicamento', 52);
    const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    lines.push(`💊 *${index + 1}. ${title}*`);
    lines.push(`   ${usdText}  |  ${bsText}`);
    lines.push('');
  });

  lines.push('');
  lines.push('👉 Para agregar: quiero X cajas de la opción Z');
  lines.push('Ejemplo: quiero 2 cajas de la opción 3');
  lines.push('🛒 ¿Otro medicamento? Escríbeme el nombre y lo agrego a tu lista.');
  lines.push('✅ Cuando termines, escribe *LISTO* y te muestro el resumen.');

  return lines.join('\n').trim();
}

function buildMultiCatalogResponse(results, flatOptions = [], missingMedicines = []) {
  if (!Array.isArray(results) || !results.length) {
    const missingLines = Array.isArray(missingMedicines) && missingMedicines.length
      ? [
          '⚠️ Algunos medicamentos no están disponibles en este momento:',
          ...missingMedicines.map((item) => `• *${item}*`),
          '',
          'Te muestro los que sí encontré abajo.'
        ]
      : ['⚠️ Necesito un poco más de detalle para ayudarte.'];

    return missingLines.join('\n').trim();
  }

  const lines = [];
  lines.push('🔎 *Resultados encontrados*');
  lines.push('');

  if (Array.isArray(missingMedicines) && missingMedicines.length) {
    lines.push('⚠️ *No disponibles:*');
    missingMedicines.forEach((item) => {
      lines.push(`• *${item}*`);
    });
    lines.push('');
    lines.push('Te muestro los que sí encontré abajo.');
    lines.push('');
  }

  let optionNumber = 1;
  results.forEach((result) => {
    const groupTitle = shortenText(String(result.groupTitle || result.query || 'MEDICAMENTO').toUpperCase(), 52);
    lines.push(`*${groupTitle}*`);

    (result.matches || []).forEach((item) => {
      const name = shortenText(item.title || 'Medicamento', 52);
      const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
      const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
      lines.push(`💊 ${optionNumber}. ${name}`);
      lines.push(`   ${usdText}  |  ${bsText}`);
      optionNumber += 1;
    });

    lines.push('');
  });

  lines.push('');
  lines.push('👉 Para agregar: quiero X cajas de la opción Z');
  lines.push('Ejemplo: quiero 2 cajas de la opción 3');
  lines.push('🛒 ¿Otro medicamento? Escríbeme el nombre y lo agrego a tu lista.');
  lines.push('✅ Cuando termines, escribe *LISTO* y te muestro el resumen.');

  return lines.join('\n').trim();
}

function extractMedicineRequests(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];

  const rawText = String(text || '').trim();
  if (!rawText) return [];

  const explicitSegments = splitMedicineSegments(rawText);
  const segments = explicitSegments.length > 1 ? explicitSegments : splitSingleLineMedicineList(rawText);
  const results = [];

  for (const segment of segments) {
    const cleaned = normalizeText(segment);
    if (!cleaned) continue;
    if (isGreetingOrMenu(cleaned) || isThanksMessage(cleaned) || /^(listo|resumen)$/i.test(cleaned)) continue;
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)/.test(cleaned)) continue;

    const query = extractMedicineQuery(segment) || cleaned;
    if (!query) continue;

    if (!results.includes(query)) results.push(query);
  }

  return results;
}

function splitMedicineSegments(text) {
  return String(text)
    .split(/\n+|[•·●\-|;]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitSingleLineMedicineList(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const tokens = [...raw.matchAll(/\S+/g)].map((match) => ({
    token: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));

  const anchors = [...raw.matchAll(/\b\d+(?:[.,]\d+)?(?:\s*(?:mg|mcg|g|gr|ml|mL|ui|iu))?\b/gi)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length
    }));

  if (anchors.length < 2 || tokens.length < 2) return [raw];

  const starts = anchors.map((anchor) => {
    let tokenIndex = -1;

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].start <= anchor.start && tokens[i].end >= anchor.start) {
        tokenIndex = i;
        break;
      }
      if (tokens[i].start > anchor.start) break;
    }

    if (tokenIndex < 0) {
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i].end <= anchor.start) {
          tokenIndex = i;
          break;
        }
      }
    }

    if (tokenIndex < 1) return null;

    let startIndex = tokenIndex - 1;
    const prevToken = tokens[startIndex];
    const prevPrevToken = tokens[startIndex - 1];

    if (
      startIndex > 0 &&
      /^[A-ZÁÉÍÓÚÑ]$/.test(prevToken.token) &&
      prevPrevToken &&
      /^[A-ZÁÉÍÓÚÑ]/.test(prevPrevToken.token)
    ) {
      startIndex -= 1;
    }

    return tokens[startIndex].start;
  }).filter((value) => Number.isInteger(value) && value >= 0);

  const uniqueStarts = [...new Set(starts)].sort((a, b) => a - b);
  if (uniqueStarts.length < 2) return [raw];

  const chunks = [];
  for (let i = 0; i < uniqueStarts.length; i++) {
    const start = uniqueStarts[i];
    const end = i + 1 < uniqueStarts.length ? uniqueStarts[i + 1] : raw.length;
    const chunk = raw.slice(start, end).trim().replace(/^[,;\-–—]+\s*/, '').trim();
    if (chunk) chunks.push(chunk);
  }

  if (!chunks.length) return [raw];
  return chunks;
}

function extractMedicineRequestsFromSegments(text) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];

  const segments = splitMedicineSegments(rawText);
  const pieces = segments.length > 1 ? segments : splitSingleLineMedicineList(rawText);
  const results = [];

  for (const piece of pieces) {
    const cleaned = normalizeText(piece);
    if (!cleaned) continue;
    if (isGreetingOrMenu(cleaned) || isThanksMessage(cleaned) || /^(listo|resumen)$/i.test(cleaned)) continue;
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)/.test(cleaned)) continue;

    const query = extractMedicineQuery(piece) || cleaned;
    if (!query) continue;
    if (!results.includes(query)) results.push(query);
  }

  return results;
}

function dedupeStrings(values) {
  return [...new Set((values || []).map((value) => normalizeText(value)).filter(Boolean))];
}

function looksLikeListToken(token) {
  const value = String(token || '').trim();
  if (!value) return false;
  if (/^[A-ZÁÉÍÓÚÑ]/.test(value)) return true;
  if (/^\d/.test(value)) return true;
  return /^(mg|mcg|g|gr|ml|mL|ui|iu)$/i.test(value);
}

function flattenCatalogResults(results) {
  const flattened = [];
  for (const group of Array.isArray(results) ? results : []) {
    const groupQuery = String(group?.query || '').trim();
    const groupLabel = String(group?.groupTitle || group?.title || groupQuery || 'Medicamento').trim();
    for (const item of group?.matches || []) {
      flattened.push({
        groupQuery,
        groupTitle: groupLabel,
        ...item
      });
    }
  }
  return flattened;
}

function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;
  if (!docText) return 0;

  const productTitle = normalizeText(doc?.ProductTitle || buildShortProductLabel(doc));
  const titleArray = Array.isArray(doc?.productTitleArray)
    ? doc.productTitleArray.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  const titleArrayText = titleArray.join(' ');
  const activeIngredient = normalizeText(doc?.activeIngredient || doc?.active_ingredient || doc?.ingredient || '');
  const searchArea = [docText, productTitle, titleArrayText, activeIngredient].filter(Boolean).join(' | ');
  const searchTokens = tokenize(searchArea).filter((t) => t.length > 1);
  const phraseQuery = queryTokens.join(' ');
  const querySet = new Set(queryTokens);
  const multiWord = queryTokens.length > 1;

  const queryHasVitalsFocus = queryTokens.includes('vitamina') || /^vit(?:amina)?$/i.test(query);
  const titleTokens = tokenize(productTitle);
  const ingredientTokens = tokenize(activeIngredient);
  const arrayTokenSet = new Set(titleArray);

  const arrayExactTokenHits = queryTokens.filter((token) => arrayTokenSet.has(token)).length;
  const titleExactTokenHits = queryTokens.filter((token) => titleTokens.includes(token)).length;
  const ingredientExactTokenHits = queryTokens.filter((token) => ingredientTokens.includes(token)).length;

  const fullTitleMatchesQuery = productTitle === query;
  const fullArrayMatchesQuery = titleArrayText === query;
  const fullIngredientMatchesQuery = activeIngredient && activeIngredient === query;

  if (fullTitleMatchesQuery) score += 500;
  if (fullArrayMatchesQuery) score += 420;
  if (fullIngredientMatchesQuery) score += 350;

  if (productTitle.includes(query) || query.includes(productTitle)) score += 260;
  if (titleArrayText.includes(query) || query.includes(titleArrayText)) score += 220;
  if (activeIngredient && (activeIngredient.includes(query) || query.includes(activeIngredient))) score += 180;

  if (multiWord && phraseQuery) {
    if (productTitle.includes(phraseQuery)) score += 300;
    if (titleArrayText.includes(phraseQuery)) score += 260;
    if (activeIngredient.includes(phraseQuery)) score += 220;
  }

  if (queryTokens.length > 0) {
    score += (titleExactTokenHits / queryTokens.length) * 180;
    score += (arrayExactTokenHits / queryTokens.length) * 240;
    score += (ingredientExactTokenHits / queryTokens.length) * 120;
  }

  for (const token of queryTokens) {
    if (productTitle.includes(token)) score += 30;
    if (titleArrayText.includes(token)) score += 40;
    if (activeIngredient.includes(token)) score += 18;

    if (!productTitle.includes(token) && !titleArrayText.includes(token) && !activeIngredient.includes(token)) {
      let bestDistance = Infinity;
      for (const candidate of searchTokens) {
        if (candidate === token) {
          bestDistance = 0;
          break;
        }
        if (Math.abs(candidate.length - token.length) > 3) continue;
        const distance = levenshteinDistance(token, candidate);
        if (distance < bestDistance) bestDistance = distance;
        if (bestDistance <= 1) break;
      }

      if (bestDistance <= 1) score += 20;
      else if (bestDistance === 2) score += 12;
      else if (bestDistance === 3) score += 6;
    }
  }

  if (multiWord) {
    const titleStartsWithPhrase = productTitle.startsWith(phraseQuery);
    const arrayStartsWithPhrase = titleArrayText.startsWith(phraseQuery);
    const ingredientStartsWithPhrase = activeIngredient.startsWith(phraseQuery);
    if (titleStartsWithPhrase) score += 120;
    if (arrayStartsWithPhrase) score += 150;
    if (ingredientStartsWithPhrase) score += 80;
  }

  if (queryHasVitalsFocus && arrayExactTokenHits > 0) score += 90;
  if (queryHasVitalsFocus && productTitle.includes('vitamina')) score += 50;

  return score;
}

function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;

  if (!m) return n;
  if (!n) return m;

  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }

  return prev[n];
}

function buildShortProductLabel(doc) {
  return (
    doc?.ProductTitle ||
    doc?.productTitle ||
    doc?.name ||
    doc?.productName ||
    doc?.medicineName ||
    doc?.medication ||
    doc?.title ||
    doc?.description ||
    'Medicamento'
  );
}

function buildProductSearchText(doc) {
  const titleArray = Array.isArray(doc?.productTitleArray) ? doc.productTitleArray.join(' ') : '';

  return [
    doc?.ProductTitle,
    doc?.productTitle,
    titleArray,
    doc?.name,
    doc?.productName,
    doc?.medicineName,
    doc?.medication,
    doc?.brand,
    doc?.commercialName,
    doc?.activeIngredient,
    doc?.description,
    doc?.presentation,
    doc?.form,
    doc?.dosage,
    doc?.strength,
    doc?.concentration,
    doc?.category,
    doc?.aliases,
    doc?.keywords
  ]
    .flat()
    .filter(Boolean)
    .join(' ');
}

function getPrice(doc) {
  const raw =
    doc?.ProductPrice ??
    doc?.productPrice ??
    doc?.price ??
    doc?.Price ??
    doc?.bestPrice ??
    doc?.amount ??
    doc?.salePrice ??
    doc?.unitPrice ??
    doc?.Valor ??
    doc?.valor ??
    null;

  if (raw === null || raw === undefined || raw === '') return null;

  const normalized = String(raw)
    .replace(/\s/g, '')
    .replace(',', '.')
    .match(/-?\d+(\.\d+)?/);

  return normalized ? Number(normalized[0]) : null;
}

async function getBcvRate() {
  if (!db) return null;

  try {
    const snapshot = await db.collection('divisabcv').limit(1).get();
    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    const data = doc.data() || {};
    const candidate = data?.DivisaBs;

    const rate = candidate !== null && candidate !== undefined
      ? Number(String(candidate).replace(',', '.'))
      : null;

    if (!rate || rate <= 0) return null;
    return rate;
  } catch (error) {
    console.error('❌ Error leyendo tasa BCV:', error.message);
    return null;
  }
}

// Estrategia comercial fácil de ajustar en el futuro.
const SALES_FEE_RULES = {
  thresholdUsd: 20,
  feeUnderThreshold: 0.03,
  feeAtOrAboveThreshold: 0.05
};

function applySalesPricing(baseUsd, exchangeRate) {
  if (baseUsd === null || baseUsd === undefined || Number.isNaN(Number(baseUsd))) {
    return { baseUsd: null, feeRate: null, feeAmountUsd: null, displayUsd: null, displayBs: null };
  }

  const amount = Number(baseUsd);
  const feeRate = amount < SALES_FEE_RULES.thresholdUsd
    ? SALES_FEE_RULES.feeUnderThreshold
    : SALES_FEE_RULES.feeAtOrAboveThreshold;
  const feeAmountUsd = amount * feeRate;
  const displayUsd = amount + feeAmountUsd;
  const displayBs = exchangeRate ? displayUsd * exchangeRate : null;

  return { baseUsd: amount, feeRate, feeAmountUsd, displayUsd, displayBs };
}

function getPriceBs(doc, exchangeRate) {
  const usd = getPrice(doc);
  if (usd === null || !exchangeRate) return null;
  return usd * exchangeRate;
}

function formatPrice(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function shortenText(value, maxLength = 52) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

// ----------------------------------------------------
// Firestore helpers
// ----------------------------------------------------
async function fetchCollectionDocuments(collectionName, limit = 500) {
  if (!db) return [];

  try {
    const snapshot = await db.collection(collectionName).limit(limit).get();
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (error) {
    console.error(`❌ Error leyendo colección ${collectionName}:`, error.message);
    return [];
  }
}

async function fetchCatalogProducts(limit = 500) {
  const primary = await fetchCollectionDocuments('products-market', limit);
  if (primary.length) return primary;

  const fallback = await fetchCollectionDocuments('providers-products', limit);
  if (fallback.length) return fallback;

  return [];
}

function summarizeCatalogHealth(products) {
  const list = Array.isArray(products) ? products : [];
  const withTitle = list.filter((doc) => normalizeText(buildShortProductLabel(doc))).length;
  const withSearchText = list.filter((doc) => normalizeText(buildProductSearchText(doc))).length;
  return {
    total: list.length,
    available: Math.max(withTitle, withSearchText)
  };
}

// ----------------------------------------------------
// WhatsApp send via Evolution GO
// ----------------------------------------------------
async function sendOutboundWhatsAppMessage(phone, text) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/send/text`,
      {
        number: phone,
        text,
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

    const sentMessageId =
      response?.data?.key?.id ||
      response?.data?.messageId ||
      response?.data?.data?.key?.id ||
      response?.data?.data?.messageId ||
      null;

    registerOutboundMessageId(sentMessageId);

    console.log('✅ Mensaje enviado por WhatsApp:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.response?.data || error.message);
    throw error;
  }
}

// ----------------------------------------------------
// Evolution payload extractors
// ----------------------------------------------------
function unwrapMessagePayload(payload) {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = unwrapMessagePayload(item);
      if (found) return found;
    }
    return null;
  }

  if (payload.Info || payload.Message || payload.key || payload.message) return payload;
  if (payload.data) {
    const data = payload.data;
    if (Array.isArray(data)) return unwrapMessagePayload(data);
    if (data.Info || data.Message || data.key || data.message) return data;
    if (Array.isArray(data.messages) && data.messages.length) return unwrapMessagePayload(data.messages[0]);
    if (data.value) return unwrapMessagePayload(data.value);
    return unwrapMessagePayload(data);
  }

  if (Array.isArray(payload.messages) && payload.messages.length) return unwrapMessagePayload(payload.messages[0]);
  if (payload.value) return unwrapMessagePayload(payload.value);

  return payload;
}

function extractJidValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/([0-9]{5,})(?=@s\.whatsapp\.net|@lid|$)/i);
  if (match) return match[1];
  return raw
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/:\d+$/, '')
    .trim();
}

function extractFrom(payload) {
  const node = unwrapMessagePayload(payload) || {};
  const jid =
    node?.Info?.Sender ||
    node?.Info?.Chat ||
    node?.Sender ||
    node?.sender ||
    node?.from ||
    node?.key?.remoteJid ||
    node?.message?.key?.remoteJid ||
    node?.data?.key?.remoteJid ||
    node?.messages?.[0]?.key?.remoteJid ||
    '';

  return extractJidValue(jid);
}

function extractBody(payload) {
  const node = unwrapMessagePayload(payload) || {};
  return (
    node?.Message?.conversation ||
    node?.Message?.extendedTextMessage?.text ||
    node?.Message?.text ||
    node?.message?.conversation ||
    node?.message?.extendedTextMessage?.text ||
    node?.message?.text ||
    node?.body ||
    node?.text ||
    node?.data?.body ||
    node?.data?.text ||
    node?.messages?.[0]?.message?.conversation ||
    node?.messages?.[0]?.message?.extendedTextMessage?.text ||
    node?.messages?.[0]?.message?.text ||
    ''
  );
}

function extractFromMe(payload) {
  const node = unwrapMessagePayload(payload) || {};
  return Boolean(
    node?.Info?.IsFromMe ??
    node?.fromMe ??
    node?.key?.fromMe ??
    node?.message?.key?.fromMe ??
    node?.data?.fromMe ??
    node?.messages?.[0]?.key?.fromMe ??
    false
  );
}

function extractRecipient(payload) {
  const node = unwrapMessagePayload(payload) || {};
  const jid =
    node?.Info?.RecipientAlt ||
    node?.Info?.Chat ||
    node?.RecipientAlt ||
    node?.recipient ||
    node?.to ||
    node?.key?.remoteJid ||
    node?.message?.key?.remoteJid ||
    node?.data?.key?.remoteJid ||
    '';

  return String(jid)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/:\d+$/, '')
    .trim();
}

// ----------------------------------------------------
// Text helpers
// ----------------------------------------------------
const STOPWORDS = new Set([
  'quiero',
  'busco',
  'buscar',
  'precio',
  'precios',
  'costo',
  'cuanto',
  'cuánto',
  'medicamento',
  'medicamentos',
  'producto',
  'productos',
  'farmacia',
  'farmacias',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'por',
  'favor',
  'hola',
  'buenos',
  'buenas',
  'menu',
  'menú',
  'ayuda',
  'pedir',
  'pedido',
  'comprar',
  'tienes',
  'tiene',
  'hay'
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function sanitizeRecipeText(value) {
  const raw = String(value || '');
  if (!raw) return '';

  const lines = raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const removalPatterns = [
    /^(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro|dr\.?|dra\.?|doctor|doctora|medico|médico|medica|médica)\b/i,
    /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\s+[a-záéíóúñ\s]+$/i,
    /^(fecha|edad|sexo|peso|talla|ci|c.i.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección)\b/i,
    /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/,
    /^(?:edad|peso|talla|ci|c.i.|cedula|cédula)[:\s]+[\w\d.,-]+$/i
  ];

  const cleaned = lines.filter((line) => !removalPatterns.some((pattern) => pattern.test(line)));
  return cleaned.join('\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function extractRecipeMedicineLines(value) {
  const raw = String(value || '');
  if (!raw) return [];

  const lines = raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const metaPatterns = [
    /^(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro)\b/i,
    /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i,
    /^(fecha|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección)\b/i,
    /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/,
    /^(?:edad|peso|talla|ci|c\.i\.|cedula|cédula)[:\s]+[\w\d.,-]+$/i
  ];

  const formOrDose = /\b(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)\b/i;
  const candidates = [];

  for (const line of lines) {
    const normalized = normalizeText(line);
    if (!normalized) continue;
    if (metaPatterns.some((pattern) => pattern.test(line) || pattern.test(normalized))) continue;
    if (isGreetingOrMenu(normalized) || isThanksMessage(normalized) || /^(listo|resumen)$/i.test(normalized)) continue;
    if (!/[a-záéíóúñ]/i.test(line)) continue;
    if (!formOrDose.test(line) && !/^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s-]{2,}$/i.test(line)) continue;
    if (normalized.split(' ').length > 8) continue;
    candidates.push(line);
  }

  return [...new Set(candidates)];
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function parsePositiveInteger(value) {
  const text = normalizeText(value);
  const match = text.match(/\b([1-9][0-9]*)\b/);
  return match ? Number(match[1]) : null;
}

const GREETING_PHRASES = new Set([
  'hola',
  'hola bot',
  'buen dia',
  'buenos dias',
  'buenas',
  'buenas tardes',
  'buenas noches',
  'ey',
  'alo',
  'aló',
  'menu',
  'menú',
  'ayuda',
]);

function isGreetingOrMenu(value) {
  const text = normalizeText(value);
  if (!text) return false;

  if (GREETING_PHRASES.has(text)) return true;

  return /^(hola|hola bot|buen dia|buenos dias|buenas|buenas tardes|buenas noches|ey|alo|menu|menú|ayuda)\b/.test(text);
}

function extractVitaminFocusTokens(query) {
  const tokens = tokenize(query);
  const focusTokens = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'vitamina' && tokens[i] !== 'vit') continue;

    const next = tokens[i + 1];
    const next2 = tokens[i + 2];

    if (next && !STOPWORDS.has(next) && next !== 'vitamina' && next !== 'vit') {
      if (/^[a-z]$/.test(next) && next2 && /^\d+$/.test(next2)) {
        focusTokens.push(`${next}${next2}`);
      } else {
        focusTokens.push(next);
      }
    }
  }

  return [...new Set(focusTokens.filter(Boolean))];
}

function extractVitaminFocusPhrases(query) {
  const tokens = tokenize(query);
  const phrases = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'vitamina' && tokens[i] !== 'vit') continue;

    const next = tokens[i + 1];
    const next2 = tokens[i + 2];
    if (!next) continue;

    if (/^[a-z]$/.test(next) && next2 && /^\d+$/.test(next2)) {
      phrases.push(`${tokens[i]} ${next}${next2}`);
    } else {
      phrases.push(`${tokens[i]} ${next}`);
    }
  }

  return [...new Set(phrases.filter(Boolean))];
}

function queryHasMultipleWords(query) {
  const meaningful = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  const vitaminFocus = extractVitaminFocusTokens(query);
  return meaningful.length + vitaminFocus.length > 1;
}

function isHumanRequest(value) {
  const text = normalizeText(value);
  return /\b(humano|agente|asesor|persona|operador|atencion humana|atencion al cliente|auxiliar)\b/.test(text);
}

function isBotControlMessage(value) {
  const text = normalizeText(value);
  return /^(bot\s+off|bot\s+on|bot\s+status)$/i.test(text);
}

function isAdminSender(value) {
  const text = normalizeText(value);
  const normalizedAdmin = normalizeText(BOT_ADMIN_NUMBER);
  const compactAdmin = normalizedAdmin.replace(/\s+/g, '');
  const compactText = text.replace(/\s+/g, '');
  return (
    text === normalizedAdmin ||
    compactText === compactAdmin ||
    text === normalizeText(`${BOT_ADMIN_NUMBER}@s.whatsapp.net`)
  );
}

function isProductSearchRequest(value) {
  const text = normalizeText(value);
  return /\b(precio|costo|cuanto cuesta|cuanto vale|catalogo|catalogo de productos|medicamento|producto|buscar)\b/.test(text);
}

function isThanksMessage(value) {
  const text = normalizeText(value);
  return /^(ok\s+)?gracias(\s+.*)?$/.test(text) || /\b(gracias|mil gracias|muchas gracias|thanks|thank you)\b/.test(text);
}

function looksLikeMedicineName(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (isGreetingOrMenu(text) || isThanksMessage(text) || /^(listo|resumen|bot on|bot off|bot status)$/i.test(text)) return false;

  const extracted = extractMedicineQuery(text);
  if (extracted && extracted.length >= 4) {
    const extractedTokens = tokenize(extracted);
    if (extractedTokens.length >= 2) return true;
  }

  const tokens = tokenize(text).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  if (!tokens.length) return false;

  const hasDosageOrForm = /\b(\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|cc|ui|iu)|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina|vit)\b/.test(text);
  const hasUsefulMultiTokenPhrase = tokens.length >= 2;
  const hasStrongSingleToken = tokens.length === 1 && tokens[0].length >= 5 && !/^(precio|costo|catalogo|catálogo|producto|medicamento|buscar|busco|tienes|tiene|hay|disponible|disponibilidad)$/.test(tokens[0]);

  return hasDosageOrForm || hasUsefulMultiTokenPhrase || hasStrongSingleToken;
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

function extractMedicineQuery(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return '';

  const patterns = [
    /(?:^|\s)(?:por\s+favor\s+)?(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?|conoces|vendes|venden)\s+(.+)$/i,
    /^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a)\s+(.+)$/i
  ];

  let candidate = cleaned;
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      candidate = normalizeText(match[1]);
      break;
    }
  }

  candidate = candidate
    .replace(/^(?:por\s+favor\s+)?(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?|saber(?:\s+el)?(?:\s+precio)?(?:\s+de)?|cuanto\s+cuesta|cuánto\s+cuesta|conoces|vendes|venden)\s+/i, '')
    .replace(/^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a|la|el|las|los|unos|unas)\s+/i, '')
    .trim();

  candidate = candidate
    .replace(/^(?:saber|precio|costo|valor|consulta|consultar)\s+/i, '')
    .trim();

  const vitaminDirectMatch = candidate.match(/\bvitamina\s+([a-z]\d*|\d+[a-z]?)(?:\b|\s|$)/i);
  if (vitaminDirectMatch) {
    return `vitamina ${normalizeText(vitaminDirectMatch[1])}`.trim();
  }

  const vitaminLooseMatch = candidate.match(/\bvit\.?\s+([a-z]\d*|\d+[a-z]?)(?:\b|\s|$)/i);
  if (vitaminLooseMatch) {
    return `vitamina ${normalizeText(vitaminLooseMatch[1])}`.trim();
  }

  const tokens = tokenize(candidate)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));

  if (!tokens.length) return '';

  const MED_FORM_TOKENS = new Set([
    'ampolla', 'ampollas', 'vial', 'viales', 'frasco', 'frascos', 'tableta', 'tabletas', 'capsula', 'capsulas',
    'cápsula', 'cápsulas', 'cap', 'caps', 'suspension', 'suspensión', 'susp', 'jarabe', 'gotas', 'crema', 'gel', 'polvo', 'polvos',
    'unguento', 'unguentos', 'sobres', 'sobresa', 'retad', 'retadar', 'retardar', 'retardado', 'retardada', 'capsules', 'tablet', 'tabletass'
  ]);
  const MED_QUERY_WEAK_TOKENS = new Set([
    'precio', 'costo', 'valor', 'consulta', 'consultar', 'saber', 'cuanto', 'cuánto', 'quisiera', 'quiero',
    'hola', 'buenas', 'gracias', 'medicamento', 'medicamentos', 'producto', 'productos', 'favor', 'por', 'favor'
  ]);
  const isDoseToken = (token) => /^(\d+(?:[.,]\d+)?|mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i.test(token);
  const strongTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token));
  const dosageTokens = tokens.filter((token) => isDoseToken(token));
  const formTokens = tokens.filter((token) => MED_FORM_TOKENS.has(token));

  const dosagePattern = /\b(\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?))\b/i;
  const dosageMatch = candidate.match(dosagePattern);
  if (dosageMatch) {
    const dose = normalizeText(dosageMatch[1]);
    const beforeDose = candidate.slice(0, dosageMatch.index).trim();
    const beforeTokens = tokenize(beforeDose).filter((t) => !STOPWORDS.has(t) && t.length > 1);
    if (beforeTokens.length) {
      const prioritizedBefore = [
        ...beforeTokens.filter((token) => !MED_FORM_TOKENS.has(token) && !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token)),
        ...beforeTokens.filter((token) => isDoseToken(token) || MED_FORM_TOKENS.has(token))
      ];
      return [...new Set([...prioritizedBefore, dose])].join(' ').trim();
    }
    return dose;
  }

  const prioritized = [...new Set([
    ...strongTokens,
    ...dosageTokens,
    ...formTokens,
    ...tokens.filter((token) => !strongTokens.includes(token) && !dosageTokens.includes(token) && !formTokens.includes(token) && !MED_QUERY_WEAK_TOKENS.has(token))
  ])].filter(Boolean);

  const meaningful = prioritized.join(' ').trim();
  if (!meaningful) return '';

  return meaningful;
}

// ----------------------------------------------------
// Process safety logs
// ----------------------------------------------------
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// ----------------------------------------------------
// Start
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Gentefarma Webhook Service running on port ${PORT}`);
});
