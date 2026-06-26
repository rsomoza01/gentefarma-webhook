require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const admin = require('firebase-admin');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';
const PORT = process.env.PORT || 3000;
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OCR_PROVIDER = process.env.OCR_PROVIDER || (OPENAI_API_KEY ? 'openai' : 'none');
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
// Google Sheets — Consultas log
// ----------------------------------------------------
const SHEET_ID = '1TRZOXLyQVVCY4T7--UcCAxkciYdr6TpkS4ObKPaigJk';
const SHEET_TAB_NAME = 'Sheet1';
const GOOGLE_TOKEN_PATH = '/opt/data/google_token.json';
const GOOGLE_CLIENT_SECRET_PATH = '/opt/data/google_client_secret.json';

function getSheetsClient() {
  try {
    if (!fs.existsSync(GOOGLE_TOKEN_PATH) || !fs.existsSync(GOOGLE_CLIENT_SECRET_PATH)) {
      return null;
    }
    const token = JSON.parse(fs.readFileSync(GOOGLE_TOKEN_PATH, 'utf8'));
    const clientSecret = JSON.parse(fs.readFileSync(GOOGLE_CLIENT_SECRET_PATH, 'utf8'));
    const oauth2 = new google.auth.OAuth2(
      clientSecret.installed.client_id,
      clientSecret.installed.client_secret,
      clientSecret.installed.redirect_uris[0]
    );
    oauth2.setCredentials(token);
    return google.sheets({ version: 'v4', auth: oauth2 });
  } catch (err) {
    console.warn('⚠️ No se pudo inicializar Google Sheets client:', err.message);
    return null;
  }
}

async function appendConsultationToSheet({ products, exists, phone, userName }) {
  const sheets = getSheetsClient();
  if (!sheets) {
    console.warn('⚠️ Google Sheets no disponible, saltando log de consulta');
    return;
  }
  const now = new Date();
  const fecha = now.toLocaleDateString('es-VE');
  const hora = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  const rows = products.map(p => [fecha, hora, p, exists ? 1 : 0, phone || '', userName || '']);
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:F`,
      valueInputOption: 'RAW',
      resource: { values: rows }
    });
    console.log(`📊 Loggeado a Sheets: ${rows.length} fila(s) — existe=${exists}`);
  } catch (err) {
    console.error('❌ Error escribiendo en Google Sheets:', err.message);
  }
}

// ----------------------------------------------------
// Session memory
// ----------------------------------------------------
const sessions = new Map();
const processedInboundMessages = new Map();
let botEnabled = true;
const ADMIN_NUMBERS = ['584128840350', '584128009482'];
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
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const hasSelectionWords = /\b(opcion|opciones|opci[oó]n|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x|seleccionar|selecciona|elegir|elige|escoger|escoje|agregar|agrega|quiero|quisiera)\b/.test(normalized);
  const hasDosageOrForm = /\b(\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|cc|ui|iu)|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)\b/.test(normalized);
  if (hasDosageOrForm && !hasSelectionWords) return null;


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

  const quantityPatterns = [
    /^(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/i,
    /^(\d+)\s*x\b/i,
    /^(\d+)\s+(?=\d)/i
  ];

  let quantity = 1;
  let optionSource = normalized;

  // First: look for quantity pattern at the START of the string ("2 cajas de la opcion 3")
  for (const pattern of quantityPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      quantity = Number(match[1]) || 1;
      optionSource = normalized.slice(match[0].length).trim();
      break;
    }
  }

  // If no quantity found at start, look for "quiero N cajas" / "dame N" pattern anywhere
  // This handles inputs like "quiero 2 cajas de la opcion 3"
  if (quantity === 1) {
    const inlineQtyMatch = normalized.match(/\b(?:quiero|quisiera|dame|necesito|busco|agregar|agrega)\s+(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)?\b/i);
    if (inlineQtyMatch) {
      quantity = Number(inlineQtyMatch[1]) || 1;
      // Also strip the "quiero N cajas" portion from the option source
      const qtyPhrase = inlineQtyMatch[0];
      const qtyIndex = normalized.indexOf(qtyPhrase);
      if (qtyIndex >= 0) {
        optionSource = normalized.slice(qtyIndex + qtyPhrase.length).trim();
      }
    }
  }

  const optionWordMatch = optionSource.match(/\b(?:opcion|opciones|opci[oó]n)\b/i);
  if (optionWordMatch) {
    optionSource = optionSource.slice(optionWordMatch.index + optionWordMatch[0].length).trim();
  }

  optionSource = optionSource
    .replace(/^\b(?:de|del|la|las|el|los|y|e|con|para)\b\s*/i, '')
    .trim();

  const options = parseOptionList(optionSource);
  if (options.length) {
    return buildResult(options, quantity, normalized);
  }

  const listOnly = parseOptionList(normalized);
  if (listOnly.length >= 2) {
    return buildResult(listOnly, quantity, normalized);
  }

  return null;
}

function isSelectionPhrase(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?|x|opciones|quiero|quisiera|agregar|agrega|seleccionar|selecciona|elegir|elige|escoger|escoje)\b/.test(text) && /\d+/.test(text);
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
    timestamp: new Date().toISOString(),
    commit: '9197e76'
  });
});

// ---------------------------------------------


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
    const rawBody = extractBody(payload) || '';
    const sanitizedOcrText = mediaAnalysis?.text ? sanitizeRecipeText(mediaAnalysis.text) : '';
    const body = mediaAnalysis?.text ? (sanitizedOcrText || rawBody) : rawBody;
    const normalizedBody = normalizeText(body);
    const ocrSearchText = sanitizedOcrText || '';
    const rawOcrText = mediaAnalysis?.text || '';
    const pushName = extractPushName(payload);

    if (mediaAnalysis?.text) {
      console.log('🧾 OCR text extracted:', JSON.stringify(mediaAnalysis.text.slice(0, 500)));
      if (sanitizedOcrText && sanitizedOcrText !== mediaAnalysis.text) {
        console.log('🧽 OCR text sanitized:', JSON.stringify(sanitizedOcrText.slice(0, 500)));
      } else if (!sanitizedOcrText) {
        console.log('🧽 sanitizeRecipeText returned EMPTY — prescription path will retry with rawOcrText');
      }
      console.log('🔎 OCR routed to catalog search:', {
        textLength: mediaAnalysis.text.length,
        sanitizedTextLength: sanitizedOcrText.length,
        rawBody: rawBody.slice(0, 100),
        body: body.slice(0, 100),
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

    // --- Admin: handoff/returnhandoff (procesar antes del gate fromMe) ---
    if (isAdmin && normalizedBody.startsWith('handoff ')) {
      const targetPhone = normalizedBody.replace('handoff ', '').trim();
      if (!targetPhone) {
        await sendOutboundWhatsAppMessage(adminRecipient, '⚠️ Uso: handoff <teléfono>');
        return;
      }
      let targetSession = sessions.get(targetPhone);
      if (!targetSession) {
        targetSession = { mode: 'idle', humanHandoff: false, lastSearch: null, pendingSelectionResults: null };
        sessions.set(targetPhone, targetSession);
      }
      enableHumanHandoff(targetSession);
      await sendOutboundWhatsAppMessage(adminRecipient, `✅ Handoff forzado para ${targetPhone}. El bot no responderá a ese chat hasta que se reactive.`);
      return;
    }

    if (isAdmin && normalizedBody.startsWith('returnhandoff ')) {
      const targetPhone = normalizedBody.replace('returnhandoff ', '').trim();
      if (!targetPhone) {
        await sendOutboundWhatsAppMessage(adminRecipient, '⚠️ Uso: returnhandoff <teléfono>');
        return;
      }
      let targetSession = sessions.get(targetPhone);
      if (!targetSession) {
        targetSession = { mode: 'idle', humanHandoff: false, lastSearch: null, pendingSelectionResults: null };
        sessions.set(targetPhone, targetSession);
      }
      disableHumanHandoff(targetSession);
      await sendOutboundWhatsAppMessage(adminRecipient, `✅ Handoff revertido para ${targetPhone}. El bot vuelve a responder en ese chat.`);
      return;
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

    const response = await routeMessage(from, body, session, { hasOcrText: Boolean(mediaAnalysis?.text), ocrSearchText, rawOcrText, pushName });
    if (response) {
      console.log('📤 Sending WhatsApp response:', response.slice(0, 500));
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
    hasOpenAIKey: Boolean(OPENAI_API_KEY)
  });

  const openaiMimeType = mimeType || 'image/jpeg';
  const tryOpenAI = async (label) => {
    if (!OPENAI_API_KEY) return '';
    const text = await callOpenAIVision(imageBase64, openaiMimeType);
    console.log(`🧪 OCR openai${label ? `(${label})` : ''} result length:`, text ? text.length : 0);
    return text || '';
  };

  if (OCR_PROVIDER === 'openai' && OPENAI_API_KEY) {
    const openaiText = await tryOpenAI('openai');
    if (openaiText) return openaiText;
  }

  if (OCR_PROVIDER === 'auto') {
    if (OPENAI_API_KEY) {
      const openaiText = await tryOpenAI('auto');
      if (openaiText) return openaiText;
    }
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
  const directMedicineQuery = extractMedicineQuery(text);
  const strictConsultationQuery = extractStrictConsultationMedicineQuery(text);
  const extractedMedicineRequests = extractMedicineRequests(text);
  const consultationQuery = strictConsultationQuery || directMedicineQuery || extractedMedicineRequests[0] || text;
  const consultationIsMedicine = isMedicineConsultationPhrase(normalized);
  const isMedicineSignal = Boolean(
    directMedicineQuery ||
    extractedMedicineRequests.length > 0 ||
    isProductSearchRequest(normalized) ||
    looksLikeMedicineName(normalized) ||
    consultationIsMedicine
  );
  const hasOcrText = Boolean(context?.hasOcrText);
  const ocrSearchText = normalizeText(context?.ocrSearchText || '');
  const rawOcrText = String(context?.rawOcrText || '');
  const recipeSourceText = rawOcrText || ocrSearchText;
  const pushName = context?.pushName || '';

  if (isHumanRequest(normalized)) {
    enableHumanHandoff(session);
    return buildHumanAgentMessage();
  }

  if (session.humanHandoff) {
    return null;
  }

  // Early exit para declaraciones de interés en medicamentos — SIEMPRE antes del gate consultationIsMedicine
  if (isMedicineInterestStatement(normalized)) {
    clearSelectionState(session);
    return buildMenuMessage();
  }

  // ── NO-CONSULTA gate ultra-precoz ────────────────────────────────────
  // Rechazar ANTES de consultationIsMedicine para que "ok está bien",
  // scheduling y affirmaciones nunca lleguen a searchAndBuildCatalogResponse
  const URGENT_DENYLIST = [
    /^(?:ok|okay)\s*(?:está\s+(?:bien|perfecto|correcto)|es\s+(?:bien|perfecto)|,$|$)/i,
    /^(?:ok|okay)\s*/i,
    /^(?:está\s+)?bien[,\s].*$/i,
    /^(?:perfecto|de\s+acuerdo|entendido|confirmo|confirmado|hecho)\s*$/i,
    /^(?:si|sí|yes|no|nop|jaja|jajaja|jajajaja)\s*$/i,
    /^(?:muchas?\s+)?gracias?(?:\s+much[oa]s?)?$/i,
    /^(?:hasta|luego|nos\s+vemos|chau|chao)\s*$/i,
    /^a\s+las\s+\d+/i,
    /^para\s+mañana\s+a\s+las/i,
    /^(?:hoy|mañana|pasado\s+mañana)\s+a\s+las/i,
    /^por\s+fa?vor\s*$/i,
    /^(?:cuando|todo\s+bien|que\s+haces?|en\s+que\s+po?demo)\s*/i,
  ];
  if (URGENT_DENYLIST.some((re) => re.test(normalized))) {
    return buildDefaultFallbackMessage(session);
  }

  if (consultationIsMedicine) {
    clearSelectionState(session);
    const searchQuery = consultationQuery || text;
    return await searchAndBuildCatalogResponse(searchQuery, session, { hasOcrText, strictConsultationMode: true, preExtractedMedicines: extractedMedicineRequests }, { phone, pushName });
  }

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

  if (isNewOrderNotification(normalized)) {
    return buildOrderNotificationReply();
  }

  if (isDemoReservation(normalized)) {
    return buildDemoReservationReply();
  }

  if (isDeliveryQuestion(normalized)) {
    return buildDeliveryPriceMessage();
  }

  if (isOrderSentConfirmation(normalized)) {
    return buildOrderSentMessage();
  }

  if (isHowToOrderQuestion(normalized)) {
    return buildHowToOrderMessage();
  }

  if (isAppQuestion(normalized)) {
    return buildAppMessage();
  }

  // Require directMedicineQuery to be meaningful: at least 5 chars AND more than 1 token AND no weak-only tokens.
  // This blocks single generic words like "esta", "hay", "dispone" etc. from triggering
  // a medicine search when the user is actually asking a location/info question.
  const WEAK_QUERY_TOKENS = new Set(['dispone','sabe','hacer','hay','esta','son','es','esta','ests','stat','disponible']);
  let isViableDirectQuery = Boolean(directMedicineQuery && directMedicineQuery.trim().length >= 5);
  if (isViableDirectQuery) {
    const dqTokens = tokenize(directMedicineQuery).filter(t => t.length > 1);
    if (dqTokens.length < 2) isViableDirectQuery = false;
    // Also reject if all tokens are weak/meaningless
    if (isViableDirectQuery && dqTokens.every(t => WEAK_QUERY_TOKENS.has(t))) isViableDirectQuery = false;
  }

  if ((isMedicineConsultationPhrase(normalized) && !isSelectionPhrase(normalized)) || isViableDirectQuery) {
    clearSelectionState(session);
    return await searchAndBuildCatalogResponse(strictConsultationQuery || directMedicineQuery || text, session, { hasOcrText, strictConsultationMode: true }, { phone, pushName });
  }

  if (/^(listo|resumen)\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  // Early exit para declaraciones de interés en medicamentos — siempre muestra bienvenida
  if (isMedicineInterestStatement(normalized)) {
    clearSelectionState(session);
    return buildMenuMessage();
  }

  if (isGreetingOrMenu(normalized) && !isMedicineSignal) {
    clearSelectionState(session);
    if (session.mode === 'awaiting_product_name') {
      return buildMenuMessage();
    }
    if (/^hola\b|^buenas\b|^ey\b|^alo\b/i.test(normalized)) {
      return buildMenuMessage();
    }
  }

  if (isThanksMessage(normalized) && !isMedicineSignal) {
    return 'Con gusto. Estoy aquí para ayudarte cuando necesites buscar otro medicamento.';
  }

  if (isLocationQuestion(normalized)) {
    return buildLocationMessage();
  }

  if (isHorarioQuestion(normalized)) {
    return buildHorarioMessage();
  }

  if (isPagoQuestion(normalized)) {
    return buildPagoMessage();
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

  const medicineRequests = extractMedicineRequests(text);
  const hasSelectionResults = Array.isArray(session.pendingSelectionResults) && session.pendingSelectionResults.length > 0;
  const selectionCandidate = hasOcrText ? null : parseSelectionCommand(normalized);
  const isSelectionMessage = Boolean(selectionCandidate) || isSelectionPhrase(normalized);
  const hasMedicineSearchSignal = Boolean(isMedicineSignal && !isSelectionMessage);

  // When a new OCR image arrives, ALWAYS process it as OCR — even if the previous
  // message left pendingSelectionResults. The user is asking about a NEW image.
  if (hasOcrText) {
    clearSelectionState(session);
    // Try prescription format first (has RP: section with multiple drugs).
    // Then medicine box format (single drug, packaging noise).
    // Then generic recipe cleanup as last resort.
    const rawOcr = recipeSourceText || text;
    console.log('🧾 OCR medicines extraction rawOcr SOURCE:', {
      recipeSourceTextTruthy: Boolean(recipeSourceText),
      recipeSourceText: recipeSourceText?.slice(0, 100),
      text: text?.slice(0, 100)
    });
    console.log('🧾 prescriptionClean CALLING with:', JSON.stringify(rawOcr?.slice(0, 300)));
    const prescriptionClean = sanitizePrescriptionText(rawOcr);
    console.log('🧾 prescriptionClean RESULT:', JSON.stringify(prescriptionClean?.slice(0, 300)));
    console.log('🧾 boxClean CALLING with:', JSON.stringify(rawOcr?.slice(0, 300)));
    const boxClean = sanitizeMedicineBoxText(rawOcr);
    console.log('🧾 boxClean RESULT:', JSON.stringify(boxClean?.slice(0, 300)));
    console.log('🧾 recipeClean CALLING with:', JSON.stringify(rawOcr?.slice(0, 300)));
    const recipeClean = sanitizeRecipeText(rawOcr);
    console.log('🧾 recipeClean RESULT:', JSON.stringify(recipeClean?.slice(0, 300)));

    // Prefer prescription if it extracted multiple lines, else box if single drug, else recipe
    const allRecipeMedicines = prescriptionClean || boxClean || recipeClean;
    const searchQuery = allRecipeMedicines || rawOcr;
    console.log('🧾 OCR medicines extraction:', {
      hasOcrText,
      raw: rawOcr?.slice(0, 200),
      prescriptionClean,
      boxClean,
      recipeClean,
      allRecipeMedicines,
      searchQuery
    });
    // Use the OCR text as the message when available (not the original empty text),
    // so that extractRecipeMedicineLines and other extractors work on the OCR content.
    const messageText = rawOcr || text;
    return await searchAndBuildCatalogResponse(messageText, session, { hasOcrText: true, ocrOnly: true, recipeMode: true }, { phone, pushName });
  }

  if (hasMedicineSearchSignal && (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global' || hasSelectionResults)) {
    clearSelectionState(session);
    return await searchAndBuildCatalogResponse(recipeSourceText || text, session, { hasOcrText }, { phone, pushName });
  }

  // Skip selection block if real medicine names were detected in the text (dose numbers
  // like 75/50/30/10 can trigger parseSelectionCommand incorrectly on multi-medicine queries).
  if (selectionCandidate && hasSelectionResults && medicineRequests.length === 0) {
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

  // Allow new medicine queries to bypass selection warning when in awaiting_choice_global
  // (user sent a new multi-medicine query like "nifedipina de 10 mg" while results were pending)
  const hasNewMedicineQuery = Boolean(directMedicineQuery || extractedMedicineRequests.length > 0);

  if (selectionCandidate && (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global')) {
    if (hasNewMedicineQuery) {
      // New medicine query detected — clear stale selection state and route to search
      clearSelectionState(session);
      return await searchAndBuildCatalogResponse(text, session, { hasOcrText, strictConsultationMode: true, preExtractedMedicines: extractedMedicineRequests }, { phone, pushName });
    }
    return '⚠️ Primero debes ver los resultados del catálogo. Busca el medicamento y luego escribe el número de opción y la cantidad.';
  }

  // Also skip when real medicines detected — route to search instead of selection.
  if (selectionCandidate && isSelectionPhrase(normalized) && medicineRequests.length === 0) {
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
    return await searchAndBuildCatalogResponse(text, session, { hasOcrText, strictConsultationMode: Boolean(isMedicineConsultationPhrase(normalized)) }, { phone, pushName });
  }

  // Early exit para declaraciones de interés en medicamentos — siempre muestra bienvenida
  if (isMedicineInterestStatement(normalized)) {
    clearSelectionState(session);
    return buildMenuMessage();
  }

  if (isGreetingOrMenu(normalized) && !isMedicineSignal) {
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

  if (isMoreInfoRequest(normalized)) {
    return buildInstagramReelMessage();
  }

  if (/^(resumen|listo)\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  if (session.mode === 'awaiting_choice') {
    const medicineRequests = extractMedicineRequests(text);
    if (medicineRequests.length > 0 || isProductSearchRequest(normalized)) {
      clearSelectionState(session);
      return await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
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
      return await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
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
    return await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
  }

  const multiMedicineRequests = extractMedicineRequests(text);
  if (multiMedicineRequests.length > 1) {
    return await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
  }

  // ── NO-CONSULTA gate global en routeMessage ──────────────────────────
  // Antes de intentar cualquier búsqueda de productos, rechazar mensajes
  // que claramente no son consultas de medicamentos (afirmaciones, scheduler, etc.)
  const routeText = normalizeText(text);
  const ROUTE_DENYLIST = [
    /^(?:ok|okay)\s+(?:está\s+)?(?:bien|perfecto|correcto)?$/i,
    /^(?:está\s+)?bien[,\s].*$/i,
    /^(?:perfecto|de\s+acuerdo|entendido|confirmo|confirmado|hecho)\s*$/i,
    /^(?:si|sí|yes|no|nop|jaja|jajaja|jajajaja)\s*$/i,
    /^(?:muchas?\s+)?gracias?(?:\s+much[oa]s?)?$/i,
    /^(?:hasta|luego|nos\s+vemos|chau|chao)\s*$/i,
    /^a\s+las\s+\d+/i,
    /^para\s+mañana\s+a\s+las/i,
    /^(?:hoy|mañana|pasado\s+mañana)\s+a\s+las/i,
    /^por\s+fa?vor\s*$/i,
    /^(?:cuando|todo\s+bien|que\s+haces?|en\s+que\s+po?demo)\s*/i,
    /^(?:ok|okay)\s*/i,
  ];
  if (ROUTE_DENYLIST.some((re) => re.test(routeText))) {
    return buildDefaultFallbackMessage(session);
  }

  const medicineQuery = extractMedicineQuery(text);
  if (isProductSearchRequest(normalized) || looksLikeMedicineName(normalized) || medicineQuery) {
    const productQuery = medicineQuery || text;
    const searchOptions = {
      hasOcrText,
      strictConsultationMode: Boolean(medicineQuery || consultationIsMedicine)
    };
    const searchResult = await searchMedicinesByName(productQuery, searchOptions);

    if (!searchResult || !searchResult.matches.length) {
      session.mode = 'awaiting_product_name';
      return buildNoMatchMessage(productQuery);
    }

    session.pendingSelectionResults = searchResult.matches;
    session.mode = 'awaiting_choice';
    touchSession(session);

    return buildCatalogResponse(searchResult);
  }

  return buildDefaultFallbackMessage(session);
}

function buildMenuMessage() {
  return `🏥 *GENTEFARMA*\n\n¡Hola! Soy *Robi*, el asistente virtual de Gentefarma. 🤖👋\n\nEstoy aquí para ayudarte a encontrar el medicamento que necesitas de forma rápida y sencilla.\n\n👉 Escríbeme el nombre del medicamento que estás buscando y te digo si está disponible.\n\nEjemplos:\n*losartán 50mg* ·\n*amoxicilina 500mg* ·\n*ibuprofeno 400mg*`;
}

function buildNoMatchMessage(query) {
  return `⚠️ *${query}* no está disponible en este momento.\n\nIntenta con el nombre del medicamento o una presentación distinta. Si tienes una receta, enviala en foto y busco los medicamentos por ti.`;
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
  return 'Somos una plataforma que opera por Internet y WhatsApp junto con farmacias aliadas. No disponcemos de local físico.';
}

function buildMoreInfoMessage() {
  return `¡Hola! gracias por tu mensaje. Somos una plataforma online, no tenemos local físico. A través de nuestra web o número de WhatsApp te ayudamos a buscar tus medicinas y comparar precios, para que encuentres la opción que más te convenga. Sin salir de casa 😉. Visita http://www.gentefarma.com o escríbenos por WhatsApp y te ayudamos a gestionar tu pedido. 🙌\n\nhttps://www.instagram.com/reel/DU3hPpJDquf/?igsh=MWJnczFxMDgyMTh3aQ==`;
}

function buildOrderNotificationReply() {
  return 'En breve, uno de nuestros colaboradores de Gentefarma se pondrá en contacto contigo para tramitarlo. 😊';
}

function buildDefaultFallbackMessage(session) {
  enableHumanHandoff(session);
  return '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.\n\nMientras esperas, también puedo ayudarte a buscar un medicamento.';
}

function buildDeliveryPriceMessage() {
  return 'Realizamos deliveries en Ciudad Bolívar. Consulta el costo según tu zona.';
}

function isHorarioQuestion(value) {
  const text = normalizeText(value);
  return /\b(horario|atienden|abren|cierran|abre|cierra|a qué hora|hora de|a qué hora abren|a qué hora cierran|están abiertos|están cerrados|jornada|atención|horas de)\b/.test(text);
}

function buildHorarioMessage() {
  return 'Atendemos de 7:00 AM a 8:00 PM.';
}

function isPagoQuestion(value) {
  const text = normalizeText(value);
  return /\b(pago|pagan|pagó|pagamos|aceptan|aceptamos|formas de pago|medios de pago|cuáles son las formas|cuáles pagan|cócmo pago|cómo pagan|payment|transferencia|zelle|efectivo|bs|bolívares|pago móvil|pago movíl)\b/.test(text);
}

function buildPagoMessage() {
  return 'Aceptamos Pago Móvil.';
}

function buildHowToOrderMessage() {
  return 'Claro 😊 Solo busca el medicamento, elige la opción que prefieras y escribe la cantidad. Si necesitas ayuda, te puedo orientar paso a paso.';
}

function buildAppMessage() {
  return 'La aplicación de Gentefarma te permite buscar productos y gestionar pedidos. Si quieres, te explico cómo usarla.';
}

function buildOrderSentMessage() {
  return 'Perfecto, ya lo recibimos. En breve uno de nuestros colaboradores de Gentefarma se pondrá en contacto contigo. 😊';
}

function isNewOrderNotification(value) {
  const text = normalizeText(value);
  return /\bnuevo\s+pedido\s+gentefarma\b/.test(text)
    && /\bresumen\s+del\s+pedido\b/.test(text)
    && /\bmonto\s+total\s+general\b/.test(text);
}

function isDemoReservation(value) {
  const text = normalizeText(value);
  return /\bse\s+ha\s+realizado\s+una\s+reserva\s+para\s+una\s+demo\b/.test(text);
}

function buildDemoReservationReply() {
  return 'Gracias por su interés en la DEMO de Gentefarma, nuestro colaborador, Roberto Somoza, le contactará para enviarle el link de Google Meet de la video llamada.';
}

function isDeliveryQuestion(value) {
  const text = normalizeText(value);
  return /\b(cuanto sale el delivery|cuánto sale el delivery|precio del delivery|costo del delivery|costo envio|costo de envio|cuanto cobran por envio|cuánto cobran por envío|envio|envío)\b/.test(text);
}

function isOrderSentConfirmation(value) {
  const text = normalizeText(value);
  return /\b(acabo de enviar el pedido|acabo de mandar el pedido|ya envie el pedido|ya envié el pedido|ya mande el pedido|ya mandé el pedido|pedido enviado|ya lo envie|ya lo envié|ya lo mande|ya lo mandé)\b/.test(text);
}

function isHowToOrderQuestion(value) {
  const text = normalizeText(value);
  return /\b(no entiendo como hacer el pedido|no entiendo como pedir|como hacer el pedido|cómo hacer el pedido|como hago el pedido|cómo hago el pedido|como se hace el pedido|cómo se hace el pedido|explicame como pedir|explícame como pedir|ayuda para pedir)\b/.test(text);
}

function isAppQuestion(value) {
  const text = normalizeText(value);
  return /\b(aplicacion de gentefarma|aplicación de gentefarma|app de gentefarma|como usar la app|cómo usar la app|aplicacion gentefarma|aplicación gentefarma|app gentefarma)\b/.test(text);
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
async function searchAndBuildCatalogResponse(text, session, options = {}, userInfo = {}) {
  if (!db) {
    return '⚠️ No tengo conexión al catálogo en este momento. Intenta de nuevo más tarde.';
  }

  const ocrOnly = Boolean(options.ocrOnly);
  const consultationMode = Boolean(options.strictConsultationMode);
  const forceExactConsultationToken = Boolean(options.forceExactConsultationToken);
  const preExtracted = Array.isArray(options.preExtractedMedicines) ? options.preExtractedMedicines : [];
  // In OCR prescription mode, use preExtracted from sanitizePrescriptionText (already clean).
  // Do NOT call extractMedicineRequests/textSplit which strips dosage and creates noise.
  const requestedMedicines = preExtracted.length > 0 ? preExtracted : (ocrOnly ? [] : extractMedicineRequests(text));
  // Skip extractMedicineRequestsFromSegments in recipe/OCR mode — it strips dosage and
  // generates bare drug names without strength, polluting candidateMedicines.
  const fallbackMedicines = ocrOnly ? [] : extractMedicineRequestsFromSegments(text);
  const recipeLineMedicines = typeof extractRecipeMedicineLines === 'function' ? extractRecipeMedicineLines(text) : [];
  const recipeMode = ocrOnly || Boolean(options.recipeMode) || /\b(receta|rx|rp)\b/i.test(normalizeText(text)) || /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(normalizeText(text));
  const candidateMedicines = dedupeStrings([
    ...requestedMedicines,
    ...fallbackMedicines,
    ...recipeLineMedicines
  ]).filter((item) => {
    const normalizedItem = normalizeText(item);
    if (/\b(belen|belén|arcia|paciente|nombre|apellido|ano nac|año nac|gastroenterologia|gastroenterología)\b/i.test(normalizedItem)) return false;
    if (recipeMode) return isLikelyRecipeMedicineCandidate(item);
    return Boolean(normalizedItem);
  }).map((item) => {
    if (recipeMode) {
      // In recipe mode, keep the original medicine line intact (e.g. "ESOZ 40 MG").
      // extractPrimaryRecipeMedicineQuery strips dosage and returns just "esoz" which
      // is too generic for search. The dosage is essential for accurate matching.
      return item;
    }
    return extractPrimaryRecipeMedicineQuery(item);
  }).filter(Boolean);

  console.log('🔍 searchAndBuildCatalogResponse INTERNAL:', {
    ocrOnly,
    recipeMode,
    requestedMedicines,
    fallbackMedicines,
    recipeLineMedicines,
    candidateMedicines,
    text: typeof text === 'string' ? text.slice(0, 200) : text
  });

  if (candidateMedicines.length > 1) {
    const exchangeRate = await getBcvRate();
    const products = await fetchCatalogProducts(2000);
    const groups = [];
    const missingMedicines = [];
    const missingMedicineSet = new Set();

    for (const medicineQuery of candidateMedicines) {
      const result = await searchMedicinesByName(medicineQuery, {
        products,
        exchangeRate,
        strictListMode: !ocrOnly,
        ocrOnly,
        recipeMode,
        // Use consultation mode (0.85 threshold) for multi-medicine queries
        // so fuzzy matching tolerates misspellings like "cardesartan"→"candesartan".
        strictConsultationMode: true,
        forceExactConsultationToken: false
      });
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
      const logProducts1 = candidateMedicines.length > 0 ? candidateMedicines : flattenedOptions.map(o => o.productName || o.name || singleQuery);
      appendConsultationToSheet({ products: logProducts1, exists: 1, phone: userInfo.phone, userName: userInfo.pushName });
      return buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines);
    }

    session.mode = 'awaiting_product_name';
    appendConsultationToSheet({ products: candidateMedicines, exists: 0, phone: userInfo.phone, userName: userInfo.pushName });
    return buildNoMatchListMessage();
  }

  // If the only candidate is a pure dosage (e.g. "160 mcg"), use the full OCR text instead
  const PURE_DOSAGE_RE = /^\s*[\d.,]+\s*(?:mg|mcg|g|gr|ml|mL|ui|iu)\s*$/i;
  const singleQuery = candidateMedicines[0] && !PURE_DOSAGE_RE.test(candidateMedicines[0])
    ? candidateMedicines[0]
    : (extractMedicineQuery(text) || text.trim());
  const result = await searchMedicinesByName(singleQuery, {
    products: await fetchCatalogProducts(2000),
    exchangeRate: await getBcvRate(),
    strictListMode: !ocrOnly,
    ocrOnly,
    recipeMode,
    strictConsultationMode: consultationMode,
    forceExactConsultationToken: consultationMode && !recipeMode
  });

  if (!result || !result.matches.length) {
    session.mode = 'awaiting_product_name';
    appendConsultationToSheet({ products: [singleQuery], exists: 0, phone: userInfo.phone, userName: userInfo.pushName });
    return `⚠️ *${singleQuery.trim()}* no está disponible en este momento.\n\nIntenta con el nombre del medicamento o una presentación distinta. Si tienes una receta, enviala en foto y busco los medicamentos por ti.`;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  touchSession(session);
  rememberCatalogSnapshot(session, result.matches, result.query || singleQuery, buildSearchDiagnosticMessage(result, singleQuery));
  appendConsultationToSheet({ products: [singleQuery], exists: 1, phone: userInfo.phone, userName: userInfo.pushName });

  return buildSearchDiagnosticMessage(result, singleQuery);
}

async function searchMedicinesByName(userQuery, options = {}) {
  if (!db) return null;

  const strictListMode = Boolean(options.strictListMode);
  const recipeMode = Boolean(options.recipeMode);
  const ocrOnly = Boolean(options.ocrOnly);
  console.log(`[SEARCH-IN] recipeMode=${recipeMode} ocrOnly=${ocrOnly} strictListMode=${strictListMode}`);
  // In OCR recipe mode, use the lower threshold (0.70) instead of 0.96.
  // OCR text has inherent recognition noise (e.g. "retadar" vs "retard",
  // "clopidrogel" vs "clopidogrel", "daflon 500 mg" vs "diosmina 500mg").
  // A 0.80+ threshold is too strict for OCR. Use 0.70 to ensure real
  // products are found despite OCR noise and dosage suffix mismatches.
  const strictReferenceThreshold = (recipeMode && !ocrOnly) ? 0.96 : (strictListMode ? 0.93 : 0.70);

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!queryTokens.length) return null;

  const consultationMode = Boolean(options.strictConsultationMode);

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
    .filter((token) => !/^(mg|mgr|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/.test(token))
    .join(' ')
    .trim();
  const matchQuery = dosageLessQuery || query;
  const matchTokens = tokenize(matchQuery).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!matchTokens.length) return { query, queryTokens, exchangeRate, matches: [] };

  const isDosageToken = (token) => /^(\d+(?:[.,]\d+)?)$/.test(token) || /^(mg|mgr|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/.test(token);
  const focusTokens = matchTokens.filter((token) => !isDosageToken(token));
  const primaryTokens = focusTokens.length ? focusTokens : matchTokens;
  const primaryRoot = primaryTokens.join(' ');
  // "mgr" must appear here so that "32 mgr" (with space) is normalized before dosagePattern runs.
  const dosagePattern = /\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|gr|mgr|ml|cc|ui|iu)\b/gi;
  const extractDosageSignatures = (value) => {
    const normalizedValue = normalizeText(value)
      .replace(/\bmgr\.?\b/gi, 'mg')  // normalize "mgr" → "mg" (common OCR variant)
      .replace(/\bgram\.?\b/gi, 'g');  // normalize "gram" → "g"
    // Also normalize "X mgr" (digit-space-mgr) → "Xmg" so the pattern above captures it.
    const spaceNormalized = normalizedValue.replace(/(\d+)\s+mgr\.?/gi, '$1mg');
    if (!spaceNormalized) return [];
    const signatures = [];
    let match;
    while ((match = dosagePattern.exec(spaceNormalized))) {
      const amount = String(match[1]).replace(',', '.');
      const unit = String(match[2]).replace(/mL/i, 'ml').replace(/mgr/i, 'mg').toLowerCase();
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

  // effectiveThreshold is defined at searchMedicinesByName level so it's accessible
  // both inside scoreSignal and in the similarityMatches filter below.
  const effectiveThreshold = consultationMode ? 0.85 : strictReferenceThreshold;

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
    if (ocrOnly && queryDosageSignatures.length > 0) {
      const candidateJoined = [signal.productTitleFull, signal.titleArrayTextFull, signal.ingredient, signal.productText].filter(Boolean).join(' ');
      if (candidateDosageSignatures.length === 0 && queryDosageSignatures.length > 0) {
        console.log(`[DOSAGE-SIG-MISS] querySigs=${JSON.stringify(queryDosageSignatures)} candidate='${signal.productTitleFull}' candidateJoinedLen=${candidateJoined.length} first200='${candidateJoined.slice(0, 200)}'`);
      } else {
        console.log(`[DOSAGE-SIG] query='${query}' querySigs=${JSON.stringify(queryDosageSignatures)} candidate='${signal.productTitleFull}' candSigs=${JSON.stringify(candidateDosageSignatures)} dosageExactMatch=${!hasQueryDosage || queryDosageSignatures.some((sig) => candidateDosageSignatures.includes(sig))}`);
      }
    }
    const dosageExactMatch = !hasQueryDosage || queryDosageSignatures.some((sig) => candidateDosageSignatures.includes(sig));

    if (signal.productTitleFull === matchQuery) score += 600;
    if (signal.titleArrayTextFull === matchQuery) score += 560;
    if (signal.ingredient === matchQuery) score += 420;

  if (referenceSimilarity >= effectiveThreshold + 0.03) score += 420;
  else if (referenceSimilarity >= effectiveThreshold) score += 260;
  else if (referenceSimilarity >= effectiveThreshold - 0.03) score += strictListMode ? 80 : 120;
  else if (strictListMode) score -= 500;

    // Only give +320 if the match is a whole-token hit (bounded by word boundaries)
    // This prevents "DORIXINA" from scoring +320 when query="DORIXINA FLEX"
    const queryTokensForBoundCheck = tokenize(matchQuery);
    const productTitleBounded = queryTokensForBoundCheck.some(t =>
      t === normalizeText(signal.productTitleFull) || // exact token match
      matchQuery.includes(signal.productTitleFull) && ( // title is substring of query
        matchQuery.startsWith(signal.productTitleFull + ' ') ||
        matchQuery.endsWith(' ' + signal.productTitleFull) ||
        matchQuery.includes(' ' + signal.productTitleFull + ' ')
      )
    );
    if (signal.productTitleFull.includes(matchQuery) || productTitleBounded) score += 320;

    const arrayTitleBounded = queryTokensForBoundCheck.some(t =>
      t === normalizeText(signal.titleArrayTextFull) ||
      matchQuery.includes(signal.titleArrayTextFull) && (
        matchQuery.startsWith(signal.titleArrayTextFull + ' ') ||
        matchQuery.endsWith(' ' + signal.titleArrayTextFull) ||
        matchQuery.includes(' ' + signal.titleArrayTextFull + ' ')
      )
    );
    if (signal.titleArrayTextFull.includes(matchQuery) || arrayTitleBounded) score += 280;

    const ingredientBounded = queryTokensForBoundCheck.some(t =>
      t === normalizeText(signal.ingredient) ||
      matchQuery.includes(signal.ingredient) && (
        matchQuery.startsWith(signal.ingredient + ' ') ||
        matchQuery.endsWith(' ' + signal.ingredient) ||
        matchQuery.includes(' ' + signal.ingredient + ' ')
      )
    );
    if (signal.ingredient.includes(matchQuery) || ingredientBounded) score += 200;

    if (hasQueryDosage && !dosageExactMatch) score -= strictListMode ? 700 : (consultationMode ? 0 : 500);
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

  let scoredProducts = products
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

  // ── Greeting denylist (siempre, antes de cualquier búsqueda) ─────────────────
  const GREETING_DENYLIST = new Set([
    'saludos','saludo','hola','buenas','buenos','buen','dias',
    'tardes','noches','noche','gracias','comoestas','como estás',
    'quetral','encantado','encantada','muchogusto','mucho gusto',
    'disculpa','permiso','conpermiso',
    'buen dia','buen día','buenas tardes','buenas noches','buenos dias','buenos días',
  ]);
  const primaryQ = primaryTokens[0] || '';
  const qIsGreeting = primaryQ ? GREETING_DENYLIST.has(primaryQ.toLowerCase()) : false;
  if (qIsGreeting) {
    console.log(`[SEARCH-GATE] REJECTED(greeting): q='${primaryQ}'`);
    return { query, queryTokens, exchangeRate, matches: [] };
  }

  if (consultationMode && primaryTokens.length > 0) {
    const q = primaryTokens[0];
    const beforeCount = scoredProducts.length;
    console.log(`[CONSULTATION-GATE] mode=${consultationMode} primaryTokens=${JSON.stringify(primaryTokens)} q='${q}' beforeCount=${beforeCount}`);
    // Log first 5 products before filter
    scoredProducts.slice(0, 5).forEach((item, i) => {
      console.log(`[CONSULTATION-GATE] BEFORE[${i}] title='${item.productTitleFull}' tokenSet=${JSON.stringify([...item.tokenSet].slice(0, 10))} ingredient='${item.ingredient}'`);
    });
    scoredProducts = scoredProducts.filter((item) => {
      // 1) Match exacto en tokenSet o title/ingredient
      if (
        item.tokenSet.has(q)
        || item.productTitleFull === q || item.productTitleFull.startsWith(q + ' ') || item.productTitleFull.endsWith(' ' + q) || item.productTitleFull.includes(' ' + q + ' ')
        || item.titleArrayTextFull === q || item.titleArrayTextFull.startsWith(q + ' ') || item.titleArrayTextFull.endsWith(' ' + q) || item.titleArrayTextFull.includes(' ' + q + ' ')
        || item.ingredient === q || item.ingredient.startsWith(q + ' ') || item.ingredient.endsWith(' ' + q) || item.ingredient.includes(' ' + q + ' ')
      ) return true;
      // 2) Fallback fuzzy: usar jaroWinklerSimilarity (sin lengthGap check)
      // tokenSimilarity tiene lengthGap > 4 → 0 que bloquea compuestos con guion
      // (alodipina vs amlodipina-besilato gap=10 > 4 → 0). Jaro-Winkler directo
      // da 84.2% y con threshold 0.82 deja pasar mientras scoring filtra con 0.85.
      for (const t of item.tokenSet) {
        if (jaroWinklerSimilarity(q, t) >= 0.82) return true;
      }
      return false;
    });
    console.log(`[CONSULTATION] Filtering for '${q}': ${beforeCount} -> ${scoredProducts.length} products`);
    // Log after filter
    scoredProducts.forEach((item, i) => {
      console.log(`[CONSULTATION-GATE] AFTER[${i}] title='${item.productTitleFull}'`);
    });
    if (!scoredProducts.length) return { query, queryTokens, exchangeRate, matches: [] };
  } else {
    console.log(`[CONSULTATION-GATE] SKIPPED: consultationMode=${consultationMode} primaryTokens.length=${primaryTokens.length}`);
  }

  let candidateMatches = [];

  if (isVitaminQuery) {
    const focusedVitaminMatches = scoredProducts.filter((item) => item.vitaminHit);

    if (!focusedVitaminMatches.length) {
      return { query, queryTokens, exchangeRate, matches: [] };
    }

    candidateMatches = focusedVitaminMatches;
  } else if (recipeMode) {
    const recipeToken = primaryTokens[0] || matchTokens[0] || '';
    if (!recipeToken) {
      return { query, queryTokens, exchangeRate, matches: [] };
    }

    console.log(`[RECIPE-FILTER] query='${query}' recipeToken='${recipeToken}' matchQuery='${matchQuery}' hasQueryDosage=${hasQueryDosage} dosageExactMatch=${scoredProducts[0]?.dosageExactMatch} strictReferenceThreshold=${strictReferenceThreshold}`);

    const recipeMatches = scoredProducts.filter((item) => {
      const candidateText = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
      if (!candidateText) return false;

      const candidateTokens = tokenize(candidateText);
      const exactTokenMatch = candidateTokens.some((candidateToken) => (
        candidateToken === recipeToken ||
        candidateToken.startsWith(recipeToken) ||
        recipeToken.startsWith(candidateToken) ||
        tokenSimilarity(recipeToken, candidateToken) >= 0.96
      ));

      const pass = exactTokenMatch && (
        item.fullFocusMatch ||
        item.exactHit ||
        item.phraseHit ||
        (item.referenceSimilarity ?? 0) >= strictReferenceThreshold
      );
      if (!pass && item.referenceSimilarity >= 0.80) {
        console.log(`[RECIPE-FILTER] REJECTED candidate='${item.productTitleFull}' exactTokenMatch=${exactTokenMatch} refSim=${item.referenceSimilarity?.toFixed(3)} score=${item.score}`);
      }
      return pass;
    });

    console.log(`[RECIPE-FILTER] recipeMatches count=${recipeMatches.length} hasQueryDosage=${hasQueryDosage}`);
    candidateMatches = recipeMatches;
    if (hasQueryDosage) {
      const before = candidateMatches.length;
      candidateMatches = candidateMatches.filter((item) => {
        const candidateText = [item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText].filter(Boolean).join(' ');
        const candidateHasAmount = /\b\d+(?:[.,]\d+)?\b/.test(candidateText);
        const candidateHasUnit = /\b(mg|mcg|g|gr|ml|cc|ui|iu)\b/.test(candidateText);
        // Pass if: dosage exact match OR (hasAmount+hasUnit AND strong reference)
        // The "strong reference" fallback accepts products that have any dosage
        // even if it doesn't match the query dosage, when the product itself
        // has high reference similarity (useful for OCR queries like "esoz 40 mg"
        // against a product "esoz 20mg" where the dosage differs but the
        // reference product is clearly the same item).
        const pass = item.dosageExactMatch || (candidateHasAmount && candidateHasUnit && (item.referenceSimilarity ?? 0) >= 0.70);
        if (!pass) console.log(`[RECIPE-DOSAGE] REJECTED candidate='${item.productTitleFull}' dosageExactMatch=${item.dosageExactMatch} hasAmount=${candidateHasAmount} hasUnit=${candidateHasUnit} refSim=${item.referenceSimilarity}`);
        return pass;
      });
      console.log(`[RECIPE-FILTER] after dosage filter: ${before} -> ${candidateMatches.length}`);
    }

    if (!candidateMatches.length) {
      return { query, queryTokens, exchangeRate, matches: [] };
    }
  } else {
    const similarityMatches = scoredProducts.filter((item) => item.fullFocusMatch || item.exactHit || item.phraseHit || (item.score ?? 0) >= 120 || (item.referenceSimilarity ?? 0) >= 0.76);
    candidateMatches = similarityMatches.filter((item) => {
      if (item.fullFocusMatch || item.exactHit || item.phraseHit) return true;
      return (item.referenceSimilarity ?? 0) >= 0.76 || (item.score ?? 0) >= 180;
    });

    // In consultation mode, skip dosage filters - rely on the degraded filter
    // which handles fuzzy matches better. Dosage mismatch (32mgr vs 8mg) would
    // otherwise reject all candidates before they reach the degraded fallback.
    const inConsultationDosageMode = hasQueryDosage && !consultationMode;

    if (inConsultationDosageMode) {
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
      // Degraded filter: run when dosage filters (exact/relaxed) didn't produce results.
      // Uses tokenSimilarity for fuzzy matching between query tokens and product text.
      const queryCore = normalizeText(dosageLessQuery || exactRoot || query);
      const alternativeTokens = tokenize(queryCore).filter((token) => !STOPWORDS.has(token) && token.length > 1);
      const degradedMatches = scoredProducts.filter((item) => {
        const candidateCore = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
        if (!candidateCore) return false;

        const tokenOverlap = alternativeTokens.length === 0
          ? candidateCore.includes(queryCore)
          : alternativeTokens.some((token) => {
              if (candidateCore.includes(token)) return true;
              return tokenize(candidateCore).some((candidateToken) => tokenSimilarity(token, candidateToken) >= 0.75);
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
  const consultationQuery = consultationMode ? (extractStrictConsultationMedicineQuery(query) || extractMedicineQuery(query) || query) : query;
  const consultationTokens = tokenize(consultationQuery).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  const consultationExactToken = consultationTokens[0] || '';
  const isShortNonDosageQuery = !isVitaminQuery && !hasQueryDosage && normalizedQueryTokens.length <= 2;
  const isSingleTokenQuery = !isVitaminQuery && !hasQueryDosage && normalizedQueryTokens.length === 1;
  const strictQueryTokens = isSingleTokenQuery ? normalizedQueryTokens : leadingQueryTokens;

  const filteredTopMatches = strictQueryTokens.length
    ? topMatches.filter((item) => {
        const candidateText = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
        if (!candidateText) return false;

        if (consultationMode) {
          const candidateTokens = tokenize(candidateText);
          if (!consultationTokens.length) return false;

          const tokenMatches = (queryToken) => {
            const normalizedToken = normalizeText(queryToken);
            if (!normalizedToken) return false;

            return candidateTokens.includes(normalizedToken)
              || candidateText === normalizedToken
              || candidateText.startsWith(`${normalizedToken} `)
              || candidateText.endsWith(` ${normalizedToken}`)
              || candidateText.includes(` ${normalizedToken} `)
              || candidateTokens.some((candidateToken) => (
                candidateToken === normalizedToken
                || candidateToken.startsWith(normalizedToken)
                || normalizedToken.startsWith(candidateToken)
              ));
          };

          return consultationTokens.every(tokenMatches) || (consultationExactToken && tokenMatches(consultationExactToken));
        }

        if (recipeMode) {
          const candidateTokens = tokenize(candidateText);
          return strictQueryTokens.every((token) => {
            if (candidateText.includes(` ${token} `) || candidateText.startsWith(`${token} `) || candidateText.endsWith(` ${token}`) || candidateText === token) return true;
            return candidateTokens.some((candidateToken) => {
              if (candidateToken === token) return true;
              if (candidateToken.startsWith(token) || token.startsWith(candidateToken)) return true;
              return tokenSimilarity(token, candidateToken) >= 0.97;
            });
          });
        }

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

  const finalMatches = consultationMode
    ? topMatches
    : (recipeMode
      ? (filteredTopMatches.length ? filteredTopMatches : topMatches)
      : (isShortNonDosageQuery ? filteredTopMatches : (filteredTopMatches.length ? filteredTopMatches : topMatches)));

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
          '¿Otro medicamento? Escríbeme el nombre y realizo la consulta.'
        ]
      : ['⚠️ Necesito un poco más de detalle para ayudarte.'];

    return missingLines.join('\n').trim();
  }

  // Get BCV rate from first result that has it
  const exchangeRate = results.find((r) => r.exchangeRate)?.exchangeRate || null;

  const lines = [];
  lines.push('🔎 *Resultados encontrados*');
  if (exchangeRate) {
    lines.push(`💱 Tasa BCV: *Bs ${formatPrice(exchangeRate)}*`);
  }
  lines.push('');

  if (Array.isArray(missingMedicines) && missingMedicines.length) {
    lines.push('⚠️ *No disponibles:*');
    missingMedicines.forEach((item) => {
      lines.push(`• *${item}*`);
    });
    lines.push('');
    lines.push('¿Otro medicamento? Escríbeme el nombre y realizo la consulta.');
    lines.push('');
  }

  let optionNumber = 1;
  // Normalize groupTitles to avoid duplicates like "SIMETICONA" and "SIMETICONA DE 125 MG"
  // Group results by normalized medicine name, merging groups that differ only in dosage
  const normalizedGroups = new Map();
  for (const result of results) {
    const rawTitle = String(result.groupTitle || result.query || 'MEDICAMENTO').toUpperCase();
    // Strip dosage suffixes to find the base medicine name
    const normalizedTitle = rawTitle
      .replace(/^(?:TIENES|TIENE|TENER|HAY|DISPONIBLE|DISPONIBLES|DISPONIBILIDAD|POR\s+FAVOR|QUISIERA|QUIERO|NECESITO|BUSCO|BUSCAR|CONSULTAR)\s+/i, '')
      .replace(/\s*DE\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU|TABLETAS?|CÁPSULAS?|CAPS?|AMPOLLAS?|SUSPENSION|SUSP|JARABE|GOTAS|CREMA|GEL|POLVO|UNGÜENTO|SOBRES?)\b.*$/i, '')
      .replace(/\s+DE\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)\b/i, '')
      .replace(/\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)\b.*$/i, '')
      .replace(/\(\s*SIMETICONA\s*\)\s*\d+\s*MG.*$/i, '')
      .trim();
    const key = normalizedTitle;
    // If this group's normalized name is a substring of the query (meaning the query
    // is more specific), don't create a separate group — it would be a subset duplicate.
    // E.g. query="DORIXINA FLEX", normalized="DORIXINA" → skip; query="DORIXINA", same → keep.
    const rawQueryUpper = String(result.query || '').toUpperCase();
    const isSubsetOfQuery = rawQueryUpper.length > normalizedTitle.length &&
      rawQueryUpper.includes(normalizedTitle);
    if (isSubsetOfQuery) {
      // Merge matches directly into the superstring group if it exists
      const superstringKey = normalizedGroups.has(key) ? key : null;
      if (superstringKey) {
        const existing = normalizedGroups.get(superstringKey);
        const existingTitles = new Set(existing.matches.map((m) => normalizeText(m.title || '')));
        for (const match of result.matches || []) {
          const matchTitle = normalizeText(match.title || '');
          if (!existingTitles.has(matchTitle)) {
            existing.matches.push(match);
            existingTitles.add(matchTitle);
          }
        }
      }
      continue;
    }
    if (normalizedGroups.has(key)) {
      // Merge matches into existing group, deduplicating by title
      const existing = normalizedGroups.get(key);
      const existingTitles = new Set(existing.matches.map((m) => normalizeText(m.title || '')));
      for (const match of result.matches || []) {
        const matchTitle = normalizeText(match.title || '');
        if (!existingTitles.has(matchTitle)) {
          existing.matches.push(match);
          existingTitles.add(matchTitle);
        }
      }
    } else {
      normalizedGroups.set(key, { ...result, groupTitle: rawTitle, matches: [...(result.matches || [])] });
    }
  }

  for (const [key, group] of normalizedGroups) {
    const groupTitle = shortenText(String(group.groupTitle || key || 'MEDICAMENTO').toUpperCase(), 52);
    lines.push(`*${groupTitle}*`);

    (group.matches || []).forEach((item) => {
      const name = shortenText(item.title || 'Medicamento', 52);
      const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
      const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
      lines.push(`💊 ${optionNumber}. ${name}`);
      lines.push(`   ${usdText}  |  ${bsText}`);
      optionNumber += 1;
    });

    lines.push('');
  }

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
    if (!/(\d+\s*(?:mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)|(?:mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina))/.test(cleaned) && cleaned.length < 6) continue;
    const query = extractMedicineQuery(segment) || segment;
    if (!query) continue;

    if (!results.includes(query)) results.push(query);
  }

  return results;
}

function splitMedicineSegments(text) {
  // Only split on explicit list markers: bullets, newlines, or dashes that precede whitespace (list dashes).
  // Do NOT split on em/en dashes (U+2014/U+2013) embedded in product names like "MG — hidroten"
  return String(text)
    .split(/\n+|[•·●]+|(?:^|\s)-(?=\s|$)/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitSingleLineMedicineList(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const commaSplit = raw.replace(/\s*,\s*/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  if (commaSplit.length >= 2) {
    return commaSplit;
  }

  // ── Unit patterns ──
  const UNIT_RE = /^(?:mg|mgr|mcg|g|gr|ml|mL|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i;

  // ── Strong stopwords to strip when extracting medicine name ──
  const STRONG_STOP_RE = /^(?:de|del|la|el|las|los|una|unos|que|y|con|para|por|sin|no|si|un|une)$/i;

  // ── Split by dosage anchors ──
  // For each "de NUM" anchor, find the medicine name that precedes it
  // by looking in the text segment between the PREVIOUS anchor's end
  // and this anchor's start, and stripping any embedded "de NUM" tokens.
  const anchorRe = /\bde\s+(\d+)\b/gi;
  const anchors = [];
  let aMatch;
  anchorRe.lastIndex = 0;
  while ((aMatch = anchorRe.exec(raw)) !== null) {
    anchors.push({ start: aMatch.index, end: aMatch.index + aMatch[0].length, num: aMatch[1] });
  }

  if (anchors.length === 0) return [raw];

  const results = [];
  for (let i = 0; i < anchors.length; i++) {
    const { start: aStart, num } = anchors[i];
    const prevChar = aStart > 0 ? raw[aStart - 1] : ' ';
    // Skip "de NUM" preceded by uppercase letter (e.g. "atorvastatinade 50")
    if (prevChar !== ' ' && prevChar === prevChar.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(prevChar)) {
      continue;
    }

    const segStart = i > 0 ? anchors[i - 1].end : 0;
    const between = raw.substring(segStart, aStart).trim();
    const tokens = between.split(/\s+/);

    // Walk backwards skipping trailing "de NUM" pairs and stopwords
    // STOPPING CONDITION: if the token preceding the "de NUM" anchor
    // (in the raw text) is itself preceded by another "de NUM",
    // the preceding medicine already owns that "de NUM" — stop here.
    const medTokens = [];
    let hitMedicine = false; // true once we've added the first non-stopword token
    for (let j = tokens.length - 1; j >= 0; j--) {
      const tok = tokens[j];
      // Skip "de NUM" pair: tokens[j-1]="de" and tokens[j]=digit
      if (j >= 1 && tokens[j - 1].toLowerCase() === 'de' && /^\d+$/.test(tok)) {
        j--; // skip "de" + digit together
        continue;
      }
      if (STRONG_STOP_RE.test(tok)) { j--; continue; }
      // Stop if we've already collected a medicine token and we encounter
      // another one — we crossed into the previous segment's medicine name.
      if (hitMedicine) break;
      medTokens.unshift(tok);
      hitMedicine = true;
    }

    const segment = (medTokens.join(' ') + ' de ' + num).trim();
    if (segment.length > 2) results.push(segment);
  }

  if (results.length >= 2) return results;
  return [raw];
}

function extractMedicineRequestsFromSegments(text) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];

  const segments = splitMedicineSegments(rawText);
  const pieces = segments.length > 1 ? segments : splitSingleLineMedicineList(rawText);
  // [DIAG] log split results
  console.log('🔬 extractMedicineRequests split:', {
    rawText: rawText.slice(0, 120),
    segmentsCount: segments.length,
    piecesCount: pieces.length,
    pieces: pieces.slice(0, 8)
  });
  const filteredPieces = pieces.filter((piece) => !/\b(belen|belén|arcia|patient|paciente|nombre|apellido|ano nac|año nac)\b/i.test(normalizeText(piece)));
  const results = [];

  for (const piece of filteredPieces) {
    const cleaned = normalizeText(piece);
    if (!cleaned) continue;
    if (isGreetingOrMenu(cleaned) || isThanksMessage(cleaned) || /^(listo|resumen)$/i.test(cleaned)) continue;
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)/.test(cleaned)) continue;

    const query = extractMedicineQuery(piece) || cleaned;
    if (!query) continue;
    // [DIAG] log each query extraction
    console.log('🔬 extractMedicineRequests query:', { piece: piece.slice(0, 80), query });
    if (!results.includes(query)) results.push(query);
  }
  console.log('🔬 extractMedicineRequests results:', results);

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

function extractPushName(payload) {
  const node = unwrapMessagePayload(payload) || {};
  return (
    node?.key?.pushName ||
    node?.Info?.PushName ||
    node?.pushName ||
    node?.Sender?.pushName ||
    node?.sender?.pushName ||
    ''
  );
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
    /^(paciente|rp|rx|receta|nombre|apellidos?|apellido|ano nac|año nac|fecha|edad|sexo|peso|talla|ci|c.i.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección)\b/i,
    /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/,
    /^(?:edad|peso|talla|ci|c.i.|cedula|cédula)[:\s]+[\w\d.,-]+$/i
  ];

  const cleaned = lines.filter((line) => !removalPatterns.some((pattern) => pattern.test(line)));
  return cleaned.join('\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Sanitize OCR text from medical prescriptions (recipes).
 * Extracts ALL drug names from the RP: section, filtering out patient info,
 * doctor info, dates, and other administrative data.
 *
 * Example input:
 *   "Dr. Cesar Santodomingo\nUNIDAD DE GASTROENTEROLOGIA\nRP:\nPACIENTE: BELEN ARCIA\nESOZ 40 MG\nLEPRIT 25 MG\nBUMETIN RETADAR 300 MG"
 *
 * Expected output: "ESOZ 40 MG\nLEPRIT 25 MG\nBUMETIN RETADAR 300 MG"
 */
function sanitizePrescriptionText(value) {
  let raw;
  try { raw = String(value == null ? '' : value); } catch (e) { raw = ''; }
  console.log('🩺 sanitizePrescriptionText INPUT:', JSON.stringify(raw.slice(0, 400)));
  if (!raw) return '';

  // Lines that are administrative/header — never drug content
  const ADMIN_LINE_PATTERNS = [
    /^\s*dr\.?\s+/im,
    /^\s*(?:unidad|de\s+gastroenterologia|clinica|clínica|consultorio|sala|hospital|centro)\b/im,
    /^\s*(?:paciente|nombre|apellidos?|año\s+nac|ano\s+nac|edad|sexo|peso|talla)\s*[:.\-]*/im,
    /^\s*(?:ci|c\.?i\.?|cédula|cedula|rif|nit)\s*[:.\-]*/im,
    /^\s*(?:fecha|vencimiento|caducidad|expiración|receta)\s*[:.\-]*/im,
    /^\s*(?:dirección|direccion|teléfono|telefono|contacto)\s*[:.\-]*/im,
    /^\s*(?:cobertura|aseguradora|póliza|seguro|plan)\b/im,
    /^\s*#+/,
    /^\s*[=\-_]{3,}\s*$/,
    /^\s*[\d.]{5,}\s*$/,           // long numbers (CI, phone)
    /^```/,                        // triple backticks (code block markers)
  ];

  // Dosage patterns that confirm a line IS a drug
  // Requires: number immediately before unit (e.g. "40 MG", "500 MG", "30 ML")
  const HAS_NUMERIC_DOSAGE = /\d\s*(mg|mcg|g\s|gr\s|ml|mL|ui|iu)/i;
  // Drug form suffixes that confirm a line IS a drug (no number needed, e.g. "CAP", "SUSP", "POLVO")
  // Must be at end of string OR followed by space/number
  const HAS_DRUG_FORM = /(?:^|[\s(])\s*(?:cap(?:\s|$)|caps?(?:\s|$)|tab(?:\s|$)|tabs?(?:\s|$)|amp(?:\s|$)|susp(?:\s|$)|sol(?:\s|$)|crema(?:\s|$)|gel(?:\s|$)|polvo(?:\s|$)|ung(?:\s|$)|over(?:\s|$))\b/i;

  // Strip code-block markers (triple backticks) that wrap OCR output
  let cleanRaw = raw.replace(/^```+\s*/m, '').replace(/\s*```+$/m, '').trim();
  console.log('🩺 sanitizePrescriptionText after-backtick-strip:', JSON.stringify(cleanRaw.slice(0, 300)));

  // Extract section after RP: - find the colon (or end of rp/rx) and slice after it
  let prescriptionSection = cleanRaw;
  const rpMatch = cleanRaw.match(/(?:^|\n)\s*(?:rp|rp:|rx|rx:)\s*/im);
  console.log('🩺 sanitizePrescriptionText rpMatch:', rpMatch ? rpMatch[0] : null, 'index:', rpMatch ? rpMatch.index : null);
  if (rpMatch) {
    // Slice AFTER the full match including colon (rpMatch[0] includes rp: or rp etc.)
    prescriptionSection = cleanRaw.slice(rpMatch.index + rpMatch[0].length).replace(/^:\s*/, '');
  }
  console.log('🩺 sanitizePrescriptionText prescriptionSection:', JSON.stringify(prescriptionSection.slice(0, 300)));

  const lines = prescriptionSection.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  const drugLines = [];

  for (let rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.length < 2) continue;

    // Skip admin lines
    if (ADMIN_LINE_PATTERNS.some(p => p.test(trimmed))) continue;

    // Skip lines that are purely numbers/symbols
    if (/^[\d\s.,:;\-()]+$/.test(trimmed)) continue;

    // Skip short labels (FECHA:, CI:, etc.)
    if (/^(?:fecha|ci|paciente|ano|nac|edad|sexo|peso|talla|cobertura|observaciones?|indicaciones?)\s*[:.\-]?\s*$/i.test(trimmed)) continue;

    // Check if this looks like a drug line
    const hasNumericDosage = HAS_NUMERIC_DOSAGE.test(trimmed);
    const hasDrugForm = HAS_DRUG_FORM.test(trimmed);
    const isAllCapsLongEnough = /^[A-ZÁÉÍÓÚÑ]{4,}/.test(trimmed) && trimmed.length > 4;

    // Skip personal info lines UNLESS they also have drug indicators
    // ("MODERAN SUSP", "MILAX POLVO", "BARGONIL CREMA" look like names but ARE drugs)
    const isPersonal = /^[A-ZÁÉÍÓÚÑ]{4,}\s+[A-ZÁÉÍÓÚÑ]{4,}\s*$/i.test(trimmed);
    if (isPersonal && !hasNumericDosage && !hasDrugForm) continue;

    const isDrug = hasNumericDosage || hasDrugForm || isAllCapsLongEnough;

    if (isDrug) {
      // Normalize: collapse multiple spaces, remove commas before units
      const cleaned = trimmed
        .replace(/,\s*(mg|mcg|g|gr|ml|mL|ui|iu)\b/gi, ' $1')  // "500, MG" -> "500 MG"
        .replace(/\s+/g, ' ')
        .replace(/\s*[,;:]\s*/g, ' ')
        .trim();

      if (cleaned.length > 1) {
        drugLines.push(cleaned);
      }
    }
  }

  return drugLines.join('\n');
}

/**
 * Sanitize OCR text from medicine box images.
 * Strategy: find the FIRST substantial line that looks like a drug name with dosage.
 * Strip only the clearly packaging noise (brand, form, route, classification).
 * Return ONE clean medicine name, not multiple fragments.
 *
 * Example input:
 *   "Fexofenadina Clorhidrato\nCALOX\nMedicamento Genérico\nAntialérgico\nAntihistamínico\nVía Oral\n10 Tabletas Recubiertas\n120 mg"
 *
 * Expected output: "Fexofenadina 120"
 */
function sanitizeMedicineBoxText(value) {
  const raw = String(value || '');
  if (!raw) return '';
  let bestLine; // ← declare locally (was missing: implicit global in PASS 1)

  // Classification/therapeutic category words to remove everywhere
  const TRASH_WORDS = new Set([
    // Brand/lab names
    'calox','genven','drotafarma','spefar','brook','buka','lattan','arte','medico','reems',
    'multifarma','genfar','baljan','biosido','mk','mediart','pharmakerm','premium','pharma',
    'blaskov','medifasa','locatel','farmapatria','cip','incof','pharmalat',
    // Chemical suffixes
    'clorhidrato','cloruro','besilato','sulfato','fosfato','acetato','tartrato',
    'malato','fumarato','succinato','bromuro','ioduro','nitrato','tiocianato',
    // Dosage forms
    'tableta','tabletas','capsula','capsulas','capsule','capsules','solucion','inyectable',
    'inyeccion','ampolla','ampollas','vial','viales','frasco','jarabe','suspension',
    'polvo','polvos','sobres','granulado',
    'supositorio','ovulo','parche','aerosol','inhalador','spray','drop','barra',
    // Route descriptors that slip through as false medicine names
    'via','vía','inh','inhal','oral','tópico','topico','rectal','vaginal',
    'sublingual','intramuscular','intravenosa','subcutanea','subcutaneo',
    'oftálmica','oftalmica','óptica','optica','tópica','topica','transdérmica','transdermica',
    // Routes
    'oral','topico','topica','sublingual','rectal','vaginal','intramuscular',
    'intravenosa','subcutanea','subcutaneo','inhalatoria','nasal','oftalmica',
    'oftalmico','otico','transdermica','dermatologica',
    // Classification / marketing
    'antialergico','antialergica','antihistaminico','antihistaminica','antiinflamatorio',
    'analgesico','antipiretico','antibiotico','antimicotico','antifungico',
    'broncodilatador','antitusivo','expectorante','mucolitico','descongestionante',
    'vasoconstrictor','hipnotico','sedante','ansiolitico','antidepresivo',
    'antipsicotico','neuroléptico','corticosteroide','antiacido','laxante',
    'antiepileptico','anticoagulante','antihipertensivo','diuretico','inmunosupresor',
    'quimioterapico','biologico',
    // Packaging
    'caja','cajas','blister','blíster','envase','empaque','jeringa','gotero',
    'medicamento','generico','via','unidad','receta',
    // Generic noise
    'genérico','esp','pf','pv','pvr','precio','oferta',
  ]);

  // Tokens that are purely numeric / dosage-alone: reject these as queries
  const PURE_DOSAGE_TOKEN = /^\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|mL|ui|iu|tabletas?|capsulas?|ampollas?)?$/i;

  const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);

  // ── PASS 1: Find lines that contain a registered ® or trademark ™ symbol.
  //    These are almost always the commercial brand name on a medicine box.
  for (const line of lines) {
    if (/®|™/.test(line)) {
      const clean = line.replace(/\s+/g, ' ').trim();
      // This line has a brand marker — use it even if it has other content
      const alphaAfterFilter = clean.replace(/\d/g, '').replace(/[\s®™-]/g, '').length;
      if (alphaAfterFilter >= 3) {
        bestLine = clean;
        break;
      }
    }
  }

  // ── PASS 2: Find the first line that looks like a drug name
  //    (has letters, not mostly numbers) and has at least one
  //    dosage-like token OR recognizable medicine content word.
  if (!bestLine) {
    for (const line of lines) {
      const cleanLine = line.replace(/\s+/g, ' ').trim();
      // Skip lines that are purely numeric or too short
      if (cleanLine.replace(/\d/g, '').replace(/\s/g, '').length < 4) continue;
      // Skip lines that are mostly numbers/symbols
      if (/^[\d\s.,+-]+$/.test(cleanLine)) continue;
      // Skip lines that match classification/marketing/brand only
      const lineLower = cleanLine.toLowerCase();
      const words = lineLower.split(/\s+/);
      const hasContent = words.some(w =>
        !TRASH_WORDS.has(w) &&
        !PURE_DOSAGE_TOKEN.test(w) &&
        /[a-záéíóúñ]/i.test(w)
      );
      if (!hasContent) continue;
      bestLine = cleanLine;
      break;
    }
  }

  if (!bestLine) return '';

  // Tokenize and filter out trash words and pure dosage tokens
  const tokens = bestLine.split(/\s+/).filter(t => {
    const tLower = t.toLowerCase().replace(/[.,]/g, '');
    if (!tLower.length) return false;
    if (TRASH_WORDS.has(tLower)) return false;
    if (PURE_DOSAGE_TOKEN.test(tLower)) return false;
    // Skip pure numbers that are 3 or fewer digits
    if (/^\d{1,3}$/.test(tLower)) return false;
    return true;
  });

  // Rejoin remaining tokens — these should be the drug name (possibly with dosage number)
  let result = tokens.join(' ');

  // Remove dosage suffixes and trademark/registered symbols
  result = result
    .replace(/\s*\d+\s*(mg|mcg|g|gr|ml|mL|ui|iu)\b\.?/gi, '')
    .replace(/[®™]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Final safety: if result is mostly numbers or too short, return empty
  const alphaCount = (result.match(/[a-záéíóúñ]/gi) || []).length;
  if (alphaCount < 3) return '';

  return result;
}

function extractProductNameFromOCR(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const lines = raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Patterns for lines we know are NOT product names
  const skipPatterns = [
    /^(aviso|aviso\s+importante|atencion|atención)\b/i,
    /^(contenido|contenido\s+neto|peso\s+neto|presentacion|presentación)\b/i,
    /^(ingredientes?|composición|componentes|composicion)\b/i,
    /^(informacion|información|informações|informacoes)\s+(nutricional|nutricionale|geral|general)\b/i,
    /^(informacion|información|nutricional|informações)\b/i,
    /^(modo?\s+de?\s+uso|instrucciones?|indicaciones?|contraindicaciones?|precauciones?|warnings?)\b/i,
    /^(direccion|dirección|address|conservacion|conservación|almacenamiento|storage)\b/i,
    /^(telefono|teléfono|fono|phone|tel|call|contacto|contact)\b/i,
    /^(fabricado|fabricante|importado|distribuido|distribuidor|registered)\b/i,
    /^(fecha|vencimiento|caducidad|expiracion|expiry|lote|batch)\b/i,
    /^(www\.|http|https|\.com|\.org|\.net|\.gov)/i,
    /^\(?\d{3,}[)\s.-]?\d{3,}[)\s.-]?\d{3,}/,
    /^\d+\s*(g|gr|mg|ml|cc|kg|kcal)\b/i,
    /^.{1,2}\/\d{3,}/,
    /^(nº|no\.|numero|número|lote|serie|reg\.?|reg\.?\s*san|registro)\b/i,
    /^(sucursal|oficina|punto|venta|comprar|pedido|orden|order)\b/i,
    /^(uso:|indicaciones:|presentacion:|contenido:|ingredientes:)/i,
  ];

  // Dosage patterns
  const dosagePattern = /\b(\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|gr|ml|mL|cc|ui|iu|tabletas?|capsulas?|cápsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|over|the|counter)|\d+\s*(%|mod|tab|cap|amp))/i;

  // Lines too long to be a simple product name
  const isTooLong = (line) => line.replace(/\s+/g, ' ').length > 55;

  // Lines too short
  const isTooShort = (line) => line.split(/\s+/).filter(Boolean).length < 2;

  // Score each line - simple approach
  let bestCandidate = '';
  let bestScore = -1;

  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    const normalized = normalizeText(line);
    const words = line.split(/\s+/).filter(Boolean);
    const wordCount = words.length;

    // Skip if matches skip patterns
    if (skipPatterns.some((p) => p.test(line) || p.test(normalized))) continue;

    // Skip if too long
    if (isTooLong(line)) continue;

    // Skip if too short (single word product names like "NAN" alone need special handling)
    if (isTooShort(line)) {
      // But if it's the first line and very short, still consider it
      if (i > 2) continue;
    }

    // Skip if contains dosage - it's a recipe/medicine line
    if (dosagePattern.test(normalized)) continue;

    // Score: prefer lines near the top
    let score = 0;
    if (i === 0) score = 100;
    else if (i === 1) score = 90;
    else if (i === 2) score = 80;
    else if (i <= 4) score = 70;
    else if (i <= 6) score = 50;
    else score = 30;

    // Penalize if it contains claim/metadata words
    const metaWords = /\b(probiótico|lc-pufas|dha|ara|hmo|optipro|científico|ciencia|clínico|clínica|beneficio|beneficios|extracto|concentrado|composite|nutricional|infantil|baby|infant)\b/i;
    if (metaWords.test(normalized)) score -= 40;

    // Penalize lines that are all uppercase (usually legal/claims)
    if (line === line.toUpperCase() && line.length > 15) score -= 30;

    // Prefer lines with mixed case (product names)
    if (/[a-z]/.test(line) && /[A-Z]/.test(line)) score += 10;

    // Bonus for word count 2-4
    if (wordCount >= 2 && wordCount <= 4) score += 20;

    // Bonus if line has uppercase-starting words (brand-like)
    const brandWords = words.filter((w) => /^[A-ZÁÉÍÓÚÑ]/.test(w) && w.length > 2);
    if (brandWords.length >= 1) score += 15;
    if (brandWords.length >= 2) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = line.replace(/\s+/g, ' ').trim();
    }
  }

  // Special case: try to combine first few lines that look like a product name
  // (handles cases where OCR splits "NAN Expertpro HA" across lines)
  if (lines.length >= 2) {
    let combined = '';
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i];
      const normalized = normalizeText(line);
      const words = line.split(/\s+/).filter(Boolean);

      if (skipPatterns.some((p) => p.test(line) || p.test(normalized))) break;
      if (isTooLong(line)) break;
      if (dosagePattern.test(normalized)) break;
      if (words.length === 1 && i > 3) break;

      const metaWords = /\b(probiótico|lc-pufas|dha|ara|hmo|optipro|científico|ciencia|clínico|clínica|beneficio|beneficios|extracto|concentrado|composite|nutricional|infantil|baby|infant)\b/i;
      if (metaWords.test(normalized)) break;

      if (combined === '') {
        combined = line;
      } else {
        combined = combined + ' ' + line;
      }
    }
    if (combined.split(/\s+/).filter(Boolean).length >= 2 && combined.replace(/\s+/g, ' ').length <= 45) {
      return combined.replace(/\s+/g, ' ').trim();
    }
  }

  return bestCandidate;
}

function extractRecipeMedicineLines(value) {
  const raw = String(value || '');
  if (!raw) return [];

  const chunks = raw
    .split(/\r?\n+|[•·●\u2022]+|(?:\s+[-–—]\s+)/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const metaPatterns = [
    /^(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro)\b/i,
    /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i,
    /^(paciente|rp|rx|receta|nombre|apellidos?|apellido|ano nac|año nac|fecha|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección)\b/i,
    /^(no\s+disponibles?|resultados?\s+encontrados|te\s+muestro|tasa\s+bcv|cuando\s+termines|otro\s+medicamento|para\s+agregar|ejemplo|receta\s+detectada)\b/i,
    // Route/instruction descriptions — catch partial phrases too (no ^ anchor)
    /via\s+inhalatoria|vía\s+inhalatoria|via\s+oral|vía\s+oral|via\s+rectal|vía\s+rectal|via\s+sublingual|via\s+topica|vía\s+tópica/i,
    /polvo\s+(para|de|inhalaci|inhalar)|capsulas?\s+para|inhalaci(?:ón|on)\s+(?:oral|trasn)/i,
    /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/,
    /^(?:edad|peso|talla|ci|c\.i\.|cedula|cédula)[:\s]+[\w\d.,-]+$/i
  ];

  const formOrDose = /\b(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)\b/i;
  const shortBrandLike = /^(?:[a-záéíóúñ][a-záéíóúñ0-9.-]{2,}(?:\s+[a-záéíóúñ0-9().-]{2,}){0,5})$/i;
  const candidates = [];

  const userQueryVerbPatterns = [
    /\b(tienes?|tiene|tengo|tienen|tener|quiero|quiere|quieren|querer|busco|busca|buscan|buscar|necesito|necesita|necesitan|necesitar|hay|habia|habra|disponible|disponibles|disponibilidad|precio|costo|costar|cuesta|cuestan)\b/i,
    /\b(por\s+favor|me\s+puedes|me\s+ayuda|consulta|consultar|saber|cuanto|cuánto)\b/i
  ];
  // Tokens that appear in pharmaceutical OCR but are NOT medicine names:
  // brand names (CALOX, GENVEN...), descriptors (GENERICO, RECUBIERTAS),
  // salt forms used alone (CLORHIDRATO alone), and form tokens used alone (CAPSULAS...).
  const KNOWN_NON_MEDICINE = new Set([
    'calox','genven','spefar','drotafarma','limate','la','sante','oflox','ofloxacina',
    'biotech','tecfar','farmacidio','grunenthal','janseen','kern','pharma','laboratorio',
    'medicamento','generico','genérico','genérica','recubiertas','recubierto','inyectable',
    'clorhidrato','bromuro','cloruro','sulfato','nitrato','fosfato','acetato',
    'via','vía','inh','inhal','oral','rectal','sublingual','tópico','tópica','topico','topica',
    'nasal','oftálmica','oftalmica','inhalatoria','intravenosa','intramuscular',
    'transdérmica','transdermica','vaginal','cutánea','cutaneo',
    'comp','comprimido','comprimidos','tab','tableta','tabletas','capsulas','capsulas','caps','cap',
    'ampolla','ampollas','vial','frasco','suspension','susp','jarabe','gotas','crema','gel',
    'polvo','polvos','sobres','granulado','unguento','supositorio','ovulo','parche','aerosol',
    'spray','drop','barra','capsules',
    // OCR noise from pharmaceutical boxes
    'antialergico','antialérgico','antialergico','antihistaminico','antihistamínico',
    'antialergico','antihistaminico','alergico','alérgico',
    '10','veces','tableta','recubiertas','recubierto',
    'mg','ml','mcg','g','gr','ui','iu','mL',
    // Multi-word OCR fragments used as false section headers
    'en','para','con','sin','cada','por','del','los','las','una','unos','unas',
  ]);
  // Patterns to catch full OCR fragments that are not medicines
  const NON_MEDICINE_PATTERNS = [
    /^(?:en|para)\s+(?:capsulas?|capsules?|caps|tabletas?|comp|comprimidos?|polvo|sobres?|inhalar|inhalador|aerosol|suspension)/i,
    /^\d+\s*(?:capsulas?|capsules?|tabletas?|comprimidos?|comp|ampollas?|viales?|frascos?|sobres?)\s*(?:\+\s*\d+\s*(?:capsulas?|caps|tabletas?|inhalador|aerosol))?/i,
    /^(?:capsulas?|capsules?|tabletas?)\s*(?:\d+\s*)?(?:para|de|inhalar|inhalacion|aerosol|inhalador)?/i,
    /^(?:polvo|granulado|sobres?|suspension)\s+(?:para|de|inhalaci)/i,
    /^(?:60|cuantos?|cada)\s*(?:capsulas?|mg|ml|mcg)/i,
    /^(?:bio|multi|omega|ultra|super)\s/gi,
    /^(?:lavaplatos|champu|gel|leche|azufre|microgotero)/i,
  ];
  const PURE_DOSAGE_RE = /^\s*[\d.,]+\s*(?:mg|mcg|g|gr|ml|mL|ui|iu)\s*$/i;
  const pushCandidate = (candidate) => {
    const normalized = normalizeText(candidate);
    if (!normalized) return;
    if (PURE_DOSAGE_RE.test(normalized)) return;
    const firstToken = normalized.split(/\s+/)[0];
    const hasLikelyMedicineName = /[a-záéíóúñ]{4,}/i.test(candidate) && !KNOWN_NON_MEDICINE.has(firstToken);
    // Reject if the first token is a known non-medicine word
    if (KNOWN_NON_MEDICINE.has(firstToken)) return;
    if (!hasLikelyMedicineName) return;
    if (NON_MEDICINE_PATTERNS.some((p) => p.test(normalized))) return;
    if (/\b(belen|belén|arcia|patient|paciente nombre|apellido|ano nac|año nac|dr\.|dra\.|doctor|doctora|unidad|gastroenterologia|gastroenterología)\b/i.test(normalized)) return;
    // Skip lines that look like user query fragments (contain user query verbs)
    if (userQueryVerbPatterns.some((p) => p.test(normalized))) return;
    candidates.push(candidate);
  };

  for (const chunk of chunks) {
    const normalizedChunk = normalizeText(chunk);
    if (!normalizedChunk) continue;

    const pieces = chunk.split(/\s*(?:,|;|\/|\|)\s*/g).map((part) => part.trim()).filter(Boolean);
    if (pieces.length > 1) {
      for (const piece of pieces) pushCandidate(piece);
      continue;
    }

    pushCandidate(chunk);
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
  'saludos',
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

function isMedicineInterestStatement(value) {
  const text = normalizeText(value);
  if (!text) return false;
  // Patrones de declaración de interés en medicamentos
  const interestPrefixes = [
    'estoy interesado',
    'me interesa',
    'me gustaria',
    'quiero un',
    'quiero',
    'busco un',
    'busco',
    'necesito un',
    'necesito',
    'quisiera un',
    'quisiera',
  ];
  // Si el texto empieza con "medicamento", verificar si es preceded by "un"
  if (text.startsWith('medicamento') || text.startsWith('un medicamento')) {
    return false; // solo "medicamento" sin contexto de interés
  }
  // Buscar prefijo de interés seguido de "medicamento" en cualquier posición
  for (const prefix of interestPrefixes) {
    const prefixIndex = text.indexOf(prefix);
    if (prefixIndex !== -1) {
      const afterPrefix = text.slice(prefixIndex + prefix.length);
      // Después del prefijo, "medicamento" debe aparecer (con algo intermedio posible)
      if (afterPrefix.includes('medicamento')) {
        return true;
      }
      // Caso especial: el prefijo ocupa el final y "medicamento" viene después
      // Esto ya lo cubrimos con el includes arriba
    }
  }
  // Caso: "medicamento" al inicio seguido de un prefijo de interés (poco común)
  // o texto que solo contiene "estoy interesado en un medicamento" completo
  const normalizedLower = text.toLowerCase();
  if (
    (normalizedLower.includes('estoy interesado') || normalizedLower.includes('me interesa')) &&
    normalizedLower.includes('medicamento')
  ) {
    return true;
  }
  return false;
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
  // Comparar solo dígitos: quitar todo lo que no sea número
  const digitsOnly = text.replace(/[^0-9]/g, '');
  return ADMIN_NUMBERS.some((admin) => {
    const adminDigits = normalizeText(admin).replace(/[^0-9]/g, '');
    return digitsOnly === adminDigits;
  });
}

function isProductSearchRequest(value) {
  const text = normalizeText(value);
  return /\b(precio|costo|cuanto cuesta|cuanto vale|catalogo|catalogo de productos|medicamento|producto|buscar)\b/.test(text);
}

function isMedicineConsultationPhrase(value) {
  const text = normalizeText(value);
  if (!text) return false;

  const consultIntent = /\b(comprar|comprarlo|consigo|consigue|conseguir|encuentro|encuentra|precio|costo|cuanto|cuánto|donde|dónde)\b/.test(text);
  if (!consultIntent) return false;

  const extraction = extractMedicineQuery(text);
  if (!extraction) return false;

  const cleanedExtraction = normalizeText(extraction)
    .replace(/^(?:buen\s+(?:dia|día|tarde|tardes|noche|noches)|hola|buenas(?:\s+tardes|\s+noches)?|buenos(?:\s+días)?|saludos)\b[\s,.-]*/i, '')
    .trim();
  if (!cleanedExtraction) return false;

  const tokens = tokenize(cleanedExtraction).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  if (!tokens.length) return false;

  const weakTokens = new Set(['hola', 'buenas', 'tardes', 'gracias', 'muchas', 'precio', 'costo', 'comprar', 'consigo', 'encuentro', 'donde', 'dónde']);
  return tokens.some((token) => !weakTokens.has(token));
}

function isThanksMessage(value) {
  const text = normalizeText(value);
  return /^(ok\s+)?gracias(\s+.*)?$/.test(text) || /\b(gracias|mil gracias|muchas gracias|thanks|thank you)\b/.test(text);
}

function isLikelyRecipeMedicineCandidate(value) {
  const raw = String(value || '').trim();
  const normalized = normalizeText(raw);
  if (!normalized) return false;

  if (isGreetingOrMenu(normalized) || isThanksMessage(normalized) || /^(listo|resumen)$/i.test(normalized)) return false;
  if (/^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(raw)) return false;
  if (/\b(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro|paciente|nombre|apellidos?|apellido|ano nac|año nac|fecha|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección|gastroenterologia|gastroenterología)\b/i.test(normalized)) return false;

  return Boolean(extractPrimaryRecipeMedicineQuery(raw));
}

function extractPrimaryRecipeMedicineQuery(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeText(raw);
  if (!normalized) return '';

  if (/^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(raw)) return '';
  if (/\b(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro|paciente|nombre|apellidos?|apellido|ano nac|año nac|fecha|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección|gastroenterologia|gastroenterología)\b/i.test(normalized)) return '';

  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return '';

  const MED_FORM_TOKENS = new Set([
    'ampolla', 'ampollas', 'vial', 'viales', 'frasco', 'frascos', 'tableta', 'tabletas', 'capsula', 'capsulas',
    'cápsula', 'cápsulas', 'cap', 'caps', 'suspension', 'suspensión', 'susp', 'jarabe', 'gotas', 'crema', 'gel', 'polvo', 'polvos',
    'unguento', 'unguentos', 'sobres', 'sobresa', 'retad', 'retadar', 'retardar', 'retardado', 'retardada', 'capsules', 'tablet', 'tabletass'
  ]);
  const MED_QUERY_WEAK_TOKENS = new Set([
    'precio', 'costo', 'valor', 'consulta', 'consultar', 'saber', 'cuanto', 'cuánto', 'quisiera', 'quiero',
    'hola', 'buenas', 'gracias', 'medicamento', 'medicamentos', 'producto', 'productos', 'favor', 'por', 'favor',
    'disponible', 'disponibles', 'disponibilidad'
  ]);
  const isDoseToken = (token) => /^(\d+(?:[.,]\d+)?|mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i.test(token);
  const strongTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token));
  const dosageTokens = tokens.filter((token) => isDoseToken(token));
  const formTokens = tokens.filter((token) => MED_FORM_TOKENS.has(token));

  const cleanedTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !isDoseToken(token));
  const firstStrongToken = cleanedTokens.find((token) => !MED_QUERY_WEAK_TOKENS.has(token));
  if (firstStrongToken) return firstStrongToken;

  const dosagePattern = /\b(\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?))\b/i;
  const dosageMatch = raw.match(dosagePattern);
  if (dosageMatch) {
    const dose = normalizeText(dosageMatch[1]);
    const beforeDose = raw.slice(0, dosageMatch.index).trim();
    const beforeTokens = normalizeText(beforeDose).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
    const beforeStrong = beforeTokens.filter((token) => !MED_FORM_TOKENS.has(token) && !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token));
    if (beforeStrong.length) return beforeStrong[0];
    return dose;
  }

  if (strongTokens.length) {
    const top = strongTokens[0];
    // Reject short tokens and known query residuals
    const hasDosageForm = MED_FORM_TOKENS.has(tokenize(candidate).find((t) => MED_FORM_TOKENS.has(t)));
    if (top.length < 4 && !hasDosageForm) {
      // Short token without a dosage form — reject it
    } else {
      return top;
    }
    // Also reject common conversational residuals that survived cleanup
    if (/^(noches|mananas|tardes|dias|favor|ahora|también|tampoco|así|asimesmo|小伙子|entonces|mientras|más|bien|mal|quizás|quizá|puede|pueden|puedo)$/i.test(top)) return '';
    return top;
  }
  if (cleanedTokens.length) return cleanedTokens[0];
  if (formTokens.length && tokens.length > 1) {
    const afterForm = tokens.slice(tokens.findIndex((token) => MED_FORM_TOKENS.has(token)) + 1);
    const afterStrong = afterForm.find((token) => !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token) && !MED_FORM_TOKENS.has(token));
    if (afterStrong) return afterStrong;
  }
  return tokens[0] || '';
}

function looksLikeMedicineName(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (isGreetingOrMenu(text) || isThanksMessage(text) || /^(listo|resumen|bot on|bot off|bot status)$/i.test(text)) return false;

  // ── NO-CONSULTA denylist ──────────────────────────────────────────────
  // Mensajes que claramente no son consultas de medicamentos
  const NON_CONSULTA_PATTERNS = [
    /^(?:ok|okay)\s+(?:está\s+)?(?:bien|perfecto|correcto)?$/i,
    /^(?:está\s+)?bien(?:\,?\s+.*)?$/i,
    /^(?:perfecto|de\s+acuerdo|entendido|confirmo|confirmado|hecho)\s*$/i,
    /^(?:si|sí|yes|no|nop|jaja|jajaja|jajajaja|kajska)\s*$/i,
    /^(?:muchas?\s+)?gracias?(?:\s+much[oa]s?)?$/i,
    /^(?:hasta|luego|nos\s+vemos|chau|chao)\s*$/i,
    /^(?:buena?s?\s+(?:noche|tarde|día|dia|mañana))\s*$/i,
    /^(?:que\s+(?:tal|onda|haces?|hap|Haz))\s*$/i,
    /^(?:como\s+estas?|c[oó]mo\s+va[nr]?)\s*$/i,
    /^(?:hola|holita|qué\s+hay)\s*$/i,
    /^(?:cu[áa]nto\s+(?:tiempo|cuesta|cuestan))\s+/i,
    /^a\s+las\s+\d+/i,                          // "a las 4"
    /^para\s+mañana(?:\s+a\s+las|$)/i,          // "para mañana a las 4"
    /^(?:hoy|mañana|pasado\s+mañana)\s+a\s+las/i, // scheduling
    /^por\s+fa?vor\s*$/i,
    /^(?:cuando|todo\s+bien|que\s+haces?|en\s+que\s+po?demo)\s*/i,
  ];
  if (NON_CONSULTA_PATTERNS.some((re) => re.test(text))) return false;

  const extracted = extractMedicineQuery(text);
  if (extracted && extracted.length >= 4) {
    const extractedTokens = tokenize(extracted);
    if (extractedTokens.length >= 2) return true;
  }

  const tokens = tokenize(text).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  if (!tokens.length) return false;

  const hasDosageOrForm = /\b(\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|cc|ui|iu)|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina|vit)\b/.test(text);
  // tokens de conversación genérica → no parecen nombres de productos
  const GENERIC_TOKENS = new Set(['para', 'esta', 'está', 'bien', 'okay', 'ok', 'las', 'los',
    'una', 'unos', 'del', 'que', 'con', 'sin', 'por', 'muy', 'más', 'mas', 'todo', 'así',
    'ahora', 'antes', 'después', 'cuando', 'donde', 'dónde', 'como', 'cómo', 'pero', 'porque',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella',
    'tengo', 'tienes', 'tiene', 'tenemos', 'tienen', 'hacer', 'hace', 'haces', 'hacen',
    'poder', 'puede', 'pueden', 'ser', 'estar', 'ir', 'ver', 'dar', 'saber', 'querer']);
  const hasUsefulMultiTokenPhrase = tokens.length >= 2 && tokens.some((t) => t.length >= 4 && !GENERIC_TOKENS.has(t.toLowerCase()));
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

  // Strip dosage FIRST so it doesn't pollute verb-pattern capture
  const dosageStrip = /\b\d+(?:[.,]\d+)?\s*(?:mg|mgr|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)\b/gi;
  const cleanedDosage = normalizeText(text).replace(dosageStrip, ' ').replace(/\s+/g, ' ').trim();

  const verbList = [
    'por\\sfavor','me\\spuedes\\sayudar\\scon','me\\sayudas\\scon','necesito','busco','busque','buscame','buscando','quiero',
    'quisiera','me\\sinteresa','me\\sinteresan','(?<!\\w)tienes\\b','(?<!\\w)tiene\\b','(?<!\\w)tienen\\b','(?<!\\w)hay\\b',
    'disponibilidad(?:\\sde)?','informar(?:\\ssobre)?','informe(?:\\ssobre)?','consultar(?:\\ssobre)?',
    'consulta(?:\\ssobre)?','informame(?:\\ssobre)?','informarme(?:\\ssobre)?','precio(?:\\sde)?','conoces','(?<!\\w)vendes?(?!\\w)',
    'dónde\\s(?:puedo\\s)?comprar','donde\\s(?:puedo\\s)?comprar','dónde\\scomprar','donde\\scomprar',
    'dónde\\s(?:puedo\\s)?conseguir','donde\\s(?:puedo\\s)?conseguir','dónde\\sconseguir','donde\\sconseguir',
    'dónde\\sconsigo','donde\\sconsigo','dónde\\sencuentro','donde\\sencuentro'
  ];

  // Remove 'por favor' from the middle BEFORE verb matching so it doesn't confuse the greedy .+
  const cleanedNoFavor = cleanedDosage.replace(/\bpor\s+favor\b/gi, ' ').replace(/\s+/g, ' ').trim();

  // Pattern 2a: "de X [unit]" where unit follows the number → strip X unit
  // e.g. "de 75 mg de Paracetamol" → strip "75 mg", keep "Paracetamol"
  const unitList = 'mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?';
  const P2A = new RegExp(`^(?:de|del|para|con)\\s+(\\d+(?:[.,]\\d+)?)\\s+(${unitList})\\b(?:\\s+|$)(.+)$`, 'i');
  // Pattern 2b: "de X" where X is a bare number followed by another word → DON'T strip
  // The bare number belongs to the current medicine. This pattern is intentionally
  // stricter so it does NOT consume the next medicine name.
  // FIXED: only capture the bare number; the cleanup replace handles " de NUMERO" suffix.
  const P2B = /^(?:de|del)\s+(\d+(?:[.,]\d+)?)(?:\s+|$)/i;

  const verbRe = new RegExp(`(?:^|\\s)(?:${verbList.join('|')})\\s+(.+)$`, 'i');

  let candidate = cleanedNoFavor;
  for (const pattern of [verbRe, P2A, P2B]) {
    const match = cleanedNoFavor.match(pattern);
    if (match?.[1]) {
      candidate = normalizeText(match[1]);
      break;
    }
  }

  candidate = candidate
    .replace(/^por\s+favor\s*/i, '')
    // Strip hola first (before the general greeting strip so it doesn't hide buenas noches)
    .replace(/^hola\b[\s,.-]*/i, '')
    .replace(/^(?:por\s+favor\s+)?(?:hola|buenas\s+noches|buenas\s+tardes|buenos\s+días|buen\s+(?:dia|día|tarde|noche)|saludos)\b[\s,.-]*/i, '')
    .replace(/^(?:donde\s+puedo\s+comprar|dónde\s+puedo\s+comprar|donde\s+comprar|dónde\s+comprar|donde\s+consigo|dónde\s+consigo|donde\s+encuentro|dónde\s+encuentro)\s+/i, '')
    .replace(/^(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|hay\s+disponible|disponibilidad(?:\s+de)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|saber(?:\s+el)?(?:\s+precio)?(?:\s+de)?|cuanto\s+cuesta|cuánto\s+cuesta|conoces|vendes|venden)\s+/i, '')
    .replace(/^(?:comprar|conseguir|buscar|necesitar|querer|pedir|obtener|hallar|hallarme|buscame|buscame|buscarnos?|encuentra[rm]?)\s+/i, '')
    .replace(/^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a|la|el|las|los|unos|unas|y)\s+/i, '')
    // Remove 'disponible' and 'precio' from anywhere by replacing with space (not deleting), preserving medicine names between them
    .replace(/\b(?:precio|costo|valor)\b/gi, ' ')
    .replace(/\b(?:disponible|hay\s+disponible|disponibles)\b/gi, ' ')
    .replace(/\b(muchas\s+gracias|gracias\s+muchas|gracias|thank\s+you|thanks)\b.*$/i, '')
    // Strip " de NUMERO" / " del NUMERO" from end — P2B now captures only the bare
    // number, so this cleanup removes " de 30" that remains after P2B match in cases
    // like "atorvastatina de 30 nifedipina" → "atorvastatina"
    .replace(/\s+(?:de|del)\s+\d+(?:[.,]\d+)?\s*$/gi, ' ')
    .trim();
  candidate = candidate.replace(/\s+y$/i, '').trim();

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
    'hola', 'buenas', 'gracias', 'medicamento', 'medicamentos', 'producto', 'productos', 'favor', 'por', 'favor',
    'disponible', 'disponibles', 'disponibilidad'
  ]);
  const isDoseToken = (token) => /^(\d+(?:[.,]\d+)?|mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i.test(token);
  const strongTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token));
  const dosageTokens = tokens.filter((token) => isDoseToken(token));
  const formTokens = tokens.filter((token) => MED_FORM_TOKENS.has(token));

  const cleanedTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !isDoseToken(token));
  const firstStrongToken = cleanedTokens.find((token) => !MED_QUERY_WEAK_TOKENS.has(token));
  if (firstStrongToken) return firstStrongToken;

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

  // If after stripping, the candidate ends with a bare number (e.g. "de 30"
  // where 30 has no unit) — treat that number as a dosage and keep it.
  const bareNumAtEnd = candidate.match(/(\d+(?:[.,]\d+)?)\s*$/);
  if (bareNumAtEnd) {
    const numStr = bareNumAtEnd[1];
    // Scan the candidate for the last occurrence of this number so we can
    // re-combine it with the medicine name before it.
    const lastIdx = candidate.lastIndexOf(numStr);
    if (lastIdx > 0) {
      const beforeNum = candidate.slice(0, lastIdx).trim();
      if (beforeNum && !/^(?:de|del|para|con|sobre|la|el|las|los|una|unos|que|y|por|sin|no|si|un|une)$/i.test(beforeNum)) {
        const combined2 = `${beforeNum} ${numStr}`.trim();
        if (combined2.length >= 2) return combined2;
      }
    }
    if (!beforeNum || !beforeNum.trim()) return numStr;
  }

  if (strongTokens.length) return strongTokens[0];
  const weakFiltered = cleanedTokens.filter((token) => !MED_QUERY_WEAK_TOKENS.has(token));
  if (weakFiltered.length) return weakFiltered[0];
  if (formTokens.length && tokens.length > 1) {
    const afterForm = tokens.slice(tokens.findIndex((token) => MED_FORM_TOKENS.has(token)) + 1);
    const afterStrong = afterForm.find((token) => !MED_QUERY_WEAK_TOKENS.has(token) && !isDoseToken(token) && !MED_FORM_TOKENS.has(token));
    if (afterStrong) return afterStrong;
  }
  return weakFiltered[0] || '';
}

function extractStrictConsultationMedicineQuery(text) {
  const extracted = extractMedicineQuery(text);
  if (!extracted) return '';

  const tokens = tokenize(extracted).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  if (!tokens.length) return '';

  if (/^vitamina\b/i.test(extracted)) return extracted;
  return tokens[0] || extracted;
}

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
