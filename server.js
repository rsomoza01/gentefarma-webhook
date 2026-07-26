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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';
const PORT = process.env.PORT || 3000;
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OCR_PROVIDER = process.env.OCR_PROVIDER || (OPENAI_API_KEY ? 'openai' : 'none');
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const AUDIO_TRANSCRIPTION_ENABLED = process.env.AUDIO_TRANSCRIPTION_ENABLED !== 'false'; // true by default

// ── LLM Intent Router ──────────────────────────────────────────────────
const LLM_INTENT_MODEL = process.env.LLM_INTENT_MODEL || 'gpt-4o-mini';
const LLM_INTENT_ENABLED = process.env.LLM_INTENT_ENABLED !== 'false'; // true by default
const LLM_INTENT_TIMEOUT_MS = Number(process.env.LLM_INTENT_TIMEOUT_MS || 3000);
const LLM_INTENT_CONFIDENCE_THRESHOLD = Number(process.env.LLM_INTENT_CONFIDENCE_THRESHOLD || 0.70);
const OPENAI_VISION_PROMPT = process.env.OPENAI_VISION_PROMPT || `Eres un asistente de farmacia. De esta imagen, extrae TODOS los nombres de medicamentos que aparezcan.

Pueden ser de dos tipos:
1. RECETA MÉDICA: lista de varios medicamentos (ej: "Esoz 40 mg", "Leporit 25 mg", "Daflon 500 mg")
2. FOTO DE MEDICAMENTO: un solo medicamento (ej: "Paracetamol 500 mg")

Busca CADA medicamento visible en la imagen - no te detengas en el primero.

FORMATO DE RESPUESTA:
- Si hay VARIOS medicamentos: cada uno en su propia línea, formato "NOMBRE DOSIS"
  Ejemplo para receta con 3 medicamentos:
  ESOZ 40 MG
  LEPRIT 25 MG
  DAFLON 500 MG

- Si hay UN SOLO medicamento: "NOMBREMEDICAMENTO DOSIS" (una sola línea, igual que antes)

- Si NO pudiste leer ningún medicamento: "NO ENCONTRADO"`;

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
// City coordinates (hardcoded for Venezuela main cities)
// Used for geolocation-based pharmacy filtering
// ----------------------------------------------------
const CITY_COORDS = {
  'ciudad bolivar': { lat: 8.1292, lng: -63.5409 },
  'caracas':        { lat: 10.4806, lng: -66.9036 },
  'caja seca':      { lat: 10.4628, lng: -68.7613 },
  'zaraza':         { lat: 9.3500, lng: -67.3500 },
};

const DEFAULT_RADIO_KM = 5; // km radius for pharmacy search

// ----------------------------------------------------
// Session memory
// ----------------------------------------------------
const sessions = new Map();
const processedInboundMessages = new Map();
const globalCatalogByPhone = new Map(); // phone -> { options, timestamp } — survives session reloads
let providersCache = []; // cached providers with location for geolocation filtering
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
      updatedAt: Date.now(),
      userCity: null,     // ciudad del usuario ej: "ciudad bolivar"
      userCoords: null,   // { lat, lng } del usuario
      pendingCityRetry: null, // { text, options, context } — para reintentar tras detectar ciudad
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
  // First try session catalogHistory (may be empty due to serverless statelessness)
  const history = Array.isArray(session.catalogHistory) ? session.catalogHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const snapshot = history[i];
    if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length) return snapshot;
  }
  // Fallback: check global catalog store (persists across session reloads in serverless)
  const phone = session?.phone;
  if (phone && globalCatalogByPhone.has(phone)) {
    const globalSnap = globalCatalogByPhone.get(phone);
    if (globalSnap && Array.isArray(globalSnap.options) && globalSnap.options.length > 0) {
      return globalSnap;
    }
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

  // Only treat as pure number list if there are 3+ distinct numbers AND
  // the numbers are NOT all clearly dosage tokens (e.g. 75, 50, 30, 10 from
  // "clopidrogel de 75 Losartan potásico de 50 atorvastatina de 30 nifedipina de 10 mg").
  // Reject if the text contains medicine-like tokens (has letters beyond just numbers).
  const hasLettersBeyondNumbers = /[a-zA-Z]{3,}/.test(normalized);
  const listOnly = parseOptionList(normalized);
  if (listOnly.length >= 3 && hasLettersBeyondNumbers) {
    // 3+ numbers in a text that also has words → NOT a selection, skip
  } else if (listOnly.length >= 2) {
    return buildResult(listOnly, quantity, normalized);
  }

  return null;
}

function isSelectionPhrase(value) {
  const text = normalizeText(value);
  // Require STRONG selection keywords: opcion, caja(s), unidad(es), x, numero, nro, agregar con x
  // "quiero" alone is too generic (matches "quiero saber si disponen de clopidogrel de 75")
  const hasStrongKeyword = /\b(opcion|opci[oó]n|caja[se]?|unidad(?:es)?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/.test(text) && /\d+/.test(text);
  // "X" as separator: "3 x 2", "2x1" — X must be adjacent to numbers
  const hasXPattern = /^\d+\s*x\s*\d+/i.test(text);
  return hasStrongKeyword || hasXPattern;
}


function isSelectionIntent(value) {
  const text = normalizeText(value);
  // Require STRONG selection keywords (same rationale as isSelectionPhrase)
  const hasStrongKeyword = /\b(opcion|opci[oó]n|caja[se]?|unidad(?:es)?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/.test(text) && /\d+/.test(text);
  const hasXPattern = /^\d+\s*x\s*\d+/i.test(text);
  return hasStrongKeyword || hasXPattern;
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

app.get('/firebase-check', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ error: 'Provide ?q=medicine_name' });
  const normalized = normalizeText(q);
  const qLower = q.toLowerCase();
  console.log(`🧪 [FIREBASE-CHECK] q='${q}' normalized='${normalized}'`);
  try {
    // First: use Firestore array-contains (case-SENSITIVE, exact match)
    const [acPmSnap, acPpSnap] = await Promise.all([
      db.collection('products-market').where('productTitleArray', 'array-contains', qLower).limit(20).get(),
      db.collection('providers-products').where('productTitleArray', 'array-contains', qLower).limit(20).get(),
    ]);
    const arrayContainsResults = {
      productsMarket: acPmSnap.docs.map((d) => ({ id: d.id, ProductTitle: d.data().ProductTitle, productTitleArray: d.data().productTitleArray })),
      providersProducts: acPpSnap.docs.map((d) => ({ id: d.id, ProductTitle: d.data().productTitle, productTitleArray: d.data().productTitleArray })),
    };
    console.log(`🧪 [FIREBASE-CHECK] array-contains qLower='${qLower}' => productsMarket=${acPmSnap.size} providersProducts=${acPpSnap.size}`);

    // Second: full scan with exact token match (case-insensitive)
    const [pmSnap, ppSnap] = await Promise.all([
      db.collection('products-market').limit(2000).get(),
      db.collection('providers-products').limit(2000).get(),
    ]);
    const results = { productsMarket: [], providersProducts: [] };
    pmSnap.docs.forEach((d) => {
      const data = d.data();
      const title = normalizeText(data.ProductTitle || '');
      const arr = Array.isArray(data.productTitleArray) ? data.productTitleArray.map(normalizeText) : [];
      if (title.toLowerCase().includes(normalized.toLowerCase()) || arr.some((a) => a.toLowerCase() === normalized.toLowerCase())) {
        results.productsMarket.push({ id: d.id, ProductTitle: data.ProductTitle, productTitleArray: data.productTitleArray, StatusId: data.StatusId, ProviderId: data.ProviderId });
      }
    });
    ppSnap.docs.forEach((d) => {
      const data = d.data();
      const title = normalizeText(data.productTitle || '');
      const arr = Array.isArray(data.productTitleArray) ? data.productTitleArray.map(normalizeText) : [];
      if (title.toLowerCase().includes(normalized.toLowerCase()) || arr.some((a) => a.toLowerCase() === normalized.toLowerCase())) {
        results.providersProducts.push({ id: d.id, productTitle: data.productTitle, productTitleArray: data.productTitleArray, provider: data.provider });
      }
    });
    console.log(`🧪 [FIREBASE-CHECK] full-scan => products-market=${results.productsMarket.length} providers-products=${results.providersProducts.length}`);
    const response = { query: q, normalized, arrayContainsResults, fullScanResults: results };
    res.json(response);
  } catch (e) {
    console.error(`🧪 [FIREBASE-CHECK] error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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
    normalizedEvent === 'Message' ||
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
    // Placeholder tokens that Evolution GO may set as caption for image messages
    const PLACEHOLDER_BODY_TOKENS = new Set(['image', 'foto', 'photo', 'imagen', 'pic', 'picture']);
    const rawBodyIsPlaceholder = PLACEHOLDER_BODY_TOKENS.has(rawBody.trim().toLowerCase());
    // Prioritize user's typed text when meaningful; use OCR only as fallback (image-only messages)
    const body = (rawBody && !rawBodyIsPlaceholder) ? rawBody : (mediaAnalysis?.text ? (sanitizedOcrText || rawBody) : rawBody);
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
    console.log('🧪 [ROUTE-RESPONSE] body="%s" response=%s', body, response ? `"${response.slice(0,50)}..."` : 'null');
    if (response) {
      await sendOutboundWhatsAppMessage(from, response);
    } else {
      console.log('🧪 [ROUTE-RESPONSE] No response generated for body="%s"', body);
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
  const isAudio = /^audio\//.test(mimeType) || mimeType.includes('ogg') || mimeType.includes('opus');
  if (!hasInlineBase64 && !isImage && !isPdf && !isAudio) return null;

  console.log(
    `🖼️ Analizando media: inlineBase64=${hasInlineBase64 ? inlineBuffer.length : 0} url=${media?.url || media?.URL || media?.mediaUrl || media?.directPath || ''} mimeType=${mimeType} isAudio=${isAudio}`
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
  const isAudio = /^audio\//.test(mimeType) || mimeType.includes('ogg') || mimeType.includes('opus');

  // ── Audio transcription via Whisper ──────────────────────────────────
  if (isAudio && AUDIO_TRANSCRIPTION_ENABLED) {
    console.log('🎤 Audio detectado, iniciando transcripción Whisper...', {
      mimeType,
      bufferBytes: buffer.length,
      hasOpenAIKey: Boolean(OPENAI_API_KEY)
    });
    const transcribedText = await transcribeAudio(buffer, mimeType);
    if (transcribedText) {
      console.log(`🎤 Transcripción exitosa (${transcribedText.length} chars):`, transcribedText.slice(0, 200));
      return transcribedText;
    }
    console.warn('⚠️ Transcripción de audio sin resultado.');
    return '';
  }
  // ── Image / PDF OCR via Vision ────────────────────────────────────────
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

// ── Audio transcription via OpenAI Whisper ─────────────────────────────
async function transcribeAudio(buffer, mimeType) {
  if (!OPENAI_API_KEY) {
    console.warn('⚠️ AUDIO_TRANSCRIPTION_ENABLED pero OPENAI_API_KEY no está configurada.');
    return '';
  }

  // Determine file extension and MIME type for the API
  let extension = 'mp3';
  let apiMimeType = 'audio/mp3';
  if (mimeType.includes('ogg') || mimeType.includes('opus')) {
    extension = 'ogg';
    apiMimeType = 'audio/ogg';
  } else if (mimeType.includes('wav') || mimeType.includes('wave')) {
    extension = 'wav';
    apiMimeType = 'audio/wav';
  } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
    extension = 'mp3';
    apiMimeType = 'audio/mpeg';
  } else if (mimeType.includes('webm')) {
    extension = 'webm';
    apiMimeType = 'audio/webm';
  }

  // Build a multipart/form-data request manually using axios
  // Whisper API accepts: file (binary) + model (string) + language (optional)
  const boundary = `----FormBoundary${Date.now()}`;
  const headerBuf = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${extension}"\r\nContent-Type: ${apiMimeType}\r\n\r\n`,
    'utf8'
  );
  const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fileBuf = buffer;
  const bodyBuf = Buffer.concat([headerBuf, fileBuf, footerBuf]);

  try {
    const response = await axios.post(
      `${OPENAI_BASE_URL}/audio/transcriptions`,
      bodyBuf,
      {
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60000 // 60s for audio transcription
      }
    );

    // Whisper response: { "text": "..." }
    const text = response.data?.text?.trim();
    return text || '';
  } catch (error) {
    const status = error.response?.status;
    const responseText = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error(`❌ Error transcripción Whisper (${status || 'no-status'}):`, responseText);
    return '';
  }
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
// LLM Intent Router — Fase 1 del agente inteligente
// ----------------------------------------------------
// Clasifica el mensaje del usuario usando un LLM en vez de regex.
// Retorna: { intent, medicines, confidence, raw } o null si falla.
// El sistema regex original se usa como fallback automático.
const LLM_INTENT_SYSTEM_PROMPT = `Eres el clasificador de intenciones de un bot de farmacia en WhatsApp (Gentefarma).

Tu ÚNICA tarea es clasificar el mensaje del usuario y extraer medicamentos si los hay.

INTENTES POSIBLES:
- "medicine_search": el usuario busca uno o más medicamentos (por nombre, dosis, o descripción)
- "location": pregunta dónde está la farmacia / dirección / local físico
- "hours": pregunta horario de atención
- "payment": pregunta formas de pago
- "delivery": pregunta precio/costo de envío
- "how_to_order": pregunta cómo hacer un pedido
- "app": pregunta sobre la aplicación de Gentefarma
- "greeting": saludo simple sin consulta médica (hola, buenos días, etc.)
- "thanks": agradecimiento sin consulta (gracias, muchas gracias)
- "order_sent": notificación de que ya envió el pedido
- "human": pide hablar con una persona / colaborador
- "summary": pide ver el resumen del pedido (LISTO, resumen)
- "selection": está seleccionando una opción del catálogo (ej: "1", "opcion 2", "2 x 3")
- "confirmation": confirmación simple sin consulta (ok, está bien, perfecto, sí, no)
- "info": pide información general sobre Gentefarma
- "unknown": no encaja en ninguna categoría

REGLAS CRÍTICAS:
- Si el mensaje contiene NOMBRES DE MEDICAMENTOS (aunque tenga saludo), el intent es "medicine_search"
- "retadar" y "retad" son errores OCR de "retard" — normalízalo a "retard" en medicines[]
- "potasico", "sodico", "clorhidrato" son sales farmacéuticas — inclúyelas como parte del nombre
- Formas farmacéuticas como "cap", "susp", "crema", "polvo", "gotas" son parte del nombre del medicamento
- Los saludos CON medicamentos (ej: "hola, busco losartan") → intent: "medicine_search", medicines: ["losartan"]
- Los saludos SIN medicamentos (ej: "hola buenos días") → intent: "greeting"
- Si el usuario escribe solo números o "opcion X" → intent: "selection"
- No inventes medicamentos que no están en el texto

RESPONDE SOLO en este formato JSON (sin markdown, sin backticks):
{"intent":"...","medicines":["..."],"confidence":0.95}

Ejemplos:
- "busco losartan potasico 50mg" → {"intent":"medicine_search","medicines":["losartan potasico 50mg"],"confidence":0.98}
- "hola buenos días feliz viernes" → {"intent":"greeting","medicines":[],"confidence":0.95}
- "donde están ubicados" → {"intent":"location","medicines":[],"confidence":0.99}
- "hola, tienes daflon 500mg" → {"intent":"medicine_search","medicines":["daflon 500mg"],"confidence":0.97}
- "1 x 2" → {"intent":"selection","medicines":[],"confidence":0.90}
- "ok está bien" → {"intent":"confirmation","medicines":[],"confidence":0.90}
- "bumetin retadar evigax moderan" → {"intent":"medicine_search","medicines":["bumetin retard","evigax","moderan"],"confidence":0.88}`;

async function classifyIntentWithLLM(text, sessionContext) {
  // Skip if disabled or no API key
  if (!LLM_INTENT_ENABLED || !OPENAI_API_KEY) return null;

  // Skip very short messages (likely selections or noise) — let regex handle those
  const trimmed = (text || '').trim();
  if (trimmed.length < 3) return null;

  // Skip pure numeric selections — those are handled by parseSelectionCommand
  if (/^\d+(\s*[x×]\s*\d+)?$/.test(trimmed)) return null;

  try {
    const isOpenRouter = /openrouter\.ai/i.test(OPENAI_BASE_URL);
    const sessionHint = sessionContext?.mode ? `\n\nContexto de sesión: el usuario está en modo "${sessionContext.mode}" (estaba seleccionando opciones del catálogo).` : '';
    const userPrompt = `${trimmed}${sessionHint}`;

    const payload = {
      model: LLM_INTENT_MODEL,
      messages: [
        { role: 'system', content: LLM_INTENT_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    };

    const response = await axios.post(
      `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`,
      payload,
      {
        timeout: LLM_INTENT_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          ...(isOpenRouter ? {
            'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://gentefarma.app',
            'X-Title': process.env.OPENROUTER_APP_NAME || 'Gentefarma Intent Router'
          } : {})
        }
      }
    );

    const raw = String(response?.data?.choices?.[0]?.message?.content || '').trim();

    // Strip markdown code fences if present (some models wrap JSON in ```json ... ```)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // Parse JSON response
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // Try to extract JSON from the response if it contains extra text
      const jsonMatch = cleaned.match(/\{[^{}]*"intent"[^{}]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { return null; }
      } else {
        console.log('🧠 [LLM-INTENT] JSON parse failed, raw:', raw.slice(0, 200));
        return null;
      }
    }

    // Validate required fields
    if (!parsed.intent || typeof parsed.confidence !== 'number') {
      console.log('🧠 [LLM-INTENT] Invalid response structure:', JSON.stringify(parsed).slice(0, 200));
      return null;
    }

    // Validate intent is one of the allowed values
    const VALID_INTENTS = new Set([
      'medicine_search', 'location', 'hours', 'payment', 'delivery',
      'how_to_order', 'app', 'greeting', 'thanks', 'order_sent',
      'human', 'summary', 'selection', 'confirmation', 'info', 'unknown'
    ]);
    if (!VALID_INTENTS.has(parsed.intent)) {
      console.log('🧠 [LLM-INTENT] Unknown intent:', parsed.intent);
      return null;
    }

    // Validate medicines array
    const medicines = Array.isArray(parsed.medicines)
      ? parsed.medicines.filter(m => typeof m === 'string' && m.trim().length >= 2)
      : [];

    const result = {
      intent: parsed.intent,
      medicines,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      raw: cleaned
    };

    console.log('🧠 [LLM-INTENT] text="%s" => intent=%s medicines=%s confidence=%.2f',
      trimmed.slice(0, 60), result.intent, JSON.stringify(result.medicines), result.confidence);

    return result;
  } catch (err) {
    // Timeout, network error, rate limit, etc. — fall through to regex
    const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
    const status = err.response?.status;
    console.log('🧠 [LLM-INTENT] %s: %s', isTimeout ? 'TIMEOUT' : 'ERROR',
      (err.message || String(err)).slice(0, 120));
    if (status === 429) console.log('🧠 [LLM-INTENT] Rate limited — falling back to regex');
    return null;
  }
}

// ── LLM Medicine Extraction Fallback ─────────────────────────────────────
// Runs AFTER the regex pipeline fails to extract any medicines.
// Strategy: regex first → LLM only if regex returns nothing.
// This keeps LLM calls rare (only for genuinely ambiguous/empty cases),
// saving latency and API cost while covering edge cases the regex misses.
async function extractMedicinesWithLLMFallback(text, session) {
  // Phase 1: regex pipeline (fast, free, handles 90%+ of inputs)
  const regexMedicines = extractMedicineRequests(text);
  const regexFallback = extractMedicineRequestsFromSegments(text);
  const allRegex = [...new Set([...regexMedicines, ...regexFallback])];

  if (allRegex.length > 0) {
    console.log('🧪 [LLM-FALLBACK] Regex extracted %d medicines: %s — no LLM needed',
      allRegex.length, JSON.stringify(allRegex));
    return allRegex;
  }

  // Phase 2: LLM fallback — only when regex returned nothing
  console.log('🧪 [LLM-FALLBACK] Regex empty — activating LLM extraction for: "%s"',
    String(text).slice(0, 80));

  if (!LLM_INTENT_ENABLED || !OPENAI_API_KEY) {
    console.log('🧪 [LLM-FALLBACK] LLM not enabled — returning empty');
    return [];
  }

  try {
    const llmResult = await classifyIntentWithLLM(text, { mode: session?.mode });
    if (llmResult && llmResult.intent === 'medicine_search' && llmResult.confidence >= LLM_INTENT_CONFIDENCE_THRESHOLD) {
      const meds = dedupLLMMedicines(llmResult.medicines || []);
      console.log('🧠 [LLM-FALLBACK] LLM extracted %d medicines: %s (confidence=%.2f)',
        meds.length, JSON.stringify(meds), llmResult.confidence);
      return meds;
    }
    console.log('🧪 [LLM-FALLBACK] LLM returned null or low confidence — returning empty');
    return [];
  } catch (llmErr) {
    console.log('🧪 [LLM-FALLBACK] LLM error — returning empty: %s', llmErr.message?.slice(0, 100));
    return [];
  }
}

// Map LLM intent to routeMessage handler
// ── SMART SUBSET DEDUP ─────────────────────────────────────────────────
// Remove ONLY dosage-form fragments, NOT valid medicine base names.
// "bumetin" → REMOVE (it's a dosage form fragment of "bumetin retard")
// "esoz"    → KEEP   (it's a real medicine, not a dosage form fragment)
// Strategy: extract medicine roots (strip dosage tokens/numbers from each item),
// then check if rootA ⊆ rootB and rootA != rootB.
// Dosage tokens to strip: numbers, mg/mcg/g/ml units, forms like cap/susp/crema/etc.
function getMedicineRoot(raw) {
  const tokens = String(raw || '').toLowerCase().split(/\s+/).filter(Boolean);
  const DOSAGE_TOKENS = new Set([
    'mg','mcg','g','gr','ml','cc','ui','iu',
    'cap','caps','capsula','capsulas','capsule','capsules',
    'susp','suspen','suspension','sol','solucion',
    'crema','cremas','gel','pomada','unguento','ung',
    'polvo','polvos','jarabe','jar','gotas','gota',
    'ampolla','ampollas','amp','sobre','sobres','sb',
    'retard','retad','retadar','retardo','retardado','retardada',
    'forte','regular',
    'tableta','tabletas','tab','tabs',
    'inyectable','inyect',
  ]);
  const isDose = t => /^(\d+(?:[.,]\d+)?)$/.test(t) || DOSAGE_TOKENS.has(t);
  const rootTokens = tokens.filter(t => !isDose(t) && t.length > 1);
  return rootTokens.join(' ');
}

function dedupLLMMedicines(medicines) {
  if (!Array.isArray(medicines) || medicines.length === 0) return [];

  const LLM_DOSAGE_FORMS = new Set([
    'cap','caps','capsula','capsulas','capsule','capsules',
    'susp','suspen','suspension','solucion','sol',
    'crema','cremas','gel','pomada','unguento','ung',
    'polvo','polvos','polv',
    'jarabe','jar','gotas','gota',
    'ampolla','ampollas','amp','sobre','sobres','sb',
    'retard','retad','retadar','retardo','retardado','retardada',
    'forte','regular',
    'tableta','tabletas','tab','tabs','tabl',
    'mgr','mgrs',
    'inyectable','inyect',
  ]);

  // Step 1: normalize and filter out dosage forms / too-short items
  const normalized = medicines
    .map(m => String(m || '').trim())
    .filter(m => m.length >= 2)
    .map(m => {
      const lower = m.toLowerCase();
      return { original: m, lower, tokens: lower.split(/\s+/) };
    })
    .filter(item => {
      // Reject if the ENTIRE string is a single dosage form
      if (item.tokens.length === 1 && LLM_DOSAGE_FORMS.has(item.tokens[0])) {
        console.log('🧠 [LLM-DEDUP] Rejected dosage form: "%s"', item.original);
        return false;
      }
      // Reject pure numbers
      if (/^\d+(?:[.,]\d+)?$/.test(item.lower)) {
        console.log('🧠 [LLM-DEDUP] Rejected pure number: "%s"', item.original);
        return false;
      }
      // Reject x15, x30, x5-type quantity patterns (x + digits = package quantity, not medicine)
      if (/^x\d+$/i.test(item.lower)) {
        console.log('🧠 [LLM-DEDUP] Rejected quantity pattern: "%s"', item.original);
        return false;
      }
      return true;
    });

  // Step 2: SMART SUBSET DEDUP using medicine roots
  // For each pair (shorter, longer), extract roots (strip dosage tokens/numbers).
  // Remove the shorter item ONLY if: rootShorter ⊆ rootLonger AND rootShorter != rootLonger.
  // This means "bumetin" (root="bumetin") is subset of "bumetin retard" (root="bumetin retard")
  // → REMOVE "bumetin". But "esoz" (root="esoz") is NOT a subset of "esoz" (root="esoz")
  // → KEEP "esoz".
  const roots = new Map();
  for (const item of normalized) {
    roots.set(item.lower, getMedicineRoot(item.lower));
  }

  const sorted = [...normalized].sort((a, b) => b.tokens.length - a.tokens.length);
  const kept = [];
  const keptLowers = new Set();

  for (const item of sorted) {
    const rootItem = roots.get(item.lower) || '';
    let isSubset = false;

    for (const existing of kept) {
      const rootExisting = roots.get(existing.lower) || '';
      // Skip if either root is empty (all-dosage string)
      if (!rootItem || !rootExisting) continue;
      // Two dedup cases:
      // 1. Same root (e.g. "evigax" root="evigax" vs "evigax cap" root="evigax"):
      //    remove the shorter since it's the same medicine without dosage form.
      // 2. rootItem is a proper word-boundary prefix of rootExisting (e.g.
      //    "bumetin" root="bumetin" vs "bumetin retard" root="bumetin retard"):
      //    remove the shorter since the longer is a more specific form of it.
      const sameRoot = (rootItem === rootExisting);
      const isPrefix = rootExisting.startsWith(rootItem + ' ');
      if (sameRoot || isPrefix) {
        isSubset = true;
        console.log('🧠 [LLM-DEDUP] %s (root="%s") removed as subset of "%s" (root="%s", sameRoot=%s)',
          item.original, rootItem, existing.original, rootExisting, sameRoot);
        break;
      }
    }

    if (!isSubset && !keptLowers.has(item.lower)) {
      kept.push(item);
      keptLowers.add(item.lower);
    }
  }

  const result = kept.map(i => i.original);
  console.log('🧠 [LLM-DEDUP] Input=%s → Output=%s',
    JSON.stringify(medicines), JSON.stringify(result));
  return result;
}

async function handleLLMIntent(llmResult, phone, text, session, context) {
  if (!llmResult || llmResult.confidence < LLM_INTENT_CONFIDENCE_THRESHOLD) {
    console.log('🧠 [LLM-INTENT] Low confidence (%.2f < %.2f) — using regex fallback',
      llmResult?.confidence || 0, LLM_INTENT_CONFIDENCE_THRESHOLD);
    return null; // signal: use regex pipeline
  }

  const { intent, medicines } = llmResult;
  const normalized = normalizeText(text);
  const pushName = context?.pushName || '';

  switch (intent) {
  case 'medicine_search': {
      // LLM extracted medicines — search directly in Firebase
      // Dedup first: remove dosage forms, prefix-subsets, and exact dupes
      console.log('🧠 [LLM-MEDICINES] raw medicines from LLM: %s', JSON.stringify(medicines));
      const preExtractedMedicines = dedupLLMMedicines(medicines || []);
      clearSelectionState(session);
      const searchQuery = preExtractedMedicines.length > 0 ? preExtractedMedicines.join(' ') : text;
      console.log('🧠 [LLM-INTENT] Medicine search — medicines=%s deduped=%s query=%s',
        JSON.stringify(medicines), JSON.stringify(preExtractedMedicines), searchQuery);
      return await searchAndBuildCatalogResponse(
        searchQuery, session,
        {
          hasOcrText: Boolean(context?.hasOcrText),
          strictConsultationMode: true,
          preExtractedMedicines
        },
        { phone, pushName }
      );
    }

    case 'location':
      clearSelectionState(session);
      return buildLocationMessage();

    case 'hours':
      clearSelectionState(session);
      return buildHorarioMessage();

    case 'payment':
      clearSelectionState(session);
      return buildPagoMessage();

    case 'delivery':
      clearSelectionState(session);
      return buildDeliveryPriceMessage();

    case 'how_to_order':
      clearSelectionState(session);
      return buildHowToOrderMessage();

    case 'app':
      clearSelectionState(session);
      return buildAppMessage();

    case 'greeting':
      clearSelectionState(session);
      return buildMenuMessage();

    case 'thanks':
      return 'Con gusto. Estoy aquí para ayudarte cuando necesites buscar otro medicamento.';

    case 'order_sent':
      return buildOrderSentMessage();

    case 'human':
      enableHumanHandoff(session);
      return buildHumanAgentMessage();

    case 'summary':
      return buildSelectedProductsSummary(session);

    case 'selection':
      // Let the existing selection pipeline handle it (parseSelectionCommand etc.)
      return null;

    case 'confirmation':
      return buildDefaultFallbackMessage(session);

    case 'info':
      clearSelectionState(session);
      return buildMoreInfoMessage();

    case 'unknown':
      return null; // fall through to regex pipeline

    default:
      return null; // fall through to regex pipeline
  }
}

// ----------------------------------------------------
// Conversation router
// ----------------------------------------------------
async function routeMessage(phone, text, session, context = {}) {
  const normalized = normalizeText(text);
  // Define hasOcrText early so the city gate can reference it.
  // CONSUME it from context immediately to prevent re-entry on follow-up text messages.
  const hasOcrText = Boolean(context?.hasOcrText);
  if (context) context.hasOcrText = false;
  console.log('🧪 [ROUTE] text="%s" userCity="%s" mode="%s" isNewOrder=%s hasOcrText=%s', text.substring(0,80), session.userCity, session.mode, isNewOrderNotification(normalized), hasOcrText);
  // ── ULTRA-EARLY-SELECTION-GUARD ────────────────────────────────────────
  // Before ANY extraction, detect if the message is purely a selection phrase.
  // If session has pending selection results (from a prior catalog), handle it
  // immediately so it NEVER enters extractMedicineQuery / searchAndBuildCatalogResponse.
  if (isSelectionPhrase(normalized)) {
    // Use the LATEST catalog snapshot (not resolveSelectionResults which can return
    // the extracted query text as a fallback — that gives us ["1 caja de la opcion 2"]
    // instead of the actual catalog options).
    const snapshot = getLatestCatalogSnapshot(session);
    const hasCatalogOptions = Array.isArray(snapshot?.options) && snapshot.options.length > 0;
    if (hasCatalogOptions) {
      console.log('🛡️ [ULTRA-GUARD] Selection phrase + catalog snapshot found — processing directly');
      const parsed = parseSelectionCommand(normalized);
      if (parsed) {
        session.pendingSelectionResults = snapshot.options;
        session.mode = 'awaiting_choice';
        touchSession(session);
        // Process selection immediately — do NOT fall through to extractMedicineQuery
        const selected = snapshot.options[parsed.option - 1];
        if (!selected) {
          return `⚠️ La opción *${parsed.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
        }
        addItemToCart(session, selected, parsed.quantity);
        touchSession(session);
        clearSelectionState(session);
        return formatSelectionSavedMessage(selected, parsed.quantity, session);
      } else {
        return `✏️ No entendí la selección. Escribe *número de opción + cantidad*, por ejemplo: *1* o *2 x 2*.`;
      }
    }
  }

  // Allow user to change city at any time
  const normalizedTextForCityChange = normalizeText(text);
  if (normalizedTextForCityChange.includes('cambiar ciudad') ||
      normalizedTextForCityChange.includes('cambiar mi ciudad') ||
      normalizedTextForCityChange.includes('otra ciudad') ||
      normalizedTextForCityChange.includes('otro ciudad')) {
    session.userCity = null;
    session.userCoords = null;
    session.pendingCityRetry = null;
    touchSession(session);
    return 'Entendido. Indícame tu nueva ciudad: *Ciudad Bolívar*, *Caracas*, *Caja Seca* o *Zaraza*.';
  }

  // ── CITY GATE ─────────────────────────────────────────────────────────
  // If user has not set their city yet, intercept medicine searches and ask for it.
  // Store pending query so we retry it after city is detected.
  // Also handle the case where session.userCity is the STRING 'null' (malformed).
  // SKIP city gate for OCR messages — the OCR block handles city internally.
  if ((!session.userCity || session.userCity === 'null' || session.userCity === 'undefined') && !hasOcrText) {
    // Check if user is responding to a city question (pendingCityRetry is set)
    if (session.pendingCityRetry) {
      const cityInfo = detectCityFromText(text);
      console.log('🧪 [CITY-GATE] pendingCityRetry set text="%s" cityInfo=%s', text, JSON.stringify(cityInfo));
      if (cityInfo) {
        // City detected — save to session and retry the pending query
        session.userCity = cityInfo.city;
        session.userCoords = cityInfo.coords;
        const pending = session.pendingCityRetry;
        session.pendingCityRetry = null;
        touchSession(session);
        console.log(`[CITY] Detected='${cityInfo.city}' coords=${JSON.stringify(cityInfo.coords)} — retrying pending query`);
        // Retry the pending medicine query (recursive call with same phone/session)
        return await routeMessage(phone, pending.text, session, pending.context);
      } else {
        // No city detected, ask again
        return 'Para buscar farmacias cerca de ti, indícame tu ciudad: *Ciudad Bolívar*, *Caracas*, *Caja Seca* o *Zaraza*.';
      }
    }

    // Check if the user is directly sending a city name (not a medicine query)
    const cityInfo = detectCityFromText(text);
    console.log('🧪 [CITY-GATE] direct detectCityFromText text="%s" cityInfo=%s', text, JSON.stringify(cityInfo));
    if (cityInfo) {
      session.userCity = cityInfo.city;
      session.userCoords = cityInfo.coords;
      touchSession(session);
      console.log(`[CITY] Direct detect from city gate: '${cityInfo.city}'`);
      if (session.pendingCityRetry) {
        const pending = session.pendingCityRetry;
        session.pendingCityRetry = null;
        return await routeMessage(phone, pending.text, session, pending.context);
      }
      return `✅ Ciudad configurada: *${cityInfo.city}*. Ahora busca el medicamento que necesitas.`;
    }

    // Not a city response — check if it looks like a medicine search
    const looksLikeMedicine = extractMedicineQuery(text) || extractStrictConsultationMedicineQuery(text);
    console.log('🧪 [CITY-GATE] text="%s" looksLikeMedicine="%s" pendingCityRetry=%s', text, looksLikeMedicine, session.pendingCityRetry ? 'set' : 'null');
    if (looksLikeMedicine) {
      // Ask user to set their city first
      session.pendingCityRetry = { text, context };
      touchSession(session);
      return 'Para buscar farmacias cerca de ti, indícame tu ciudad: *Ciudad Bolívar*, *Caracas*, *Caja Seca* o *Zaraza*.';
    }
    // Non-medicine queries (small talk, etc.) pass through without city gate
  }

  // ── LLM INTENT ROUTER ──────────────────────────────────────────────────
  // Phase 1 of the intelligent agent: use LLM to classify intent BEFORE regex.
  // If the LLM returns a high-confidence classification, handle it directly.
  // Otherwise, fall through to the regex pipeline (the existing system).
  // This runs AFTER the ULTRA-GUARD (selection handling) but BEFORE extractMedicineQuery.
  if (LLM_INTENT_ENABLED && OPENAI_API_KEY) {
    try {
      const llmResult = await classifyIntentWithLLM(text, { mode: session.mode });
      if (llmResult) {
        const llmResponse = await handleLLMIntent(llmResult, phone, text, session, context);
        if (llmResponse !== null) {
          console.log('🧠 [LLM-INTENT] Handled by LLM: intent=%s confidence=%.2f',
            llmResult.intent, llmResult.confidence);
          return llmResponse;
        }
        // llmResponse === null means LLM wants to fall through (selection, unknown, etc.)
        console.log('🧠 [LLM-INTENT] LLM returned null — falling through to regex pipeline');
      }
    } catch (llmErr) {
      // Never let LLM errors crash the bot — always fallback to regex
      console.log('🧠 [LLM-INTENT] Exception — falling through to regex:', llmErr.message?.slice(0, 100));
    }
  }

  const directMedicineQuery = extractMedicineQuery(text);
  const strictConsultationQuery = extractStrictConsultationMedicineQuery(text);
  const extractedMedicineRequests = await extractMedicinesWithLLMFallback(text, session);
  const consultationQuery = strictConsultationQuery || directMedicineQuery || extractedMedicineRequests[0] || text;
  const consultationIsMedicine = isMedicineConsultationPhrase(normalized);
  const isMedicineSignal = Boolean(
    directMedicineQuery ||
    extractedMedicineRequests.length > 0 ||
    isProductSearchRequest(normalized) ||
    looksLikeMedicineName(normalized) ||
    consultationIsMedicine
  );
  // hasOcrText already defined at top of routeMessage and consumed from context.
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
    console.log('🧪 [DIAG-ROUTE] consultationQuery=%s strictConsultationQuery=%s directMedicineQuery=%s searchQuery=%s text=%s', JSON.stringify(consultationQuery), JSON.stringify(strictConsultationQuery), JSON.stringify(directMedicineQuery), JSON.stringify(searchQuery), JSON.stringify(text));
    const catalogResult = await searchAndBuildCatalogResponse(searchQuery, session, { hasOcrText, strictConsultationMode: true, recipeMode: true, preExtractedMedicines: extractedMedicineRequests }, { phone, pushName });
    if (catalogResult !== null) return catalogResult;
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

  // 🚨 DIAGNOSTIC: log ALL early-return conditions for this text
  console.log('🧪 [EARLY-CHECKS] text="%s" isNewOrderNotification=%s isDemoReservation=%s isDeliveryQuestion=%s isOrderSentConfirmation=%s isHowToOrderQuestion=%s',
    text, isNewOrderNotification(normalized), isDemoReservation(normalized), isDeliveryQuestion(normalized), isOrderSentConfirmation(normalized), isHowToOrderQuestion(normalized));

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
  let isViableDirectQuery = Boolean(directMedicineQuery && directMedicineQuery.trim().length >= 5 && !isSelectionPhrase(normalized));
  if (isViableDirectQuery) {
    const dqTokens = tokenize(directMedicineQuery).filter(t => t.length > 1);
    if (dqTokens.length < 2) isViableDirectQuery = false;
    // Also reject if all tokens are weak/meaningless
    if (isViableDirectQuery && dqTokens.every(t => WEAK_QUERY_TOKENS.has(t))) isViableDirectQuery = false;
  }

  if ((isMedicineConsultationPhrase(normalized) && !isSelectionPhrase(normalized)) || isViableDirectQuery) {
    clearSelectionState(session);
    // Pass strictConsultationQuery as preExtractedMedicines so it lands in candidateMedicines
    // and avoids the multi-medicine block that uses strictConsultationMode threshold (0.80)
    const preExtRaw = (strictConsultationQuery && strictConsultationQuery.length > 1) ? [strictConsultationQuery] : [];
    // Filter out generic selection tokens (caja, opcion, unidad, etc.) before they become preExtractedMedicines
    const preExt = preExtRaw.filter(item => {
      const n = normalizeText(item);
      return n.length >= 3 && !/^(?:caja[se]?|opcion(?:es)?|unidad(?:es)?)$/i.test(n) && !/^\d+$/.test(n);
    });
    const catalogResult = await searchAndBuildCatalogResponse(strictConsultationQuery || directMedicineQuery || text, session, { hasOcrText, strictConsultationMode: true, recipeMode: true, preExtractedMedicines: preExt }, { phone, pushName });
    if (catalogResult !== null) return catalogResult;
  }

  if (/^(listo|resumen)\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  // ── CITY EARLY DETECTION ─────────────────────────────────────────────────
  // Detect city responses BEFORE the greeting block so that "Ciudad Bolivar"
  // never falls through to buildMenuMessage when userCity is not yet set.
  if (!session.userCity || session.userCity === 'null' || session.userCity === 'undefined') {
    const cityInfo = detectCityFromText(text);
    if (cityInfo) {
      session.userCity = cityInfo.city;
      session.userCoords = cityInfo.coords;
      touchSession(session);
      console.log(`[CITY] Detected='${cityInfo.city}' — userCity set from early detection`);
      if (session.pendingCityRetry) {
        const pending = session.pendingCityRetry;
        session.pendingCityRetry = null;
        return await routeMessage(phone, pending.text, session, pending.context);
      }
      return `✅ Ciudad configurada: *${cityInfo.city}*. Ahora busca el medicamento que necesitas.`;
    }
  }

  // Early exit para declaraciones de interés en medicamentos — siempre muestra bienvenida
  if (isMedicineInterestStatement(normalized)) {
    clearSelectionState(session);
    return buildMenuMessage();
  }

  if (isGreetingOrMenu(normalized) && !isMedicineSignal) {
    console.log('🧪 [GREETING] pre-check isGreetingOrMenu=%s isMedicineSignal=%s userCity="%s"', isGreetingOrMenu(normalized), !isMedicineSignal, session.userCity);
    // Check if user is sending a city name even though it looks like a greeting.
    // This must run BEFORE buildMenuMessage to prevent "Ciudad Bolivar" from
    // being swallowed by the greeting block.
    // NOTE: also treat session.userCity === 'null' (string) as unset.
    if (!session.userCity || session.userCity === 'null' || session.userCity === 'undefined') {
      const cityInfo = detectCityFromText(text);
      if (cityInfo) {
        session.userCity = cityInfo.city;
        session.userCoords = cityInfo.coords;
        touchSession(session);
        console.log(`[CITY] Detected='${cityInfo.city}' from greeting block`);
        if (session.pendingCityRetry) {
          const pending = session.pendingCityRetry;
          session.pendingCityRetry = null;
          return await routeMessage(phone, pending.text, session, pending.context);
        }
        return `✅ Ciudad configurada: *${cityInfo.city}*. Ahora busca el medicamento que necesitas.`;
      }
    } else {
      console.log('🧪 [CITY-SKIP] userCity already set="%s" — city detection skipped', session.userCity);
    }
    console.log('🧪 [GREETING] matched isGreetingOrMenu=true isMedicineSignal=false text="%s"', text);
    clearSelectionState(session);
    if (session.mode === 'awaiting_product_name') {
      return buildMenuMessage();
    }
    if (/^hola\b|^buenas\b|^ey\b|^alo\b/i.test(normalized)) {
      const resp = buildMenuMessage();
      console.log('🧪 [GREETING] returning menu message, session.userCity=%s', session.userCity);
      return resp;
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
  // Also restore from catalogHistory snapshot when pendingSelectionResults is empty
  const effectiveSelectionResults = resolveSelectionResults(session);
  const hasSelectionResults = Array.isArray(effectiveSelectionResults) && effectiveSelectionResults.length > 0;
  const selectionCandidate = parseSelectionCommand(normalized);
  const isSelectionMessage = Boolean(selectionCandidate) || isSelectionPhrase(normalized);
  const hasMedicineSearchSignal = Boolean(isMedicineSignal && !isSelectionMessage);

  // When a new OCR image arrives, ALWAYS process it as OCR — even if the previous
  // message left pendingSelectionResults. The user is asking about a NEW image.
  // IMPORTANT: Clear hasOcrText from session context FIRST so that if the OCR block
  // returns early (prescription found), subsequent text messages from the same user
  // DON'T re-enter this block with stale rawOcr (e.g. "Ciudad Bolívar" being
  // searched as if it were a medicine name with empty preExtractedMedicines).
  if (context && context.hasOcrText) {
    context.hasOcrText = false;
  }
  if (hasOcrText) {
    clearSelectionState(session);
    // Try prescription format first (has RP: section with multiple drugs).
    // Then medicine box format (single drug, packaging noise).
    // Then generic recipe cleanup as last resort.
    const rawOcr = recipeSourceText || text;
    console.log('🧾 OCR medicines extraction rawOcr SOURCE:', {
      recipeSourceTextTruthy: Boolean(recipeSourceText),
      recipeSourceText: recipeSourceText?.slice(0, 100),
      text: text?.slice(0, 300),
      fullText: text
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
    // Guard: if raw OCR is purely dosage (e.g. "120 MG") without any drug name, reject it
    const PURE_DOSAGE_RE = /^\s*\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|mL|ui|iu|tabletas?|capsulas?|ampollas?|comprimidos?|pastillas?)?\s*$/i;
    const rawIsPureDosage = PURE_DOSAGE_RE.test(rawOcr?.trim() || '');
    if (rawIsPureDosage && !allRecipeMedicines) {
      console.log('🧾 OCR rejected as pure dosage-only: "%s"', rawOcr);
      return '🤖 Solo pude leer la dosis de la imagen (ej. "120 mg"), pero no el nombre del medicamento. ¿Podrías escribir el nombre del producto que buscas?';
    }
    const searchQuery = allRecipeMedicines || rawOcr;
    console.log('🧾 OCR medicines extraction:', {
      hasOcrText,
      raw: rawOcr?.slice(0, 200),
      prescriptionClean,
      boxClean,
      recipeClean,
      allRecipeMedicines,
      rawIsPureDosage,
      searchQuery
    });
    const allRecipeMedicinesList = typeof extractRecipeMedicineLines === 'function' ? extractRecipeMedicineLines(allRecipeMedicines || rawOcr) : [];
    // Store recipe medicines in session so the signal block can use them
    // without re-extracting from the follow-up text message (e.g. "Ciudad Bolívar").
    if (allRecipeMedicinesList.length > 0) {
      session.pendingRecipeMedicines = allRecipeMedicinesList;
    }
    const catalogResult_ocr = await searchAndBuildCatalogResponse(searchQuery, session, { hasOcrText: true, ocrOnly: true, recipeMode: true, preExtractedMedicines: allRecipeMedicinesList }, { phone, pushName });
    if (catalogResult_ocr !== null) return catalogResult_ocr;
  }

  // If we have pending recipe medicines from an OCR prescription, use them directly
  // instead of calling searchAndBuildCatalogResponse which would re-extract from
  // the follow-up text (e.g. "Ciudad Bolívar" would produce empty/wrong candidates).
  if (hasMedicineSearchSignal && (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global')) {
    if (Array.isArray(session.pendingRecipeMedicines) && session.pendingRecipeMedicines.length > 0) {
      console.log('🧪 [OCR-REUSE] Using stored pendingRecipeMedicines=%s instead of re-extracting from text="%s"',
        JSON.stringify(session.pendingRecipeMedicines), text);
      const catalogResult = await searchAndBuildCatalogResponse(text, session, {
        hasOcrText: false,
        recipeMode: true,
        preExtractedMedicines: session.pendingRecipeMedicines
      }, { phone, pushName });
      // Clear pending medicines after use
      delete session.pendingRecipeMedicines;
      if (catalogResult !== null) return catalogResult;
    } else {
      clearSelectionState(session);
      const catalogResult = await searchAndBuildCatalogResponse(recipeSourceText || text, session, { hasOcrText }, { phone, pushName });
      if (catalogResult !== null) return catalogResult;
    }
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
      const catalogResult_nmq = await searchAndBuildCatalogResponse(text, session, { hasOcrText, strictConsultationMode: true, preExtractedMedicines: extractedMedicineRequests }, { phone, pushName });
      if (catalogResult_nmq !== null) return catalogResult_nmq;
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
    let results = resolveSelectionResults(session);
    if (selectionCandidate) {
      // Si results está vacío, intentar restaurar del último snapshot del catálogo
      if (!results || !results.length) {
        const snapshot = getLatestCatalogSnapshot(session);
        if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length > 0) {
          results = snapshot.options;
          session.pendingSelectionResults = results;
          session.mode = 'awaiting_choice';
          touchSession(session);
        }
      }
      const selected = results ? results[selectionCandidate.option - 1] : null;
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

  // Guard: selection phrases take priority — never route to medicine search if user is selecting
  const isExplicitSelection = isSelectionPhrase(normalized);
  const medicineSearchIntent = Boolean(
    (!isExplicitSelection && directMedicineQuery) ||
    (!isExplicitSelection && medicineRequests.length > 0) ||
    (!isExplicitSelection && /\b(?:\d+(?:\.\d+)?\s*(?:mg|mcg|g|gr|ml|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina|dosis|presentacion|presentación))\b/i.test(normalized)) ||
    (!isExplicitSelection && /\b(tienes?|tiene|hay|busco|busca|quiero|necesito|precio|costo|disponible|disponibilidad|medicamento|medicamentos|producto|productos)\b/.test(normalized))
  );

  if (medicineSearchIntent && !isGreetingOrMenu(normalized)) {
    if (session.mode === 'awaiting_choice' || session.mode === 'awaiting_choice_global' || session.mode === 'awaiting_product_name') {
      clearSelectionState(session);
    }
    const catalogResult_mse = await searchAndBuildCatalogResponse(text, session, { hasOcrText, strictConsultationMode: Boolean(isMedicineConsultationPhrase(normalized)) }, { phone, pushName });
    if (catalogResult_mse !== null) return catalogResult_mse;
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
    // ULTRA-GUARD: reject pure selection phrases BEFORE they enter searchAndBuildCatalogResponse.
    // "caja"/"opcion" are extracted as medicineRequests even though they're selection tokens,
    // causing false catalog searches. This guard short-circuits that path.
    const isPureSelection = isSelectionPhrase(normalized) && !medicineRequests.some(m => looksLikeMedicineName(m));
    if (medicineRequests.length > 0 || isProductSearchRequest(normalized)) {
      // Only clear and search if it's NOT a pure selection phrase
      if (!isPureSelection) {
        clearSelectionState(session);
        const catalogResult_awc = await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
        if (catalogResult_awc !== null) return catalogResult_awc;
      }
    }

    // Multi-medicine query: skip selection parsing — dosage numbers like 75/50/30/10
    // are NOT option numbers; fall through to the multi-medicine pipeline below.
    if (medicineRequests.length >= 2) {
      // fall through to multi-medicine pipeline (line ~2294)
    } else {

    const parsed = parseSelectionCommand(normalized);
    if (parsed) {
      // Use resolveSelectionResults which checks session.pendingSelectionResults FIRST,
      // then falls back to globalCatalogByPhone via getLatestCatalogSnapshot.
      let results = resolveSelectionResults(session);
      // Also support pure numeric selection ("1", "2") even when pendingSelectionResults
      // was not populated — restore from global catalog if needed.
      if (!results.length) {
        const snapshot = getLatestCatalogSnapshot(session);
        if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length > 0) {
          results = snapshot.options;
          session.pendingSelectionResults = results;
          session.mode = 'awaiting_choice_global';
          touchSession(session);
        }
      }
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
    } // end else (skip parseSelectionCommand for multi-medicine)
  }

  if (session.mode === 'awaiting_choice_global') {
    const medicineRequests = extractMedicineRequests(text);
    const isPureSelection = isSelectionPhrase(normalized) && !medicineRequests.some(m => looksLikeMedicineName(m));
    if (medicineRequests.length > 0 || isProductSearchRequest(normalized)) {
      if (!isPureSelection) {
        clearSelectionState(session);
        const catalogResult_awcg = await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
        if (catalogResult_awcg !== null) return catalogResult_awcg;
      }
    }

    const parsed = parseSelectionCommand(normalized);
    if (parsed) {
      let results = session.pendingSelectionResults || [];
      // Si pendingSelectionResults está vacío, intentar restaurar del último snapshot del catálogo
      if (!results.length) {
        const snapshot = getLatestCatalogSnapshot(session);
        if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length > 0) {
          results = snapshot.options;
          session.pendingSelectionResults = results;
          session.mode = 'awaiting_choice_global';
          touchSession(session);
        }
      }
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
    // Si hay un selectionCandidate válido, intentar restaurar del snapshot antes de buscar como medicine
    const parsed = parseSelectionCommand(normalized);
    if (parsed && isSelectionPhrase(normalized)) {
      const snapshot = getLatestCatalogSnapshot(session);
      if (snapshot && Array.isArray(snapshot.options) && snapshot.options.length > 0) {
        session.pendingSelectionResults = snapshot.options;
        session.mode = 'awaiting_choice_global';
        touchSession(session);
        // Re-route al bloque awaiting_choice_global
        const selected = snapshot.options[parsed.option - 1];
        if (!selected) {
          return `⚠️ La opción global *${parsed.option}* no está disponible. Escribe *LISTO* o busca otro medicamento.`;
        }
        addItemToCart(session, selected, parsed.quantity);
        touchSession(session);
        clearSelectionState(session);
        return formatSelectionSavedMessage(selected, parsed.quantity, session);
      }
    }
    const catalogResult_awcgelse = await searchAndBuildCatalogResponse(text, session, {}, { phone, pushName });
    if (catalogResult_awcgelse !== null) return catalogResult_awcgelse;
  }

  const multiMedicineRequests = await extractMedicinesWithLLMFallback(text, session);
  if (multiMedicineRequests.length > 1) {
    const catalogResult_multi = await searchAndBuildCatalogResponse(text, session, { preExtractedMedicines: multiMedicineRequests }, { phone, pushName });
    if (catalogResult_multi !== null) return catalogResult_multi;
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

// ══════════════════════════════════════════════════════════════════════════════
// RESPONSE VALIDATOR — Hybrid (Heurísticas + LLM ultra-liviano)
// Costo: heurísticas = 0 tokens; LLM solo en casos dudosos (~100 tokens/prompt)
// ══════════════════════════════════════════════════════════════════════════════

// ── STEP 1: HEURÍSTICAS (cero costo) ────────────────────────────────────────

// Mensajes fijos que el bot NUNCA debe rechazar (respuestas know-to-be-good)
const KNOWN_GOOD_PREFIXES = [
  '👤 *Atención de Gentefarma*',
  '🏥 *GENTEFARMA*',
  '✅ *Agregado a tu selección*',
  '✅ Ciudad configurada',
  '⚠️ No encontré',
  '⚠️ La opción',
  '⚠️ Primero debes ver',
  '🧾 Tu carrito actual',
  'En breve, uno de nuestros',
  'Uno de nuestros colaboradores',
  'Realizamos deliveries',
  'Gracias por su interés',
  'Con gusto',
  'Lo siento, no tengo información',
  'No tengo información',
  'Estoy aquí para ayudarte',
  'Escribe el número',
  'Escribe *LISTO*',
  'Escribe LISTO',
  'escríbeme el nombre',
];

// Patrones que indican respuesta obviously mala
const RESPONSE_RED_FLAGS = [
  // Caracteres rotos / encoding issues
  { pattern: /[�]/,                           reason: 'caracteres rotos (�)' },
  { pattern: /\\u00e2\\u20ac\\u201c/,           reason: 'encoding roto (�)' },
  { pattern: /\\u00e2\\u20ac\\u201d/,           reason: 'encoding roto (citaciones)' },
  // Precious / scam language
  { pattern: /\b(100%\s*(?:efectiv|garantiz|cur|precio\s+magico|remedio\s+milagroso|cur[oa]\s+garantiz))/i, reason: 'lenguaje guaristine / scam' },
  { pattern: /\b(precio\s+magico|remedio\s+milagroso|cur[oa]\s+garantiz)/i, reason: 'lenguaje guaristine' },
  // Hallucinated medical claims
  { pattern: /\b(Efectividad\s+100%|Este\s+medicamento\s+cur[oa]|Garantizo\s+que\s+funciona)/i, reason: 'afirmaciones médicas inventadas' },
  // Massive price hallucinations (bs > 50M por un comprimido)
  { pattern: /Bs\s+[\d.]{7,}\b/,               reason: 'precio absurdo en Bs' },
  // Response is absurdly short for a catalog (less than 3 lines)
  { pattern: /^[^\\n]*$/,                       reason: 'respuesta de una sola linea' },
];

// Cantidad maxima de "💊" en una respuesta de catalogo normal
const MAX_MEDICINE_ITEMS = 20;

// Numero maximo de lineas en una respuesta de catalogo normal
const MAX_CATALOG_LINES = 80;

function heuristicCheck(response, originalQuery) {
  const text = response || '';

  // 1. Si es una respuesta fija conocida → APPROVE
  for (const prefix of KNOWN_GOOD_PREFIXES) {
    if (text.startsWith(prefix)) {
      return { ok: true, reason: 'known-good prefix' };
    }
  }

  // 2. Buscar red flags
  for (const { pattern, reason } of RESPONSE_RED_FLAGS) {
    if (pattern.test(text)) {
      console.log(`🚨 [VALIDATOR-HEURISTIC] REJECT reason="${reason}" pattern=${pattern.toString()}`);
      return { ok: false, reason: `red_flag: ${reason}` };
    }
  }

  // 3. Si la respuesta tiene medicines (💊) pero el query original NO era de medicines
  // y la respuesta tiene más de 5 💊 → sospecha de hallucination
  // EXCEPCIÓN: modo receta (OCR de receta médica) puede tener muchos medicines legítimos
  const originalQ = originalQuery || '';
  const isRecipeMode = /\b(rx|rp|receta|paciente|belen|arcia|esoz|leprit|bumetin|evigax|moderan|milax|daflon|bargonil)\b/i.test(originalQ);
  const medicineEmojiCount = (text.match(/💊/g) || []).length;
  const queryHasMedicine = /\\\b(para que sirve|para qué sirve|cómo se usa|cual es|cuál es|indicacion|indicación)\\\b/i.test(originalQ);
  console.log('🧪 [HEURISTIC-DBG] isRecipeMode=%s medicineEmojiCount=%d queryHasMedicine=%s query="%s" rawHex=%s',
    isRecipeMode, medicineEmojiCount, queryHasMedicine, originalQ, Buffer.from(originalQ).toString('hex'));
  if (!queryHasMedicine && medicineEmojiCount > 8 && !isRecipeMode) {
    console.log(`🚨 [VALIDATOR-HEURISTIC] SUSPECT reason="exceso de medicines sin relación al query"`);
    return { ok: false, reason: 'exceso medicines sin relación' };
  }

  // 4. Si la respuesta tiene笔钱 emojis o symbols sospechosos
  const suspiciousSymbols = (text.match(/[№§®™©¤¦¢¥₱₲₡₢₣₤₥₦₧₨₩₪₫₭₮₯₰₱₲]/g) || []).length;
  if (suspiciousSymbols > 3) {
    return { ok: false, reason: 'simbolos monetarios sospechosos' };
  }

  // 5. Si la respuesta excede Max lines para catalogo → WARNING (no reject)
  const lines = text.split('\\n').filter(l => l.trim());
  if (lines.length > MAX_CATALOG_LINES * 2) {
    console.log(`🚨 [VALIDATOR-HEURISTIC] SUSPECT reason="respuesta excessively larga (${lines.length} lines)"`);
    return { ok: false, reason: 'respuesta demasiado larga' };
  }

  return { ok: true, reason: 'passed_heuristics' };
}

// ── STEP 2: LLM ULTRA-LIGHT (solo en casos dudosos) ─────────────────────────

const OPENAI_LLM_REASONING_MODEL = 'gpt-4o-mini';

// Prompt minimalista: ~100 tokens
const LLM_VALIDATION_PROMPT = `Eres un revisor de calidad de un bot de farmacia. Evalúa si la respuesta es COHERENTE para la consulta del usuario.

Reglas:
1. La respuesta debe mencionar medicamentos RELEVANTES a la consulta
2. NO debe inventar medicamentos, precios o información médica
3. El tono debe ser profesional y apropiado
4. Los precios deben ser razonables (no millones de Bs por un comprimido)

Responde SOLO con una palabra:
- "OK" si la respuesta es coherente y puede enviarse
- "REVISAR" si hay problemas de relevancia, alucinaciones, tono inapropiado o precios absurdos

CONSULTA: "{query}"
RESPUESTA: "{response}"
EVALUACIÓN:`;

async function llmValidate(response, query) {
  const text = response || '';
  // No enviar más de 500 chars al LLM (costo y velocidad)
  const truncatedResponse = text.length > 500 ? text.slice(0, 500) + '...[truncado]' : text;
  const truncatedQuery = (query || '').slice(0, 100);

  const prompt = LLM_VALIDATION_PROMPT
    .replace('{query}', truncatedQuery.replace(/"/g, '\\"'))
    .replace('{response}', truncatedResponse.replace(/"/g, '\\"'));

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_SECONDARY || ''}`,
      },
      body: JSON.stringify({
        model: OPENAI_LLM_REASONING_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      console.log(`🚨 [VALIDATOR-LLM] HTTP error ${res.status} — allowing response (fail-open)`);
      return { ok: true, reason: 'llm_error_fail_open' };
    }

    const data = await res.json();
    const reply = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();

    if (reply === 'OK') {
      console.log(`✅ [VALIDATOR-LLM] APPROVE`);
      return { ok: true, reason: 'llm_approved' };
    } else if (reply === 'REVISAR') {
      console.log(`🚨 [VALIDATOR-LLM] REJECT`);
      return { ok: false, reason: 'llm_rejected' };
    } else {
      console.log(`⚠️ [VALIDATOR-LLM] unexpected reply="${reply}" — allowing (fail-open)`);
      return { ok: true, reason: 'llm_unexpected_fail_open' };
    }
  } catch (err) {
    console.log(`🚨 [VALIDATOR-LLM] exception="${err.message}" — allowing response (fail-open)`);
    return { ok: true, reason: 'llm_exception_fail_open' };
  }
}

// ── MAIN WRAPPER ──────────────────────────────────────────────────────────────

// Solo validamos respuestas de catálogo (las que pueden tener medicines 💊)
function isCatalogResponse(response) {
  return Boolean(response && response.includes('💊'));
}

// Validación completa híbrida: heurísticas → (opcional LLM si dudoso)
// Retorna { ok, reason, useFallback, fallbackMessage }
async function validateResponseHybrid(response, originalQuery, session) {
  const CHECK_LLM = process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY_SECONDARY;

  // FAST PATH: heurísticas primero (costo 0, ~1ms)
  const h = heuristicCheck(response, originalQuery);
  console.log(`🚨 [VALIDATOR] heuristic ok=%s reason="%s"`, h.ok, h.reason);

  if (h.ok) {
    // Heurísticas aprobaron → APPROVE sin LLM
    return { ok: true, useFallback: false };
  }

  // Heurísticas rechazaron → intentar LLM solo si hay API key
  if (!CHECK_LLM) {
    console.log(`🚨 [VALIDATOR] no LLM key, using fallback (heuristic reject)`);
    return {
      ok: false,
      useFallback: true,
      fallbackMessage: '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.',
    };
  }

  // LLM como segunda opinión
  if (isCatalogResponse(response)) {
    console.log(`🚨 [VALIDATOR] running LLM check on catalog response...`);
    const llm = await llmValidate(response, originalQuery);
    if (llm.ok) {
      return { ok: true, useFallback: false };
    }
  }

  // Rechazado por heurísticas + (LLM si hubo)
  return {
    ok: false,
    useFallback: true,
    fallbackMessage: '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.',
  };
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

  if (result.geoNoResults) {
    lines.push('⚠️ No hay farmacias a menos de 5 km de tu zona.');
    lines.push('Escribe *LISTO* o busca otro medicamento.');
    return lines.join('\n').trim();
  }

  (result.matches || []).forEach((item, index) => {
    const title = shortenText(item.title || 'Medicamento', 52);
    const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    lines.push(`💊 *${index + 1}. ${title}*`);
    // Show pharmacy name and distance if geolocation data available
    if (item.providerName) {
      const distText = item.distancia != null ? ` — a ${item.distancia} km` : '';
      lines.push(`   🏥 ${item.providerName}${distText}`);
    }
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
  return '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.';
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
  // Anti-nuisance: exclude prescription-like text (has RP: or PACIENTE: or numbered medicine list)
  // These trigger when the user sends a recipe/prescription image, not a real order notification.
  if (/\b(rx|rp|receta)\b/i.test(text) && /paciente|belen|arcia/i.test(text)) {
    return false;
  }
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
  // ubic prefix must be checked separately: \bubic\b fails for "ubicada"/"ubicacion"
  // because after 'c' comes 'a'/'i' (word char) — no word boundary.
  // Full-word alternatives keep trailing \b; ubic is matched as bare substring.
  return /\b(donde estan ubicados|donde estan|ubicacion|ubicación|ubicados|direccion|dirección|local fisico|local físico|tienen local|donde queda|dónde queda)\b|ubic/.test(text);
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
// ── Geolocation helpers ────────────────────────────────────────────────

async function fetchProviders() {
  if (providersCache.length > 0) return providersCache;
  if (!db) return [];
  try {
    const snapshot = await db.collection('providers').get();
    providersCache = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        providerId: data.providerId || doc.id,
        name: data.name || 'Farmacia sin nombre',
        ciudad: data.ciudad || '',
        location: data.location, // Firestore GeoPoint → { latitude, longitude }
        address: data.address || '',
        phone: data.phone || '',
        hours: data.hours || '',
      };
    });
    console.log(`[PROVIDERS] Loaded ${providersCache.length} providers into cache`);
    return providersCache;
  } catch (err) {
    console.error('❌ [PROVIDERS] Error fetching providers:', err.message);
    return [];
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectCityFromText(text) {
  const normalized = normalizeText(text).toLowerCase();
  for (const [cityName, coords] of Object.entries(CITY_COORDS)) {
    if (normalized.includes(cityName.toLowerCase())) {
      return { city: cityName, coords };
    }
  }
  return null;
}

function getProviderById(providerId, providersList) {
  return providersList.find(p => p.providerId === String(providerId)) || null;
}

function enrichMatchWithProvider(item, userCoords, providersList) {
  if (!userCoords || !item?.doc?.ProviderId) return item;
  const provider = getProviderById(item.doc.ProviderId, providersList);
  if (!provider?.location) return item;
  const { latitude, longitude } = provider.location;
  if (latitude == null || longitude == null) return item;
  const distancia = haversineDistance(userCoords.lat, userCoords.lng, latitude, longitude);
  return { ...item, provider, distancia };
}

async function searchAndBuildCatalogResponse(text, session, options = {}, userInfo = {}) {
  // Log only when text looks TRUNCATED (possible chunking bug)
  // DISABLED after root cause found in extractStrictConsultationMedicineQuery
  if (!db) {
    return '⚠️ No tengo conexión al catálogo en este momento. Intenta de nuevo más tarde.';
  }

  // ULTRA-GUARD: si el texto es puramente una frase de selección y candidateMedicines
  // estaría vacío, retornar null para que routeMessage use la lógica de selección.
  // Esto cubre el caso en que tanto isViableDirectQuery como medicineSearchIntent
  // fueronfalse por algún motivo pero el texto aún llegó aquí.
  // FIX: si se detectaron medicinas (reqMeds.length > 0), continuar con la búsqueda
  // aunque isSelectionPhrase sea true — el texto es una consulta de medicamentos,
  // no una selección, y parseSelectionCommand podría estar capturando números de dosis.
  if (!options.ocrOnly && !options.strictConsultationMode) {
    const normalized = normalizeText(text);
    if (isSelectionPhrase(normalized)) {
      const preExt = Array.isArray(options.preExtractedMedicines) ? options.preExtractedMedicines : [];
      const reqMeds = preExt.length > 0 ? preExt : extractMedicineRequests(text);
      if (reqMeds.length === 0) {
        console.log('🛡️ [SELECTION-GUARD] Selection phrase detected in searchAndBuildCatalogResponse but no candidates — returning null so routeMessage handles it');
        return null;
      }
      console.log('🛡️ [SELECTION-GUARD] isSelectionPhrase=true but reqMeds.length=%d — continuing with medicine search to avoid dosing-number false positive', reqMeds.length);
    }
  }

  const ocrOnly = Boolean(options.ocrOnly);
  const consultationMode = Boolean(options.strictConsultationMode);
  const forceExactConsultationToken = Boolean(options.forceExactConsultationToken);
  const preExtracted = Array.isArray(options.preExtractedMedicines) ? options.preExtractedMedicines : [];
  console.log('🧪 [SEARCH-IN] text="%s" preExtracted=%s preExtracted.length=%d', text.substring(0, 80), JSON.stringify(preExtracted), preExtracted.length);
  // Always extract medicine list - even for OCR, we want multi-medicine support.
  // ocrOnly only affects the matching/search behavior, not the extraction.
  // FIX: If preExtracted is a single-element array with a space-containing string
  // (i.e. a concatenated multi-medicine string from routeMessage), split it into
  // individual tokens so candidateMedicines gets one item per medicine, not one
  // item per concatenated blob.
  // FIX: Split and filter each token through looksLikeMedicineName so that
  // "acido ursodesoxicolico" → ["ursodesoxicolico"] (not ["acido","ursodesoxicolico"]).
  // Without this, "acido" passes the length>=3 filter but is not a real medicine,
  // and fires a spurious ACIDO search against Firebase that returns ACIDO FOLICO/etc.
  const DOSAGE_QUANTITY_REJECT = /^(?:mgr|mgrs|tabl|tab|tabs|tableta|tabletas|capsula|capsulas|capsule|capsules|cap|caps|susp|suspen|suspension|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|ampolla|ampollas|vial|retad(?:ar|or)?|retard(?:ar|ado|ada)?|mg|mcg|g|gr|ml|cc|ui|iu|x\d+)$/i;
  const normalizedPreExtracted = (preExtracted.length === 1 && typeof preExtracted[0] === 'string' && preExtracted[0].includes(' '))
    ? preExtracted[0].split(/\s+/).filter(t => t.length >= 3 && !DOSAGE_QUANTITY_REJECT.test(t) && looksLikeMedicineName(t))
    : preExtracted;
  const requestedMedicines = normalizedPreExtracted.length > 0 ? normalizedPreExtracted : extractMedicineRequests(text);
  const fallbackMedicines = extractMedicineRequestsFromSegments(text);
  // TEMP DIAGNOSTIC: log extraction steps
  console.log('🧪 [FEXOF-DIAG] text="%s" normalizedPreExtracted=%s requestedMedicines=%s fallbackMedicines=%s',
    String(text).slice(0, 60), JSON.stringify(normalizedPreExtracted), JSON.stringify(requestedMedicines), JSON.stringify(fallbackMedicines));
  const recipeLineMedicines = typeof extractRecipeMedicineLines === 'function' ? extractRecipeMedicineLines(text) : [];
  const recipeMode = ocrOnly || Boolean(options.recipeMode) || /\b(receta|rx|rp)\b/i.test(normalizeText(text)) || /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(normalizeText(text));
  // Known pharmaceutical dosage forms — never search for these as standalone medicines.
  // They appear in concatenated input like "EVIGAX CAP" or "MILAX POLVO" and should
  // be merged with their preceding medicine name, not searched independently.
  const DOSAGE_FORMS = new Set([
    'cap','caps','capsula','capsulas','capsulasblandas','capsule','capsules',
    'susp','suspen','suspension','solucion','sol',
    'crema','cremas','gel','pomada','ungüento','unguento','ung',
    'polvo','polvos','polv',
    'jarabe','jar',
    'gotas','gota',
    'ampolla','ampollas','amp',
    'sobre','sobres','sb',
    'inhalador','aerosol','patch','parches','parche',
    'ovulo','ovulos','ov',
    'tableta','tabletas','tab','tabs',
    'inyectable','inyect',
  ]);
  // Flatten each recipe line so that multi-medicine OCR strings like
  // "ESOZ LEPRIT BUMETIN RETADAR EVIGAX CAP MODERAN SUSP" get split into
  // individual medicine names instead of extracting only the first token.
  const flattenedLines = [];
  for (const line of recipeLineMedicines) {
    const spaceTokens = String(line || '').split(/\s+/).filter((t) => t.length >= 3);
    if (spaceTokens.length > 1) {
      // Multi-token line: split and add each token as a separate line
      for (const token of spaceTokens) {
        if (!flattenedLines.includes(token)) flattenedLines.push(token);
      }
    } else {
      // Single-token line: keep as-is
      if (!flattenedLines.includes(line)) flattenedLines.push(line);
    }
  }

  // 🚨 DIAGNOSTIC: log flattenedLines to trace prescription OCR extraction
  console.log('🧪 [FLAT-LINES] recipeLineMedicines=%s flattenedLines=%s', JSON.stringify(recipeLineMedicines), JSON.stringify(flattenedLines));

  // LLM fallback: only activate when all three regex passes returned nothing
  const llmFallbackMeds = (requestedMedicines.length === 0 && fallbackMedicines.length === 0 && flattenedLines.length === 0)
    ? await extractMedicinesWithLLMFallback(text, session)
    : [];

  const candidateMedicinesRaw = dedupeStrings([
    ...requestedMedicines,
    ...fallbackMedicines,
    ...flattenedLines,
    ...llmFallbackMeds
  ]);

  // ── REJECT concatenated multi-medicine OCR fragments ───────────────────────
  // These are corrupted OCR merges of 2+ medicines that also appear as
  // standalone candidates in the same list. Check AFTER raw list is built
  // so we can reference the complete candidateMedicinesRaw array.
  console.log('🧪 [DEDUP] requestedMedicines=%s fallbackMedicines=%s flattenedLines=%s llmFallbackMeds=%s --> deduped=%s',
    JSON.stringify(requestedMedicines), JSON.stringify(fallbackMedicines), JSON.stringify(flattenedLines), JSON.stringify(llmFallbackMeds), JSON.stringify(candidateMedicinesRaw));
  const candidateMedicines = candidateMedicinesRaw.filter((item) => {
    const normalizedItem = normalizeText(item);
    const itemTokens = normalizedItem.split(/\s+/).filter(Boolean);
    if (itemTokens.length >= 7) return false;
    // For 4-6 token strings: detect if it's a corrupted OCR merge of 2+ distinct
    // medicines that are ALSO present as standalone candidates.
    if (itemTokens.length >= 4) {
      const otherCandidates = candidateMedicinesRaw.filter(c => {
        const cn = normalizeText(c);
        return cn.length >= 3 && cn !== normalizedItem && !DOSAGE_FORMS.has(cn);
      });
      let containedCount = 0;
      for (const other of otherCandidates) {
        const otherNormRaw = normalizeText(other);
        const otherNormBase = otherNormRaw
          .replace(/\s*\d+\s*(?:mg|mcg|g|gr|ml|mL|ui|iu)\b.*$/i, '')
          .replace(/\s*de\s+\d+\s*(?:mg|mcg|g|gr|ml|cc|ui|iu)\b.*$/i, '')
          .trim();
        if (itemTokens.includes(otherNormBase) || itemTokens.some(t => otherNormBase.startsWith(t + ' ') || t.startsWith(otherNormBase + ' '))) {
          containedCount++;
          if (containedCount >= 2) break;
        }
      }
      if (containedCount >= 2) {
        console.log('🧹 [CONCAT-REJECT] Rejected concatenated fragment: "%s" (matched %d other medicines)', item, containedCount);
        return false;
      }
    }
    return true;
  }).map((item) => recipeMode ? extractPrimaryRecipeMedicineQuery(item) : item).filter(Boolean);

  console.log('🧪 [CANDIDATE-MEDICINES] ocrOnly=%s preExtracted=%s requestedMedicines=%s fallbackMedicines=%s recipeLineMedicines=%s candidateMedicines=%s',
    ocrOnly, JSON.stringify(preExtracted), JSON.stringify(requestedMedicines), JSON.stringify(fallbackMedicines), JSON.stringify(recipeLineMedicines), JSON.stringify(candidateMedicines));

  // ── SMART SUBSET DEDUP ──────────────────────────────────────────────
  // Remove medicine fragments (shorter names that are subsets of longer ones)
  // while keeping valid medicine names. Uses root-based comparison (strips
  // dosage tokens) so "bumetin" gets removed when "bumetin retard" exists,
  // but "esoz" is kept even when "esoz 40 mg" also exists.
  const rawCandidates = [...candidateMedicines];
  const dedupedCandidates = dedupLLMMedicines(candidateMedicines);
  if (dedupedCandidates.length !== rawCandidates.length) {
    const removed = rawCandidates.filter(c => !dedupedCandidates.includes(c));
    console.log('🧹 [PREFIX-DEDUP] REMOVED=%s | RAW=%s | DEDUPED=%s',
      JSON.stringify(removed), JSON.stringify(rawCandidates), JSON.stringify(dedupedCandidates));
  } else {
    console.log('🧹 [PREFIX-DEDUP] No change — count=%d', dedupedCandidates.length);
  }

    if (dedupedCandidates.length > 1) {
    const exchangeRate = await getBcvRate();
    const products = await fetchCatalogProducts(2000);
    const groups = [];
    const missingMedicines = [];
    const missingMedicineSet = new Set();

    console.log('🧪 [MULTI-MEDICINE] dedupedCandidates=%s (count=%d)', JSON.stringify(dedupedCandidates), dedupedCandidates.length);
    // TEMP DIAGNOSTIC: log dedupedCandidates for fexofenadina case
    if (JSON.stringify(dedupedCandidates).includes('fexofenadina')) {
      console.log('🧪 [FEXOF-DEDUP] dedupedCandidates=%s rawCandidates=%s', JSON.stringify(dedupedCandidates), JSON.stringify(rawCandidates));
    }

    for (const medicineQuery of dedupedCandidates) {
      const result = await searchMedicinesByName(medicineQuery, {
        products,
        exchangeRate,
        strictListMode: !ocrOnly,
        recipeMode,
        strictConsultationMode: consultationMode,
        forceExactConsultationToken: consultationMode && !recipeMode,
        userCoords: session.userCoords,
      });
      console.log('🧪 [MEDICINE-RESULT] query="%s" matches=%d groupTitle="%s"',
        medicineQuery, result?.matches?.length || 0, result?.groupTitle || '');
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
    console.log('🧪 [MULTI-AFTER] groups.length=%d missingMedicines=%s', groups.length, JSON.stringify(missingMedicines));
    // Per-medicine result log so we can see exactly which searches succeed/fail
    console.log('🧪 [MULTI-LOOP-SUMMARY] totalCandidates=%d groups=%d missing=%d', dedupedCandidates.length, groups.length, missingMedicines.length);
    // Detailed group log: which groups were collected and their doc.id
    for (const g of groups) {
      const matchIds = (g.matches || []).map(m => m.doc?.id || 'NO-ID').join(',');
      console.log('🧪 [GROUP] groupTitle="%s" matches=%d doc.ids=[%s]', g.groupTitle || g.query || '?', g.matches?.length || 0, matchIds);
    }

    if (groups.length > 0 || missingMedicines.length > 0) {
      const flattenedOptions = flattenCatalogResults(groups);
      console.log('🧪 [FLATTEN] flattenedOptions.length=%d', flattenedOptions.length);
      for (const opt of flattenedOptions) {
        console.log('🧪 [FLAT-ITEM] title="%s" doc.id="%s" groupTitle="%s"', opt.title || '', opt.doc?.id || 'NO-ID', opt.groupTitle || '');
      }
      session.lastSearch = groups[0] || null;
      session.pendingSelectionResults = flattenedOptions.length ? flattenedOptions : null;
      session.mode = flattenedOptions.length ? 'awaiting_choice_global' : 'awaiting_product_name';
      // Only save a catalog snapshot when there are actual selectable options.
      // Saving when flattenedOptions is empty (all medicines unavailable) would persist
      // combined multi-medicine OCR strings as selectable options in future sessions.
      if (flattenedOptions.length > 0) {
        rememberCatalogSnapshot(session, flattenedOptions, dedupedCandidates.join(' • '), buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines));
      }
      touchSession(session);
      const logProducts1 = dedupedCandidates.length > 0 ? dedupedCandidates : flattenedOptions.map(o => o.productName || o.name || singleQuery);
      appendConsultationToSheet({ products: logProducts1, exists: 1, phone: userInfo.phone, userName: userInfo.pushName });
      return buildMultiCatalogResponse(groups, flattenedOptions, missingMedicines);
    }

    session.mode = 'awaiting_product_name';
    appendConsultationToSheet({ products: dedupedCandidates, exists: 0, phone: userInfo.phone, userName: userInfo.pushName });
    return buildNoMatchListMessage();
  }

  const singleQuery = dedupedCandidates[0] || extractMedicineQuery(text) || text.trim();
  console.log(`🧪 [SINGLE-QUERY] dedupedCandidates[0]='${dedupedCandidates[0]}' extractMedicineQuery='${extractMedicineQuery(text)}' singleQuery='${singleQuery}'`);
  // Extract dosage signatures from ORIGINAL text (before extractMedicineQuery strips them)
  const originalDosagePattern = /\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|gr|ml|cc|ui|iu)\b/gi;
  const originalNormalized = (text || '').toLowerCase();
  const queryDosageSignatures = [];
  let m;
  while ((m = originalDosagePattern.exec(originalNormalized))) {
    const amount = String(m[1]).replace(',', '.');
    const unit = String(m[2]).replace(/mL/i, 'ml').toLowerCase();
    queryDosageSignatures.push(`${amount}${unit}`);
  }
  originalDosagePattern.lastIndex = 0;
  if (queryDosageSignatures.length > 0) {
    console.log(`🧪 [ORIG-DOSAGE] text='${text}' dosageSignatures=${JSON.stringify(queryDosageSignatures)}`);
  }
  const result = await searchMedicinesByName(singleQuery, {
    products: await fetchCatalogProducts(2000),
    exchangeRate: await getBcvRate(),
    strictListMode: !ocrOnly,
    recipeMode,
    strictConsultationMode: consultationMode,
    forceExactConsultationToken: consultationMode && !recipeMode,
    queryDosageSignatures: queryDosageSignatures.length > 0 ? queryDosageSignatures : null,
    userCoords: session.userCoords,
  });

  // TEMP DIAGNOSTIC: log result matches to debug missing products
  console.log('🧪 [FEXOF-DIAG] singleQuery=%s result.matchesCount=%d result.matches[0].title=%s',
    singleQuery, result?.matches?.length || 0, result?.matches?.[0]?.title || 'N/A');

  if (!result || !result.matches.length) {
    session.mode = 'awaiting_product_name';
    appendConsultationToSheet({ products: [singleQuery], exists: 0, phone: userInfo.phone, userName: userInfo.pushName });
    return `⚠️ *${singleQuery.trim()}* no está disponible en este momento.\n\nIntenta con el nombre del medicamento o una presentación distinta. Si tienes una receta, enviala en foto y busco los medicamentos por ti.`;
  }

  session.lastSearch = result;
  session.pendingSelectionResults = result.matches;
  session.mode = 'idle';
  touchSession(session);
  rememberCatalogSnapshot(session, result.matches, result.query || singleQuery, buildSearchDiagnosticMessage(result, singleQuery));
  // Also store in global catalog (survives serverless session reloads)
  const phone = userInfo?.phone;
  if (phone && Array.isArray(result.matches) && result.matches.length > 0) {
    globalCatalogByPhone.set(phone, { options: result.matches, timestamp: Date.now() });
  }
  appendConsultationToSheet({ products: [singleQuery], exists: 1, phone: userInfo.phone, userName: userInfo.pushName });

  const responseText = buildSearchDiagnosticMessage(result, singleQuery);
  console.log(`🧪 [FINAL-RESPONSE] length=${responseText.length} firstLine="${responseText.split('\n')[0]}" matchesCount=${result.matches.length}`);
  return responseText;
}

async function searchMedicinesByName(userQuery, options = {}) {
  console.log(`🧪 [SEARCH-KICK] userQuery='${userQuery}' strictConsultationMode=${options.strictConsultationMode} preExtractedMedicines=${JSON.stringify(options.preExtractedMedicines)}`);
  if (!db) return null;

const userCoords = options.userCoords || null;
  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);

  const strictListMode = Boolean(options.strictListMode);
  const recipeMode = Boolean(options.recipeMode);
  // strictReferenceThreshold: for multi-token queries keep 0.93 to avoid noise.
  // For single-token medicine names (e.g. "bumetin", "leprit"), lower to 0.80
  // so "bumetin" can match "bumetin retard 300mg" (JW~0.80) without penalizing -500.
  const _singleTokenQuery = queryTokens.length === 1 && queryTokens[0].length >= 4;
  const strictReferenceThreshold = recipeMode ? 0.96 : (strictListMode ? (_singleTokenQuery ? 0.80 : 0.93) : 0.88);
  console.log(`🧪 [SEARCH-MAIN] query='${query}' queryTokens=${JSON.stringify(queryTokens)} consultationMode_opt=${options.strictConsultationMode}`);
  if (!queryTokens.length) return null;

  const consultationMode = Boolean(options.strictConsultationMode);
  // Dosage signatures passed from original text (before extractMedicineQuery strips them)
  const passedDosageSigs = options.queryDosageSignatures || [];
  const hasPassedDosage = passedDosageSigs.length > 0;
  if (hasPassedDosage) {
    console.log(`🧪 [PASSED-DOSAGE] query='${query}' passedDosageSigs=${JSON.stringify(passedDosageSigs)}`);
  }

  const exchangeRate = options.exchangeRate ?? await getBcvRate();
  const products = options.products ?? await fetchCatalogProducts(2000);
  const catalogHealth = summarizeCatalogHealth(products);
  // TEMP DIAGNOSTIC: check raw Firebase matches for missing recipe medicines
  const MISSING_RECIPE_MEDS = ['bumetin', 'leprit', 'daflon', 'esoz', 'evigax', 'moderan', 'milax', 'bargonil'];
  const isMissingRecipe = queryTokens.some(t => MISSING_RECIPE_MEDS.includes(t.toLowerCase()));
  if (isMissingRecipe) {
    console.log(`🧪 [FIREBASE-RECIPE-DBG] queryTokens=${JSON.stringify(queryTokens)} recipeMode=${recipeMode} strictRef=${strictReferenceThreshold}`);
  }
  if (queryTokens.includes('calaminol')) {
    const fbResult = await findProductByNormalizedName('calaminol');
    console.log(`🧪 [FIREBASE-CALAMINOL] productsMarket=${fbResult.productsMarket.length} providersProducts=${fbResult.providersProducts.length}`);
    fbResult.productsMarket.slice(0,10).forEach((p,i) => console.log(`🧪 [FIREBASE-PM] ${i} ProductTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray||[])}`));
    fbResult.providersProducts.slice(0,10).forEach((p,i) => console.log(`🧪 [FIREBASE-PP] ${i} ProductTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray||[])}`));
  }
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

  const isDosageToken = (token) => /^(\d+(?:[.,]\d+)?)$/.test(token) || /^(mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?)$/.test(token);
  // Note: "retard"|"retadar"|"retador"|"retardar"|"retardado"|"retardada" are dosage forms but
  // we check them separately with exact match to avoid "forte" matching "tard" inside it.
  const isRetardForm = (token) => /^(?:retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/.test(token);
  const focusTokens = matchTokens.filter((token) => !isDosageToken(token) && !isRetardForm(token));
  const primaryTokens = focusTokens.length ? focusTokens : matchTokens;
  const primaryRoot = primaryTokens.join(' ');

  // ── MODIFIER TOKENS ────────────────────────────────────────────────────────
  // When query has 2+ tokens, tokens after the first that are NOT dosages
  // act as mandatory filters: the product MUST contain them.
  // E.g. "atamel forte" → "forte" is a modifier; only ATAMEL FORTE products score.
  const rawTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  const isNumberOrDosage = (t) => /^(\d+(?:[.,]\d+)?)$/.test(t) || isDosageToken(t) || isRetardForm(t);
  const modifierTokens = rawTokens.slice(1).filter((t) => {
    if (isNumberOrDosage(t)) return false;
    return MODIFIER_TOKENS.has(t) || t.length <= 4;
  });
  if (modifierTokens.length > 0) {
    console.log(`🧪 [MODIFIER-TOKENS] query='${query}' modifierTokens=${JSON.stringify(modifierTokens)}`);
  }

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
  // Also detect standalone dosage numbers at the end of the query (e.g. "ATORVASTATINA 30",
  // "NIFEDIPINA 10") where no unit is written. These MUST be treated as dosage signals
  // so wrong-dose products (e.g. 40MG for a 30MG query) get properly penalised.
  const standaloneMatch = query.match(/\b(\d+(?:[.,]\d+)?)\s*$/);
  if (standaloneMatch) {
    const num = standaloneMatch[1];
    queryDosageSignatures.push(`sd:${num}`); // tag with prefix to distinguish from unit-based signatures
  }
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
    // DEBUG: confirm modifierTokens is accessible — only log when modifiers exist and product has 'atamel'
    // DISABLED after root cause found
    /* if (modifierTokens && modifierTokens.length > 0 && signal.productTitleFull.toLowerCase().includes('atamel')) {
      console.log(`🧪 [SCORE-SIGNAL] modifierTokens=${JSON.stringify(modifierTokens)} product='${signal.productTitleFull}' score=${score}`);
    } */

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
    else if (referenceSimilarity >= 0.70) score += strictListMode ? 40 : 60; // intermediate tier: good similarity but below threshold
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

    // ── MODIFIER PENALTY ───────────────────────────────────────────────────
    // If query has modifier tokens (e.g. "forte", "plus", "flex"), the product
    // MUST contain ALL of them. Missing any modifier → heavy penalty.
    // This ensures "atamel forte" only returns ATAMEL FORTE products, not all ATAMEL.
    if (modifierTokens && modifierTokens.length > 0) {
      const productAllText = [signal.productTitleFull, signal.titleArrayTextFull, signal.ingredient, signal.productText].filter(Boolean).join(' ').toLowerCase();
      const missingModifiers = modifierTokens.filter(mod => !productAllText.includes(mod.toLowerCase()));
      if (missingModifiers.length > 0) {
        score -= strictListMode ? 950 : 750;
        // console.log(`🧪 [MODIFIER-PENALTY] product='${signal.productTitleFull}' missingModifiers=${JSON.stringify(missingModifiers)} scorePenalty=-${strictListMode ? 950 : 750} newScore=${score}`);
      } else {
        // Bonus: product has all modifiers → reward for exact modifier match
        score += modifierTokens.length * 80;
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
    // DIAGNOSTIC: find all products whose tokenSet contains 'calaminol'
    .map((item, idx) => {
      // DIAGNOSTIC: track bumetin/leprit/esoz products through scoring pipeline
      const MEDS_TO_TRACK = ['bumetin', 'leprit', 'esoz'];
      const itemMed = MEDS_TO_TRACK.find(m => item.tokenSet && item.tokenSet.has(m));
      if (itemMed) {
        console.log(`[OCR-SCORE-DBG] ${itemMed} idx=${idx} score=${item.score} refSim=${item.referenceSimilarity} exactHit=${item.exactHit} fullFocusMatch=${item.fullFocusMatch} phraseHit=${item.phraseHit} title='${item.productTitleFull}' tokenSet=${JSON.stringify([...item.tokenSet].slice(0,15))}`);
      }
      if (item.tokenSet && (item.tokenSet.has('calaminol') || (item.productTitleFull && /calaminol/i.test(item.productTitleFull)))) {
        console.log(`[TOKEN-DIAG] idx=${idx} score=${item.score} productTitleFull='${item.productTitleFull}' tokenSetHasCalaminol=${item.tokenSet.has('calaminol')} arrayTokens=${JSON.stringify(item.arrayTokens || [])} titleTokens=${JSON.stringify(item.titleTokens || [])}`);
      }
      return item;
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

  // Skip consultationGate in recipeMode — extracted recipe medicine names may not be
  // exact substrings of the product title (e.g. "bumetin" vs "BUMETIN RETADAR 300 MG")
  if (consultationMode && primaryTokens.length > 0 && !recipeMode) {
    const q = primaryTokens[0];
    const beforeCount = scoredProducts.length;
    console.log(`[CONSULTATION-GATE] mode=${consultationMode} primaryTokens=${JSON.stringify(primaryTokens)} q='${q}' beforeCount=${beforeCount}`);
    // Log first 5 products before filter
    scoredProducts.slice(0, 5).forEach((item, i) => {
      console.log(`[CONSULTATION-GATE] BEFORE[${i}] title='${item.productTitleFull}' tokenSet=${JSON.stringify([...item.tokenSet].slice(0, 10))} ingredient='${item.ingredient}'`);
    });
    scoredProducts = scoredProducts.filter((item) => {
      // 1) Match exacto en tokenSet o title/ingredient (case-insensitive for substring checks)
      if (
        item.tokenSet.has(q)
        || item.productTitleFull === q || item.productTitleFull.startsWith(q + ' ') || item.productTitleFull.endsWith(' ' + q) || item.productTitleFull.toLowerCase().includes(' ' + q + ' ')
        || item.titleArrayTextFull === q || item.titleArrayTextFull.startsWith(q + ' ') || item.titleArrayTextFull.endsWith(' ' + q) || item.titleArrayTextFull.toLowerCase().includes(' ' + q + ' ')
        || item.ingredient === q || item.ingredient.startsWith(q + ' ') || item.ingredient.endsWith(' ' + q) || item.ingredient.toLowerCase().includes(' ' + q + ' ')
      ) return true;
      // 1a) Substring-in-token for brand-name tokens: when "FEXOFENADINA" query token is embedded
      // inside a brand token like "FEXORAT", the exact token check fails. Catch it here.
      // Only for q.length>=4 to avoid short-token false positives.
      if (q.length >= 4) {
        for (const t of item.tokenSet) {
          if (t.length >= 4 && t.includes(q)) return true;
        }
      }
      // 2) Fallback fuzzy: algún token del producto se parece ≥92% al query
      for (const t of item.tokenSet) {
        if (tokenSimilarity(q, t) >= 0.92) return true;
      }
      return false;
    });
    console.log(`[CONSULTATION] Filtering for '${q}': ${beforeCount} -> ${scoredProducts.length} products`);
    // Log after filter
    scoredProducts.forEach((item, i) => {
      console.log(`[CONSULTATION-GATE] AFTER[${i}] title='${item.productTitleFull}'`);
    });
    if (!scoredProducts.length) {
      console.log(`🧪 [CONSULTATION-EMPTY] scoredProducts is empty after filter! beforeCount=${beforeCount} scoredProducts.length=${scoredProducts.length}`);
      return { query, queryTokens, exchangeRate, matches: [] };
    } else {
      console.log(`🧪 [CONSULTATION-AFTER-FILTER] scoredProducts.length=${scoredProducts.length} proceeding to candidate matching`);
    }
  } else {
    console.log(`[CONSULTATION-GATE] SKIPPED: consultationMode=${consultationMode} primaryTokens.length=${primaryTokens.length}`);
  }

  // Salt-only query guard for OCR (consultation mode):
  // When the user sends an OCR image like "FEXOFENADINA CLORHIDRATO 120 MG", the LLM may
  // extract "CLORHIDRATO" as a separate query. Searching for "CLORHIDRATO" alone returns
  // dozens of unrelated products (METFORMINA CLORHIDRATO, BUPIVACAINA CLORHIDRATO, etc.)
  // which is clearly wrong. Salt forms (clorhidrato, sulfato, etc.) are NOT medicines
  // by themselves — they are the active ingredient's salt. In OCR mode, we search by the
  // commercial name, not the active ingredient. So "CLORHIDRATO" alone → skip.
  if (consultationMode && primaryTokens.length > 0) {
    const saltOnlyRe = /^(?:clorhidrato|cloruro|besilato|sulfato|fosfato|acetato|tartrato|malato|fumarato|succinato|bromuro|ioduro|nitrato|tiocianato)$/i;
    const dosageTokenRe = /^(?:\d+(?:[.,]\d+)?\s*(?:m\s*g|mcg|g|gr|m\s*l|mL|ui|iu|ml)|[xyz]\s*\d+|\d+%|m\s*g$|m\s*l$|mcg$|g$|gr$|ui$|iu$|\d+(?:[.,]\d+)?\s*(?:tab|cap|comp|sobres?|amp|vial|gotas?|ml|gr|mg|g)$)$/i;
    const rawQueryUpper = query.toUpperCase();
    const tokensAfterDosage = queryTokens.filter(t => !dosageTokenRe.test(t));
    const isPureSaltForm = tokensAfterDosage.length === 1 && saltOnlyRe.test(tokensAfterDosage[0]);
    if (isPureSaltForm) {
      console.log(`🧪 [SALT-FORM-GUARD] query="${query}" is pure salt form (no medicine name) — returning empty in OCR mode`);
      return { query, queryTokens, exchangeRate, matches: [] };
    }
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

    // DIAGNOSTIC: log top candidates for missing recipe medicines
    if (isMissingRecipe) {
      console.log(`🧪 [RECIPE-DIAG] queryTokens=${JSON.stringify(queryTokens)} strictRef=${strictReferenceThreshold} candidate count=${scoredProducts.length}`);
      scoredProducts.slice(0, 8).forEach((item, i) => {
        console.log(`🧪 [RECIPE-DIAG] TOP[${i}] score=${item.score} refSim=${(item.referenceSimilarity||0).toFixed(3)} fullFocus=${item.fullFocusMatch} exactHit=${item.exactHit} phraseHit=${item.phraseHit} title='${item.productTitleFull}' tokens=${JSON.stringify([...item.tokenSet].slice(0,6))}`);
      });
    }
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

      // For single-token queries (e.g. "leprit" matching "LEPRIT 25 MG"), an exact
      // token match is sufficient — don't require fullFocusMatch/exactHit on top.
      return exactTokenMatch || (
        item.fullFocusMatch || item.exactHit || item.phraseHit ||
        (item.referenceSimilarity ?? 0) >= strictReferenceThreshold
      );
    });

    candidateMatches = recipeMatches;
    if (hasQueryDosage) {
      candidateMatches = candidateMatches.filter((item) => {
        const candidateText = [item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText].filter(Boolean).join(' ');
        const candidateHasAmount = /\b\d+(?:[.,]\d+)?\b/.test(candidateText);
        const candidateHasUnit = /\b(mg|mcg|g|gr|ml|cc|ui|iu)\b/.test(candidateText);
        return candidateHasAmount && candidateHasUnit && item.dosageExactMatch;
      });
    }

    if (!candidateMatches.length) {
      console.log(`🧪 [CONSULTATION-DEGRADED] candidateMatches=0 after first filter, trying degraded fallback...`);
      const queryCore = normalizeText(dosageLessQuery || exactRoot || query);
      const alternativeTokens = tokenize(queryCore).filter((token) => !STOPWORDS.has(token) && token.length > 1);
      console.log(`🧪 [CONSULTATION-FALLBACK] queryCore='${queryCore}' altTokens=${JSON.stringify(alternativeTokens)} scoredProducts=${scoredProducts.length}`);
      const degradedMatches = scoredProducts.filter((item) => {
        const candidateCore = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
        if (!candidateCore) return false;

        // Require meaningful token overlap: at least one query token of length >=2 must match the candidate
        const meaningfulTokens = alternativeTokens.filter(t => t.length >= 2);
        const tokenOverlap = alternativeTokens.length === 0
          ? candidateCore.includes(queryCore)
          : meaningfulTokens.some((token) => {
              if (candidateCore.includes(token)) return true;
              return tokenize(candidateCore).some((candidateToken) => tokenSimilarity(token, candidateToken) >= 0.76);
            });

        const dosageMatches = !hasQueryDosage || item.dosageExactMatch;
        const dosageOverlap = !hasQueryDosage || candidateCore.includes(matchQuery) || candidateCore.includes(dosageLessQuery) || candidateCore.includes(exactRoot);
        // For consultationMode: strict threshold (0.76) — reject low-refSim matches like daflon↔sonda
        const softScore = (item.referenceSimilarity ?? 0) >= 0.76 || item.fullFocusMatch || item.exactHit || item.phraseHit;

        return tokenOverlap && (dosageOverlap || softScore) && dosageMatches;
      });
      console.log(`🧪 [CONSULTATION-FALLBACK-RESULT] degradedMatches.length=${degradedMatches.length} top=` + JSON.stringify(degradedMatches.slice(0,3).map(i=>({t:i.productTitleFull,s:i.score??0,rs:i.referenceSimilarity??0}))));

      // Reject degraded results with refSim < 0.76 — they are spurious for prescription scans
      const consultBestRefSim = degradedMatches.length > 0 ? (degradedMatches[0].referenceSimilarity ?? 0) : 0;
      if (degradedMatches.length && consultBestRefSim >= 0.76) {
        candidateMatches = degradedMatches;
      }
    }

    console.log(`🧪 [CONSULTATION-EXIT] candidateMatches.length=${candidateMatches.length} query='${query}'`);
  } else {
    // non-recipeMode path (consultation queries like "cotrimazol" land here)
    // reuse the same degraded fallback below
  }

  // ── Degraded fallback: applies to ALL paths (recipeMode AND non-recipeMode) ──
  if (!candidateMatches.length) {
    const queryCore = normalizeText(dosageLessQuery || exactRoot || query);
    const alternativeTokens = tokenize(queryCore).filter((token) => !STOPWORDS.has(token) && token.length > 1);
    console.log(`🧪 [DEGRADED-FALLBACK] queryCore='${queryCore}' altTokens=${JSON.stringify(alternativeTokens)} scoredProducts=${scoredProducts.length}`);
    // Log top-5 products by score for debugging
    scoredProducts.slice(0, 5).forEach((item, i) => {
      const candidateCore = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
      console.log(`[DEGRADED-TOP${i}] title='${item.productTitleFull}' score=${item.score ?? 'N/A'} refSim=${item.referenceSimilarity ?? 'N/A'} candCore='${candidateCore.slice(0, 60)}' tokenSetHasMederan=${item.tokenSet ? item.tokenSet.has('moderan') : 'N/A'}`);
    });
    // Targeted MODERAN diagnostic: find it in the full list and log its score/rank
    const moderanIdx = scoredProducts.findIndex((item) => item.tokenSet && item.tokenSet.has('moderan'));
    if (moderanIdx >= 0) {
      const moderanItem = scoredProducts[moderanIdx];
      const moderanCandidateCore = normalizeText([moderanItem.productTitleFull, moderanItem.titleArrayTextFull, moderanItem.ingredient, moderanItem.productText, moderanItem.title].filter(Boolean).join(' '));
      const moderanSoftScore = (moderanItem.score ?? 0) >= 40 || (moderanItem.referenceSimilarity ?? 0) >= 0.60 || moderanItem.fullFocusMatch || moderanItem.exactHit || moderanItem.phraseHit;
      const moderanDosageLessQuery = dosageLessQuery || exactRoot || query;
      const moderanDosageOverlap = !hasQueryDosage || moderanCandidateCore.includes(matchQuery) || moderanCandidateCore.includes(dosageLessQuery) || moderanCandidateCore.includes(exactRoot);
      const moderanTokenOverlap = alternativeTokens.length === 0
        ? moderanCandidateCore.includes(queryCore)
        : alternativeTokens.some((token) => {
            if (moderanCandidateCore.includes(token)) return true;
            return tokenize(moderanCandidateCore).some((ct) => tokenSimilarity(token, ct) >= 0.76);
          });
      console.log(`[DEGRADED-MODERAN] rank=${moderanIdx} score=${moderanItem.score} refSim=${moderanItem.referenceSimilarity} softScore=${moderanSoftScore} dosageOverlap=${moderanDosageOverlap} tokenOverlap=${moderanTokenOverlap} candCore='${moderanCandidateCore.slice(0, 80)}' pass=${moderanTokenOverlap && (moderanDosageOverlap || moderanSoftScore)}`);
    } else {
      console.log(`[DEGRADED-MODERAN] NOT FOUND in scoredProducts (checked tokenSet for 'moderan')`);
    }
    // Async diagnostic: query both collections for MODERAN by name
    findProductByNormalizedName('moderan').then((result) => {
      console.log(`[MODERAN-QUERY] productsMarket=${result.productsMarket.length} providersProducts=${result.providersProducts.length} error=${result.error || 'none'}`);
      if (result.productsMarket.length > 0) {
        result.productsMarket.forEach((p, i) => console.log(`[MODERAN-QUERY] PM[${i}] id=${p.id} ProductTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
      if (result.providersProducts.length > 0) {
        result.providersProducts.forEach((p, i) => console.log(`[MODERAN-QUERY] PP[${i}] id=${p.id} productTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
    });
    // Async diagnostic: query both collections for CALAMINOL by name
    findProductByNormalizedName('calaminol').then((result) => {
      console.log(`[CALAMINOL-QUERY] productsMarket=${result.productsMarket.length} providersProducts=${result.providersProducts.length} error=${result.error || 'none'}`);
      if (result.productsMarket.length > 0) {
        result.productsMarket.forEach((p, i) => console.log(`[CALAMINOL-QUERY] PM[${i}] id=${p.id} ProductTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
      if (result.providersProducts.length > 0) {
        result.providersProducts.forEach((p, i) => console.log(`[CALAMINOL-QUERY] PP[${i}] id=${p.id} productTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
    });
    // Targeted CALAMINOL diagnostic: find CALAMINOL-branded products in scoredProducts
    const calaminolIdx = scoredProducts.findIndex((item) => item.tokenSet && (
      item.tokenSet.has('calaminol') || (item.productTitleFull && /calaminol/i.test(item.productTitleFull))
    ));
    if (calaminolIdx >= 0) {
      const calaminolItem = scoredProducts[calaminolIdx];
      const calaminolCandidateCore = normalizeText([calaminolItem.productTitleFull, calaminolItem.titleArrayTextFull, calaminolItem.ingredient, calaminolItem.productText, calaminolItem.title].filter(Boolean).join(' '));
      const calaminolSoftScore = (calaminolItem.score ?? 0) >= 40 || (calaminolItem.referenceSimilarity ?? 0) >= 0.60 || calaminolItem.fullFocusMatch || calaminolItem.exactHit || calaminolItem.phraseHit;
      const calaminolDosageOverlap = !hasQueryDosage || calaminolCandidateCore.includes(matchQuery) || calaminolCandidateCore.includes(dosageLessQuery) || calaminolCandidateCore.includes(exactRoot);
      const calaminolTokenOverlap = alternativeTokens.length === 0
        ? calaminolCandidateCore.includes(queryCore)
        : alternativeTokens.some((token) => {
            if (calaminolCandidateCore.includes(token)) return true;
            return tokenize(calaminolCandidateCore).some((ct) => tokenSimilarity(token, ct) >= 0.76);
          });
      console.log(`[DEGRADED-CALAMINOL] rank=${calaminolIdx} score=${calaminolItem.score} refSim=${calaminolItem.referenceSimilarity} softScore=${calaminolSoftScore} dosageOverlap=${calaminolDosageOverlap} tokenOverlap=${calaminolTokenOverlap} candCore='${calaminolCandidateCore.slice(0, 80)}' pass=${calaminolTokenOverlap && (calaminolDosageOverlap || calaminolSoftScore)}`);
    } else {
      console.log(`[DEGRADED-CALAMINOL] NOT FOUND in scoredProducts`);
    }
    // Async diagnostic: query both collections for DAFLON by name
    findProductByNormalizedName('daflon').then((result) => {
      console.log(`[DAFLON-QUERY] productsMarket=${result.productsMarket.length} providersProducts=${result.providersProducts.length} error=${result.error || 'none'}`);
      if (result.productsMarket.length > 0) {
        result.productsMarket.forEach((p, i) => console.log(`[DAFLON-QUERY] PM[${i}] id=${p.id} ProductTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
      if (result.providersProducts.length > 0) {
        result.providersProducts.forEach((p, i) => console.log(`[DAFLON-QUERY] PP[${i}] id=${p.id} productTitle='${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
      }
    });
    // Targeted DAFLON diagnostic: find it in the full scoredProducts list
    const daflonIdx = scoredProducts.findIndex((item) => item.tokenSet && item.tokenSet.has('daflon'));
    if (daflonIdx >= 0) {
      const daflonItem = scoredProducts[daflonIdx];
      const daflonCandidateCore = normalizeText([daflonItem.productTitleFull, daflonItem.titleArrayTextFull, daflonItem.ingredient, daflonItem.productText, daflonItem.title].filter(Boolean).join(' '));
      const daflonSoftScore = (daflonItem.score ?? 0) >= 40 || (daflonItem.referenceSimilarity ?? 0) >= 0.60 || daflonItem.fullFocusMatch || daflonItem.exactHit || daflonItem.phraseHit;
      const daflonDosageOverlap = !hasQueryDosage || daflonCandidateCore.includes(matchQuery) || daflonCandidateCore.includes(dosageLessQuery) || daflonCandidateCore.includes(exactRoot);
      const daflonTokenOverlap = alternativeTokens.length === 0
        ? daflonCandidateCore.includes(queryCore)
        : alternativeTokens.some((token) => {
            if (daflonCandidateCore.includes(token)) return true;
            return tokenize(daflonCandidateCore).some((ct) => tokenSimilarity(token, ct) >= 0.76);
          });
      console.log(`[DEGRADED-DAFLON] rank=${daflonIdx} score=${daflonItem.score} refSim=${daflonItem.referenceSimilarity} softScore=${daflonSoftScore} dosageOverlap=${daflonDosageOverlap} tokenOverlap=${daflonTokenOverlap} candCore='${daflonCandidateCore.slice(0, 80)}' pass=${daflonTokenOverlap && (daflonDosageOverlap || daflonSoftScore)}`);
    } else {
      console.log(`[DEGRADED-DAFLON] NOT FOUND in scoredProducts (checked tokenSet for 'daflon')`);
    }
    // Async diagnostic: query both collections for ESOZ, LEPRIT, and BUMETIN
    ['esoz', 'leprit', 'bumetin'].forEach((med) => {
      findProductByNormalizedName(med).then((result) => {
        console.log(`[DIAG-${med.toUpperCase()}-QUERY] productsMarket=${result.productsMarket.length} providersProducts=${result.providersProducts.length} error=${result.error || 'none'}`);
        if (result.productsMarket.length > 0) {
          result.productsMarket.slice(0, 5).forEach((p, i) => console.log(`[DIAG-${med.toUpperCase()}-QUERY] PM[${i}]: '${p.ProductTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
        }
        if (result.providersProducts.length > 0) {
          result.providersProducts.slice(0, 5).forEach((p, i) => console.log(`[DIAG-${med.toUpperCase()}-QUERY] PP[${i}]: '${p.productTitle}' productTitleArray=${JSON.stringify(p.productTitleArray)}`));
        }
      });
    });
    // Diagnostic: find FEXORAT and FEXOFENADINA entries in scoredProducts
    const fexoratIdx = scoredProducts.findIndex((item) => item.tokenSet && (item.tokenSet.has('fexorat') || (item.productTitleFull && /fexorat/i.test(item.productTitleFull))));
    const fexofenadinaStandaloneIdx = scoredProducts.findIndex((item) => item.tokenSet && (item.tokenSet.has('fexofenadina') && !item.tokenSet.has('fexorat') && !item.tokenSet.has('rinolast') && !item.tokenSet.has('suspension') && (item.productTitleFull && /^(?!.*\().*fexofenadina\s*180\s*mg/i.test(item.productTitleFull))));
    console.log(`[DIAG-FEXORAT] fexoratIdx=${fexoratIdx} fexofenadinaStandaloneIdx=${fexofenadinaStandaloneIdx}`);
    if (fexoratIdx >= 0) {
      const fexoratItem = scoredProducts[fexoratIdx];
      console.log(`[DIAG-FEXORAT] rank=${fexoratIdx} title='${fexoratItem.productTitleFull}' score=${fexoratItem.score ?? 'N/A'} refSim=${fexoratItem.referenceSimilarity ?? 'N/A'} tokenSet=${JSON.stringify([...fexoratItem.tokenSet].slice(0, 10))}`);
    }
    if (fexofenadinaStandaloneIdx >= 0) {
      const fsItem = scoredProducts[fexofenadinaStandaloneIdx];
      console.log(`[DIAG-FEXORAT] fexofenadinaStandalone rank=${fexofenadinaStandaloneIdx} title='${fsItem.productTitleFull}' score=${fsItem.score ?? 'N/A'} refSim=${fsItem.referenceSimilarity ?? 'N/A'} tokenSet=${JSON.stringify([...fsItem.tokenSet].slice(0, 10))}`);
    }
    const degradedMatches = scoredProducts.filter((item) => {
      const candidateCore = normalizeText([item.productTitleFull, item.titleArrayTextFull, item.ingredient, item.productText, item.title].filter(Boolean).join(' '));
      if (!candidateCore) return false;

      // For the primary query token, use substring match for long tokens (>=4) to avoid
      // short-prefix false positives (calaminol vs calzinc), but fall back to token similarity.
      const tokenOverlap = alternativeTokens.length === 0
        ? candidateCore.includes(queryCore)
        : alternativeTokens.some((token) => {
            if (token.length >= 4) {
              if (candidateCore.includes(token)) return true;
            } else {
              const shortRe = new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`, 'i');
              if (shortRe.test(candidateCore)) return true;
            }
            return tokenize(candidateCore).some((candidateToken) => tokenSimilarity(token, candidateToken) >= 0.76);
          });

      // Require tokenOverlap — eliminate the softScore bypass that was letting
      // high-score products (calzinc, calcitrex, calpal) through without real token match.
      if (!tokenOverlap) return false;

      // strictMatchCandidate: only pass if the product has real alignment with the query.
      // Requires refSim>=0.76 OR exact match — reject spurious degraded matches like daflon↔sonda
      const strictMatchCandidate = (item.referenceSimilarity ?? 0) >= 0.76
        || item.fullFocusMatch
        || item.exactHit
        || item.phraseHit;

      const dosageMatches = !hasQueryDosage || item.dosageExactMatch;
      const dosageOverlap = !hasQueryDosage || candidateCore.includes(matchQuery) || candidateCore.includes(dosageLessQuery) || candidateCore.includes(exactRoot);
      // Require BOTH token overlap AND (strictMatchCandidate OR dosageOverlap) — no dosage-alone fallback
      const queryTokensForOverlap = alternativeTokens.filter(t => t.length >= 2);
      const hasTokenOverlap = queryTokensForOverlap.length === 0
        ? candidateCore.includes(queryCore)
        : queryTokensForOverlap.some(token => candidateCore.includes(token));

return hasTokenOverlap && (strictMatchCandidate || dosageOverlap) && dosageMatches;
    });
    console.log(`🧪 [DEGRADED-FALLBACK-RESULT] degradedMatches.length=${degradedMatches.length}`);
    // Reject degraded matches with very low reference similarity — they are spurious
    // (e.g., daflon↔sonda with refSim≈0.55 should NOT appear as a catalog result)
    const bestRefSim = degradedMatches.length > 0 ? (degradedMatches[0].referenceSimilarity ?? 0) : 0;
    if (degradedMatches.length && bestRefSim >= 0.70) {
      candidateMatches = degradedMatches;
    }
    // else: candidateMatches stays empty — do NOT use degraded results with refSim < 0.70

    }

  // ── Firebase direct fallback: cuando los candidatos del catálogo local (primeros 2000 docs)
  // son escasos (< 3) o ausentes, consultar Firebase directamente para capturar productos
  // más allá del documento 2000 usando arrayContains sobre productTitleArray.
  if (candidateMatches.length < 3 && db) {
    // Buscar el primer token que NO sea sal farmacéutica ni dosage para la query directa.
    // En "fexofenadina clorhidrato 120 mg", el token útil es "fexofenadina".
    const saltFormTokens = new Set(['clorhidrato','cloruro','sulfato','fosfato','acetato','tartrato','malato','bromuro','ioduro','nitrato','besilato','succinato','fumarato','malonato','tiocianato','glucosamina','lisina','ornitina']);
    const qToken = (queryTokens.find((t) => !saltFormTokens.has(t) && !/^\d+$/.test(t) && t.length >= 4) || queryTokens[0] || '');
    if (qToken.length >= 4) {
        const qTokenLower = qToken.toLowerCase();
        console.log(`[FIREBASE-DIRECT] candidateMatches=${candidateMatches.length} (< 3), querying Firebase arrayContains for token='${qToken}' (lower='${qTokenLower}')...`);
        try {
          const [pmSnap, ppSnap] = await Promise.all([
            db.collection('products-market').where('productTitleArray', 'array-contains', qTokenLower).limit(20).get(),
            db.collection('providers-products').where('productTitleArray', 'array-contains', qTokenLower).limit(20).get(),
        ]);
        const firebaseDirectMatches = [...pmSnap.docs, ...ppSnap.docs].map((d) => d.data());
        console.log(`[FIREBASE-DIRECT] products-market=${pmSnap.size} providers-products=${ppSnap.size}`);
        if (firebaseDirectMatches.length > 0) {
          const directScored = firebaseDirectMatches
            .map((doc) => {
              const s = buildCatalogSignal(doc);
              const m = scoreSignal(s);
              const basePriceUsd = getPrice(doc);
              const basePriceBs = getPriceBs(doc, exchangeRate);
              const pricing = applySalesPricing(basePriceUsd, exchangeRate);
              const shortLabel = buildShortProductLabel(doc);
              return {
                ...m,
                productTitleFull: normalizeText(doc?.ProductTitle || shortLabel),
                productText: doc.productText || '',
                title: shortLabel,
                doc,
                basePriceUsd,
                basePriceBs,
                priceUsd: pricing.displayUsd,
                priceBs: pricing.displayBs,
                feeRate: pricing.feeRate,
                feeAmountUsd: pricing.feeAmountUsd,
              };
            })
            .sort((a, b) => b.score - a.score);
          console.log(`[FIREBASE-DIRECT] scored ${directScored.length} products, top title='${directScored[0]?.productTitleFull}' score=${directScored[0]?.score}`);
          // Append new candidates, avoiding duplicates with existing ones
          const existingIds = new Set(candidateMatches.map((c) => c.productTitleFull));
          const newCandidates = directScored.filter((c) => !existingIds.has(c.productTitleFull));
          candidateMatches = [...candidateMatches, ...newCandidates];
        }
      } catch (e) {
        console.error(`[FIREBASE-DIRECT] error: ${e.message}`);
      }
    }
  }

  if (!candidateMatches.length) {
    console.log(`🧪 [FINAL-RETURN] candidateMatches empty after all paths (including Firebase fallback), returning no results`);
    return { query, queryTokens, exchangeRate, matches: [] };
  }

  let topMatches = candidateMatches
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

  let filteredTopMatches = strictQueryTokens.length
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
          const closeWordMatch = exactWordMatch || candidateTokens.some((candidateToken) => tokenSimilarity(queryToken, candidateToken) >= 0.76);
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

  // ── Firestore direct fallback: when scoredProducts (2000 limit) misses the target,
  // query Firebase directly using arrayContains on productTitleArray to catch products
  // that exist beyond document 2000 in Firestore's default order.
  const queryToken = strictQueryTokens[0];
  const currentTopHasTarget = candidateMatches.some((item) => {
    const targetRe = new RegExp(`^${queryToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    return item.tokenSet && (item.tokenSet.has(queryToken) || (item.productTitleFull && targetRe.test(item.productTitleFull)));
  });
  if (!currentTopHasTarget && isSingleTokenQuery && db) {
    const queryTokenLower = queryToken.toLowerCase();
    console.log(`[FIREBASE-DIRECT] token='${queryToken}' catalog limited, querying Firebase arrayContains (lower='${queryTokenLower}')...`);
    try {
      const [pmSnap, ppSnap] = await Promise.all([
        db.collection('products-market').where('productTitleArray', 'array-contains', queryTokenLower).limit(20).get(),
        db.collection('providers-products').where('productTitleArray', 'array-contains', queryTokenLower).limit(20).get(),
      ]);
      const firebaseDirectMatches = [...pmSnap.docs, ...ppSnap.docs].map((d) => d.data());
      console.log(`[FIREBASE-DIRECT] products-market=${pmSnap.size} providers-products=${ppSnap.size}`);
      if (firebaseDirectMatches.length > 0) {
        const directScored = firebaseDirectMatches
          .map((doc) => {
            const s = buildCatalogSignal(doc);
            const m = scoreSignal(s);
            const basePriceUsd = getPrice(doc);
            const basePriceBs = getPriceBs(doc, exchangeRate);
            const pricing = applySalesPricing(basePriceUsd, exchangeRate);
            return {
              ...s,
              score: m.score,
              referenceSimilarity: m.referenceSimilarity,
              exactHit: m.exactPhraseHit || m.strongTokenCoverage || m.vitaminHit || m.titleContentMatch || m.arrayContentMatch,
              fullFocusMatch: m.fullFocusMatch,
              phraseHit: m.phraseHit,
              vitaminHit: m.vitaminHit,
              tokenCoverage: Math.max(m.tokenHitsTitle, m.tokenHitsArray, m.tokenHitsIngredient),
              basePriceUsd,
              basePriceBs,
              priceUsd: pricing.displayUsd,
              priceBs: pricing.displayBs,
              feeRate: pricing.feeRate,
              feeAmountUsd: pricing.feeAmountUsd,
            };
          })
          .sort((a, b) => b.score - a.score);
        console.log(`[FIREBASE-DIRECT] scored ${directScored.length} products, top title='${directScored[0]?.productTitleFull}' score=${directScored[0]?.score}`);
        candidateMatches = [...candidateMatches, ...directScored];
        topMatches = [...topMatches, ...directScored];
        filteredTopMatches = topMatches.slice(0, 20).sort((a, b) => {
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
        }).filter((item) => {
          const candidateText = (item.productTitleFull || '').toLowerCase();
          const qToken = strictQueryTokens[0];
          if (candidateText.includes(qToken)) return true;
          for (const candidateToken of tokenize(candidateText)) {
            if (candidateToken === qToken) return true;
            const similarity = tokenSimilarity(qToken, candidateToken);
            if (similarity >= 0.9) return true;
          }
          return false;
        });
        console.log(`[FIREBASE-DIRECT] filteredTopMatches recomputed length=${filteredTopMatches.length}`);
      }
    } catch (e) {
      console.error(`[FIREBASE-DIRECT] error: ${e.message}`);
    }
  }

  let finalMatches = consultationMode
    ? topMatches
    : (recipeMode
      ? (filteredTopMatches.length ? filteredTopMatches : topMatches)
      : (isShortNonDosageQuery ? filteredTopMatches : (filteredTopMatches.length ? filteredTopMatches : topMatches)));

  // ── STRICT MODIFIER + DOSAGE FILTER ────────────────────────────────────────
  // When query has modifier tokens (forte, flex, plus, etc.), ONLY accept
  // products that contain ALL modifiers. Missing modifier = excluded, not penalised.
  // When query has dosage signatures (50mg, 100mg, etc.), the product MUST contain
  // that exact dosage. Uses passedDosageSigs (from original text, not stripped query).
  // This ensures "losartan potasico 50mg" only returns 50mg products.
  // This runs after scoring so it catches all paths including consultationMode.
  if ((modifierTokens && modifierTokens.length > 0) || hasPassedDosage) {
    const beforeCount = finalMatches.length;
    const filteredByModifier = finalMatches.filter((item) => {
      const productText = (item.productTitleFull || '').toLowerCase();
      // Modifier filter: product must contain every modifier token
      const modifierOk = !modifierTokens || modifierTokens.length === 0 ||
        modifierTokens.every((mod) => productText.includes(mod.toLowerCase()));
      if (!modifierOk) return false;
      // Dosage filter: if query has dosage signatures (passed from original text), product must contain each one
      if (hasPassedDosage) {
        const productDosageSigs = extractDosageSignatures(item.productTitleFull || '');
        const dosageOk = passedDosageSigs.every((sig) =>
          productDosageSigs.some((pSig) => pSig === sig || pSig.replace(/\s+/g, '') === sig.replace(/\s+/g, ''))
        );
        if (!dosageOk) return false;
      }
      return true;
    });
    console.log(`🧪 [MODIFIER-FILTER] query='${query}' modifierTokens=${JSON.stringify(modifierTokens)} passedDosageSigs=${JSON.stringify(passedDosageSigs)} before=${beforeCount} after=${filteredByModifier.length}`);
    if (filteredByModifier.length > 0) {
      finalMatches = filteredByModifier;
    }
    // If filteredByModifier is empty, keep original (don't suppress all results)
  }

  // ── GEOLOCATION: Load providers and filter by distance ─────────────────
  const radioKm = options.radioKm ?? DEFAULT_RADIO_KM;
  let providersList = [];
  if (userCoords) {
    providersList = await fetchProviders();
    console.log(`[GEO] userCoords=${JSON.stringify(userCoords)} providers=${providersList.length} radio=${radioKm}km`);
  }

  // ── ENRICH + FILTER + SORT matches ──────────────────────────────────────
  let geoMatches = finalMatches;
  if (userCoords && providersList.length > 0) {
    // Enrich each match with provider info and distance
    geoMatches = finalMatches
      .map((item) => enrichMatchWithProvider(item, userCoords, providersList))
      .filter((item) => {
        if (item.distancia == null) return true; // keep if no provider found
        return item.distancia <= radioKm;
      })
      .sort((a, b) => {
        // Primary sort: distance (asc). Items without distance go last.
        const distA = a.distancia ?? Infinity;
        const distB = b.distancia ?? Infinity;
        if (distA !== distB) return distA - distB;
        // Secondary sort: score (desc) for same distance
        return (b.score || 0) - (a.score || 0);
      });

    const filteredOut = finalMatches.length - geoMatches.length;
    if (filteredOut > 0) {
      console.log(`[GEO-FILTER] query='${query}' filteredOut=${filteredOut} within=${radioKm}km`);
    }
  }

  if (geoMatches.length === 0) {
    return {
      query,
      queryTokens,
      exchangeRate,
      groupTitle: query,
      matches: [],
      geoNoResults: userCoords ? true : false
    };
  }

  const top3titles = geoMatches.slice(0, 3).map((m, i) => `(#${i} '${m.productTitleFull}' score=${m.score} exactHit=${m.exactHit})`).join(' ');
  console.log(`🧪 [SMN-RETURN] query='${query}' geoMatches.length=${geoMatches.length} topMatches.length=${topMatches.length} top3=[${top3titles}] consultationMode=${consultationMode}`);
  return {
    query,
    queryTokens,
    exchangeRate,
    groupTitle: query,
    matches: geoMatches.map((item) => ({
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
      focusTitleHit: item.vitaminHit,
      // Geolocation data
      providerName: item.provider?.name || null,
      providerCiudad: item.provider?.ciudad || null,
      distancia: item.distancia != null ? Math.round(item.distancia * 10) / 10 : null,
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
    if (item.providerName) {
      const distText = item.distancia != null ? ` — a ${item.distancia} km` : '';
      lines.push(`   🏥 ${item.providerName}${distText}`);
    }
    lines.push(`   ${usdText}  |  ${bsText}`);
    lines.push('');
  });

  lines.push('');
  lines.push('👉 Para agregar: quiero X cajas de la opción Z');
  lines.push('Ejemplo: quiero 2 cajas de la opción 3');
  lines.push('🛒 ¿Otro medicamento? Escríbeme el nombre y lo agrego a tu lista.');
  lines.push('✅ Cuando termines, escribe *LISTO* y te muestro el resumen.');

  const response = lines.join('\n').trim();

  // ── HEURISTIC GUARD (zero cost) ─────────────────────────────────────────
  const h = heuristicCheck(response, result.query || '');
  if (!h.ok) {
    console.log(`🚨 [VALIDATOR] buildCatalogResponse HEURISTIC REJECT reason="${h.reason}" query="${result.query || ''}"`);
    return '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.';
  }

  return response;
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
  // Group results by normalized medicine name, merging groups that differ only in dosage.
  //
  // IMPORTANT: use result.query (not groupTitle) as the source of truth.
  // groupTitle is set to query inside searchMedicinesByName and is not further
  // normalized — but downstream code may have corrupted it (e.g. returning the
  // full multi-medicine query string instead of the individual medicine name).
  // result.query is the original medicineQuery passed to searchMedicinesByName
  // in the multi-medicine loop and is always a single, correct medicine name.
  const normalizedGroups = new Map();
  for (const result of results) {
    const rawTitle = String(result.query || result.groupTitle || 'MEDICAMENTO').toUpperCase();
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
    // HOWEVER: if the remainder after the normalized title is PURE DOSAGE (e.g. "40 MG",
    // "300 MG"), then this is the SAME medicine with dosage info, NOT a different product —
    // do NOT skip. Only skip when remainder is a real modifier like "FLEX", "FORTE", "DUO".
    // BUG FIX: isSubsetOfQuery must compare normalized remainder vs normalized remainder,
    // not normalized title vs raw query. Previously: "ATORVASTATINA" (normalized) was
    // detected as subset of "ATORVASTATINA 30" (rawQueryUpper) → remainder = "30" →
    // FALSE POSITIVE: both groups kept separate with wrong dosage handling.
    // Now: we check if the remainder (from raw) normalizes to a pure dosage pattern.
    const rawQueryUpper = String(result.query || '').toUpperCase();
    const normalizedRawQuery = rawQueryUpper
      .replace(/^(?:TIENES|TIENE|TENER|HAY|DISPONIBLE|DISPONIBLES|DISPONIBILIDAD|POR\s+FAVOR|QUISIERA|QUIERO|NECESITO|BUSCO|BUSCAR|CONSULTAR)\s+/i, '')
      .replace(/\s*DE\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU|TABLETAS?|CÁPSULAS?|CAPS?|AMPOLLAS?|SUSPENSION|SUSP|JARABE|GOTAS|CREMA|GEL|POLVO|UNGÜENTO|SOBRES?)\b.*$/i, '')
      .replace(/\s+DE\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)\b/i, '')
      .replace(/\s+\d+\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)\b.*$/i, '')
      .replace(/\(\s*SIMETICONA\s*\)\s*\d+\s*MG.*$/i, '')
      .trim();
    const isSubsetOfQuery = (() => {
      if (normalizedRawQuery.length <= normalizedTitle.length || !normalizedRawQuery.includes(normalizedTitle)) {
        return false;
      }
      // Extract what comes after the normalized title in the NORMALIZED raw query
      const remainder = normalizedRawQuery.startsWith(normalizedTitle + ' ')
        ? normalizedRawQuery.slice(normalizedTitle.length + 1).trim()
        : '';
      // Pure dosage remainder: "40 MG", "30", "DE 40 MG" → same medicine, don't skip
      // Also accept bare standalone number (e.g. "ATORVASTATINA 30" → remainder="30")
      if (/^\d+(?:[.,]\d+)?\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)?\s*$/i.test(remainder)) return false;
      if (/^DE\s+\d+(?:[.,]\d+)?\s*(?:MG|MCG|G|GR|ML|CC|UI|IU)?\s*$/i.test(remainder)) return false;
      // Otherwise it's a real modifier (FLEX, FORTE, DUO…) → skip
      return true;
    })();
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
      // Merge matches into existing group, deduplicating by doc.id (Firebase product ID)
      // and by normalized title. This handles cases where different query strings
      // (e.g. "EVIGAX" vs "EVIGAX CAP") map to the same normalized medicine name
      // but return slightly different product sets from Firebase.
      const existing = normalizedGroups.get(key);
      const existingDocIds = new Set(existing.matches.map((m) => m.doc?.id).filter(Boolean));
      const existingTitles = new Set(existing.matches.map((m) => normalizeText(m.title || '')));
      for (const match of result.matches || []) {
        const docId = match.doc?.id;
        const matchTitle = normalizeText(match.title || '');
        // Skip if already seen by doc.id (same Firebase product from different searches)
        if (docId && existingDocIds.has(docId)) {
          console.log('🧹 [MULTI-DEDUP] Skipped duplicate doc.id="%s" title="%s" key="%s"', docId, match.title || '', key);
          continue;
        }
        if (!existingTitles.has(matchTitle)) {
          existing.matches.push(match);
          existingTitles.add(matchTitle);
          if (docId) existingDocIds.add(docId);
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
      if (item.providerName) {
        const distText = item.distancia != null ? ` — a ${item.distancia} km` : '';
        lines.push(`   🏥 ${item.providerName}${distText}`);
      }
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

  const response = lines.join('\n').trim();

  // ── HEURISTIC GUARD (zero cost) ─────────────────────────────────────────
  // Use first result's query as representative for multi-catalog validation
  const representativeQuery = results?.[0]?.query || flatOptions?.[0]?.title || '';
  const h = heuristicCheck(response, representativeQuery);
  if (!h.ok) {
    console.log(`🚨 [VALIDATOR] buildMultiCatalogResponse HEURISTIC REJECT reason="${h.reason}" query="${representativeQuery}"`);
    return '👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.';
  }

  return response;
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
    // Reject greeting/time false positives like "feliz viernes" before they become medicine candidates
    if (/\b(feliz\s+viernes|feliz\s+dias|buenos?\s+dias|buenas?\s+tardes|buenas?\s+noches)\b/i.test(cleaned)) continue;
    // Reject segments that are purely conversational: no dosage, no real medicine-like tokens
    // This catches "hola quiero saber si disponen" (single-segment greeting preamble)
    if (!/\d+\s*(?:mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|caps?|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|ungüento|sobres?|retad|retard)/i.test(cleaned) && cleaned.length < 15) {
      // No dosage pattern and short → conversational preamble, reject
      if (!/\b(losartan|atorvastatin|atorva|nifedipin|clopidrog|clopid|esomeprazol|omeprazol|metform|ibuprofen|paracetamol|acetilsalicil|diclofenac|betacaroteno)\b/i.test(cleaned)) {
        console.log('🧹 [EXTRACT-MED] Rejected conversational segment: "%s"', segment);
        continue;
      }
    }
    // Skip pure dosage segments (no medicine name): "40 MG", "25 MG", etc.
    if (/^\s*\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|mL|ui|iu)\s*$/i.test(cleaned)) continue;
    if (!/(\d+\s*(?:mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)|(?:mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina))/.test(cleaned) && cleaned.length < 6) continue;
    const query = extractMedicineQuery(segment) || segment;
    if (!query) continue;

    // Always split by spaces and validate each token. This handles both:
    // (a) single-token query + multi-token cleaned → space-token fallback (was already here)
    // (b) multi-token query (e.g. "bumetin retadar evigax...") → now split and validated too
    const SALT_FORMS = new Set(['potasico','potásico','sodico','sódico','clorhidrato','maleato','besilato','sulfato','nitrato','fosfato','acetato','diclorhidrato','bromuro']);
    const spaceTokens = cleaned.split(/\s+/).filter((t) => t.length >= 3);
    let tokensAdded = 0;
    for (const token of spaceTokens) {
      if (results.includes(token)) continue;
      const lower = token.toLowerCase();
      // Reject pharmaceutical salt forms — they are descriptors, not medicines
      // "acido" / "ácido" is a chemical class prefix (e.g. "ácido ursodesoxicólico"),
      // not a standalone medicine — treat it like a salt form so it never appears alone.
      if (SALT_FORMS.has(lower) || lower === 'acido' || lower === 'ácido') continue;
      if (looksLikeMedicineName(token)) {
        results.push(token);
        tokensAdded += 1;
      }
    }

    // ── MULTI-MEDICINE DOSAGE STRIP ──────────────────────────────────────────
    // When a long segment (6+ tokens) contains multiple medicines and dosages
    // but has no verb to separate them, strip dosages so each medicine name is
    // searched individually with its dosage preserved in the candidate string.
    // E.g. "ATORVASTATINA DE 30 NIFEDIPINA DE 10 MG" → adds "ATORVASTATINA 30"
    // and "NIFEDIPINA 10" as separate candidates (extractMedicineQuery will then
    // preserve the dosage in searchMedicinesByName for proper penalty scoring).
    // Also handles the case where the fallback below would add the FULL concat
    // string as one spurious candidate.
    const segmentHasDosagePattern = /\d+\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|caps?|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|ungüento|sobres?)\b/i.test(cleaned);
    const segmentHasVerb = /^(?:tienes?|tiene?|hay|disponibles?|quisiera?|quiero?|necesito?|busco?|consultar?|verificar?|confirmar?)\s/i.test(cleaned);
    if (tokensAdded >= 2 && segmentHasDosagePattern && !segmentHasVerb && cleaned.split(/\s+/).length >= 6) {
      // Strip dosage suffixes from each dosage in the segment
      const stripped = cleaned
        .replace(/\b\d+\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|caps?|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|ungüento|sobres?)\b/gi, ' ')
        .replace(/\s+de\s+\d+\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const strippedTokens = stripped.split(/\s+/).filter(t => {
        if (t.length < 3) return false;
        const lowerTok = t.toLowerCase();
        // Reject salt forms that the dosage strip didn't remove
        if (SALT_FORMS.has(lowerTok) || lowerTok === 'acido' || lowerTok === 'ácido') return false;
        return looksLikeMedicineName(t);
      });
      for (const tok of strippedTokens) {
        if (!results.includes(tok)) {
          results.push(tok);
        }
      }
    }

    // Only fall back to the original query if space-token split added nothing
    // AND the query is short enough that it won't pollute multi-medicine results.
    // Long concatenated strings (many tokens) are NOT added — they create spurious
    // search groups like "ESOZ LEPRIT BUMETIN..." with bad fuzzy matches.
    // Also reject if the query contains a salt form token (e.g. "acido ursodesoxicolico"
    // should not be searched as-is when "acido" is a salt form; strip it first).
    const queryTokensCount = cleaned.split(/\s+/).length;
    const queryTokensLower = cleaned.split(/\s+/).map(t => t.toLowerCase());
    const queryHasSaltForm = queryTokensLower.some(t => SALT_FORMS.has(t) || t === 'acido' || t === 'ácido');
    if (tokensAdded === 0 && !results.includes(query) && queryTokensCount <= 6 && !queryHasSaltForm) {
      // Reject fragments that start with a bare number — e.g. "75 Losartan" from
      // splitSingleLineMedicineList boundary splitting on dosage numbers.
      if (/^\d+\s/.test(query)) {
        console.log('🧹 [EXTRACT-MED] Rejected number-prefixed fragment: "%s"', query);
      } else {
        results.push(query);
      }
    } else if (tokensAdded === 0 && queryHasSaltForm) {
      // Salt form detected in fallback query — strip salt form tokens and re-check
      const strippedQuery = queryTokensLower
        .filter(t => !SALT_FORMS.has(t) && t !== 'acido' && t !== 'ácido')
        .join(' ');
      if (strippedQuery.length >= 3 && !results.includes(strippedQuery)) {
        if (looksLikeMedicineName(strippedQuery)) {
          results.push(strippedQuery);
          console.log('🧹 [EXTRACT-MED] Salt-form strip -> "%s" (from "%s")', strippedQuery, query);
        }
      }
    }
  }

  // Final cleanup: deduplicate candidates, reject spurious single tokens
  // (greeting words, salt forms, dosage-only strings that slipped through)
  return dedupLLMMedicines(results);
}

function splitMedicineSegments(text) {
  // Split on explicit list markers: bullets, newlines, or dashes that precede whitespace.
  // Also split on dosage boundaries within each line: "40 MG LEPRIT 25 MG" → ["40 MG LEPRIT", "25 MG"]
  const unitList = 'mg|mcg|g|gr|ml|mL|ui|iu';
  const dosageBoundaryRe = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s+(${unitList})\\b(?=\\s+[A-ZÁÉÍÓÚÑ])`, 'gi');
  // Salt forms must never appear as standalone medicine groups
  const SALT_FORMS_SEG = new Set(['potasico','potásico','sodico','sódico','clorhidrato','maleato','besilato','sulfato','nitrato','fosfato','acetato','diclorhidrato','bromuro','acido','ácido']);

  const lines = String(text)
    .split(/\n+|[•·●]+|(?:^|\s)-(?=\s|$)/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const result = [];
  for (const line of lines) {
    if (!line) continue;
    const nmLine = normalizeText(line);
    // Count dosage boundaries in this line
    const matches = [...nmLine.matchAll(/\b(\d+(?:[.,]\d+)?)\s+(mg|mcg|g|gr|ml|mL|ui|iu)\b/gi)];
    if (matches.length <= 1) {
      result.push(line);
    } else {
      // Split on each dosage boundary: the lookahead (?=\s+[A-Z]) ensures we split
      // AFTER the unit when followed by a new capitalized name token.
      let lastIdx = 0;
      for (const m of matches) {
        const boundaryEnd = m.index + m[0].length;
        if (boundaryEnd > lastIdx) {
          const segment = line.slice(lastIdx, boundaryEnd).trim();
          if (segment) result.push(segment);
          lastIdx = boundaryEnd;
        }
      }
      const rest = line.slice(lastIdx).trim();
      if (rest && result.length > 0) {
        // Append remaining text to the last segment (it belongs to the previous medicine)
        result[result.length - 1] += ' ' + rest;
      } else if (rest) {
        result.push(rest);
      }
    }
  }
  return result;
}

function splitSingleLineMedicineList(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const commaSplit = raw.replace(/\s*,\s*/g, ',').split(',').map((s) => s.trim()).filter(Boolean);
  if (commaSplit.length >= 2) {
    return commaSplit;
  }

  // ── Unit patterns ──
  const UNIT_RE = /^(?:mg|mcg|g|gr|ml|mL|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i;

  // ── Strong stopwords to strip when extracting medicine name ──
  const STRONG_STOP_RE = /^(?:de|del|la|el|las|los|una|unos|que|y|con|para|por|sin|no|si|un|une)$/i;

  // ── Tokenize preserving position ──
  const tokenRe = /\S+/g;
  const tokens = [];
  let m;
  while ((m = tokenRe.exec(raw)) !== null) {
    tokens.push({ tok: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (tokens.length < 2) return [raw];

  // ── Pass 1: identify medicine-start positions (segment boundaries) ──
  // A new medicine starts at position i when the PREVIOUS token ends a dosage:
  //   a) tokens[i-1] is a number  AND  tokens[i] is a unit  (e.g. "10 mg" → next starts at "mg")
  //   b) tokens[i-1] is a number  AND  tokens[i] is UPPERCASE  (e.g. "de 75 Losartan")
  //   c) tokens[i-1] is a number  AND  tokens[i] is lowercase BUT preceded by "de NUMBER"
  //      within the same segment (e.g. "de 30 nifedipina" → nifedipina starts new segment)
  // We store these as medStart indices (where each medicine segment begins).
  // ── Pass 2: within each segment, find " de NUMBER" (last occurrence)
  // and extract medicine = last capitalized word(s) before it.
  const medStartIndices = new Set([0]); // segment 0 always starts at 0

  for (let i = 1; i < tokens.length; i++) {
    const cur = tokens[i].tok;
    const prev = tokens[i - 1] ? tokens[i - 1].tok : null;
    const prevNum = prev && /^\d+(?:[.,]\d+)?$/.test(prev);
    const curIsUpper = /^[A-ZÁÉÍÓÚÑ]/.test(cur);
    const prevIsDe = /^(?:de|del)$/i.test(tokens[i - 2] ? tokens[i - 2].tok : null);
    // Case (c): lowercase after number but the "de" before the number belongs to this medicine
    // e.g. "atorvastatina de 30 nifedipina" → nifedipina starts after " de 30"
    const prevPrev = i >= 2 ? tokens[i - 2].tok : null;
    const prevPrevIsDe = /^(?:de|del)$/i.test(prevPrev);
    const prevPrevNum = prevPrev && /^\d+(?:[.,]\d+)?$/.test(prevPrev);

    if ((prevNum && curIsUpper) ||                      // case (b): "de 75 Losartan"
        (prevNum && !curIsUpper && prevPrevIsDe)) {     // case (c): "de 30 nifedipina"
      medStartIndices.add(i);
    }
    // Case (a): "de 10 mg" — boundary AFTER the unit (i+1 = start of next medicine)
    // Only add if i+1 is within bounds; if at end of input, no boundary needed.
    if (i > 0 && prevNum && UNIT_RE.test(cur) && i + 1 < tokens.length) {
      medStartIndices.add(i + 1);
    }
  }

  if (medStartIndices.size < 2) return [raw];

  // ── Pass 2: build segments and extract medicine+drugs ──
  const sortedStarts = [...medStartIndices].sort((a, b) => a - b);
  const result = [];

  for (let s = 0; s < sortedStarts.length; s++) {
    const start = sortedStarts[s];
    const end = s + 1 < sortedStarts.length ? sortedStarts[s + 1] : tokens.length;
    if (start >= end) continue;
    const segTokens = tokens.slice(start, end);
    const segText = segTokens.map(t => t.tok).join(' ');

    // Find the LAST " de NUMBER" in the segment (the actual dosage for this medicine)
    // Look for pattern: " de " followed by a digit
    let dosageDeIdx = -1; // local index in segTokens
    for (let j = segTokens.length - 1; j >= 0; j--) {
      const t = segTokens[j].tok;
      const prevT = j > 0 ? segTokens[j - 1].tok : null;
      if (/^(?:de|del)$/i.test(prevT) && /^\d/.test(t)) {
        dosageDeIdx = j - 1; // " de " starts at j-1
        break;
      }
    }

    let medicineStr = '';
    if (dosageDeIdx >= 0) {
      medicineStr = segTokens.slice(0, dosageDeIdx).map(t => t.tok).join(' ').trim();
      const lastTok = segTokens[segTokens.length - 1].tok;
      const lastTokIsNum = /^\d+(?:[.,]\d+)?$/.test(lastTok);
      // If segment ends with a number and next token in original array is a unit, include it
      let trailingUnit = '';
      if (lastTokIsNum && (start + segTokens.length) < tokens.length) {
        const nextTok = tokens[start + segTokens.length] ? tokens[start + segTokens.length].tok : null;
        if (nextTok && UNIT_RE.test(nextTok)) trailingUnit = ' ' + nextTok;
      }
      const dosageWithUnit = (UNIT_RE.test(lastTok)
        ? segTokens.slice(dosageDeIdx, end - start).map(t => t.tok).join(' ').trim()
        : segTokens.slice(dosageDeIdx, end - start).map(t => t.tok).join(' ').trim()) + trailingUnit;
      const combined = (medicineStr + ' ' + dosageWithUnit).trim();
      // Reject segments that are preamble/greeting fragments:
      // - medicineStr has >5 words (likely a greeting prepended to medicine)
      //   UNLESS combined >= 15 chars (might be a short valid dosage)
      const medicineWords = medicineStr.split(/\s+/).filter(Boolean);
      const isGreetingLike = medicineWords.length > 5 && combined.length < 15;
      if (!isGreetingLike) {
        result.push(combined);
      }
    } else {
      // No dosage found — whole segment is the query.
      // Skip if it's just a unit (e.g. "mg" leftover from previous dosage).
      // Also reject if the segment is purely a salt form (e.g. "potasico") or
      // starts/ends with a salt form that would create a spurious standalone group.
      const segText2 = segText.trim();
      const segTokensLower = segText2.split(/\s+/).map(t => t.toLowerCase());
      const segHasSaltForm = segTokensLower.some(t =>
        SALT_FORMS_SEG.has(t) || t === 'acido' || t === 'ácido'
      );
      if (segText2.length >= 3 && !UNIT_RE.test(segText2) && !segHasSaltForm) {
        result.push(segText2);
      }
    }

  }

  if (result.length >= 2) return result;
  // Fallback: whole text
  const whole = extractMedicineQuery(raw);
  return whole && whole.trim().length >= 2 ? [whole.trim()] : [raw];
}

function extractMedicineRequestsFromSegments(text) {
  const rawText = String(text || '').trim();
  if (!rawText) return [];

  const segments = splitMedicineSegments(rawText);
  const pieces = segments.length > 1 ? segments : splitSingleLineMedicineList(rawText);
  const filteredPieces = pieces.filter((piece) => !/\b(belen|belén|arcia|patient|paciente|nombre|apellido|ano nac|año nac)\b/i.test(normalizeText(piece)));
  const results = [];

  for (const piece of filteredPieces) {
    const cleaned = normalizeText(piece);
    if (!cleaned) continue;
    if (isGreetingOrMenu(cleaned) || isThanksMessage(cleaned) || /^(listo|resumen)$/i.test(cleaned)) continue;
    // Reject pure salt forms as standalone medicines (e.g. "potásico", "clorhidrato")
    if (/^(?:potasico|potásico|clorhidrato|clorhidrico|sodico|sodica|sodio|benzoico|acetico)$/i.test(cleaned)) continue;
    // Reject pure numbers (e.g. "3") — not medicine names
    if (/^\d+$/.test(cleaned)) continue;
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?|vitamina)/.test(cleaned)) continue;

    const query = extractMedicineQuery(piece) || cleaned;
    if (!query) continue;

    // FIX: Same issue as extractMedicineRequests — when query is single token but
    // piece has multiple space-separated tokens, split and validate each.
    if (query.indexOf(' ') === -1 && cleaned.indexOf(' ') !== -1) {
      const spaceTokens = cleaned.split(/\s+/).filter((t) => t.length >= 3);
      for (const token of spaceTokens) {
        if (results.includes(token)) continue;
        if (looksLikeMedicineName(token)) {
          results.push(token);
        }
      }
      // Only add fallback if fewer than 7 tokens (don't pollute with long concat strings)
      const fallbackTokensCount = cleaned.split(/\s+/).length;
      if ((results.length === 0 || !results.includes(query)) && fallbackTokensCount <= 6) {
        if (!results.includes(query)) results.push(query);
      }
    } else {
      // Single-word or multi-word query — also reject pure salt forms
      if (/^(?:potasico|potásico|clorhidrato|clorhidrico|sodico|sodica|sodio|benzoico|acetico)$/i.test(query)) return results;
      // Reject pure dosage strings: "10mg", "40mg", "100mg", "5mg"
      if (/^\d+\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|mL)$/i.test(normalizeText(query))) return results;
      if (!results.includes(query)) results.push(query);
    }
  }

  return results;
}

function dedupeStrings(values) {
  if (!Array.isArray(values)) return [];
  // Normalize all values first
  const normalized = values.map((v) => normalizeText(v)).filter(Boolean);
  // Remove exact duplicates only — do NOT remove items that are substrings of product names.
  // E.g. "bumetin" must NOT be removed just because "bumetin retard 300mg" exists in catalog.
  // Substring deduplication breaks multi-medicine search when catalog products contain
  // medicine names as prefixes (common with dosage modifiers like RETARD, FORTE, etc.).
  const unique = [...new Set(normalized)];
  return unique;
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
  // Deduplicate by normalized title (same product from different searches).
  // Also deduplicate by productId when available (same Firebase document ID =
  // guaranteed same product even if laboratory/sizing in title differs).
  const seenTitles = new Set();
  const seenProductIds = new Set();
  const seenProductTitleFull = new Set();
  for (const group of Array.isArray(results) ? results : []) {
    const groupQuery = String(group?.query || '').trim();
    const groupLabel = String(group?.groupTitle || group?.title || groupQuery || 'Medicamento').trim();
    for (const item of group?.matches || []) {
      const normTitle = normalizeText(item.title || '');
      const normPTF = normalizeText(item.productTitleFull || '');
      const productId = item.doc?.id;
      // Skip if we've already seen this product (by doc.id Firebase document ID,
      // or by exact normalized title — handles same product returned via
      // different search queries like "evigax cap" vs "evigax").
      // Also dedup by productTitleFull as fallback when title is empty.
      const titleKey = normTitle || normPTF;
      const idKey = String(productId || '');
      if (titleKey && seenTitles.has(titleKey)) {
        console.log('🧹 [FLATTEN-DEDUP] Skipped duplicate title="%s" ptf="%s" id="%s"', item.title || '', item.productTitleFull || '', idKey);
        continue;
      }
      if (idKey && seenProductIds.has(idKey)) {
        console.log('🧹 [FLATTEN-DEDUP] Skipped duplicate productId="%s" title="%s"', idKey, item.title || '');
        continue;
      }
      if (titleKey) seenTitles.add(titleKey);
      if (idKey) seenProductIds.add(idKey);
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
  console.log(`[CATALOG-FETCH] products-market count=${primary.length}${primary.length > 0 ? " firstTitles=" + JSON.stringify(primary.slice(0,3).map(d => d.ProductTitle || d.productTitle)) : ''}`);
  if (primary.length) return primary;

  const fallback = await fetchCollectionDocuments('providers-products', limit);
  console.log(`[CATALOG-FETCH] providers-products fallback count=${fallback.length}`);
  if (fallback.length) return fallback;

  return [];
}

// Diagnostic: find a specific product by normalized name in both collections
async function findProductByNormalizedName(name) {
  if (!db) return { productsMarket: [], providersProducts: [] };
  const normalized = normalizeText(name);
  try {
    const [pmSnap, ppSnap] = await Promise.all([
      db.collection('products-market').limit(2000).get(),
      db.collection('providers-products').limit(2000).get(),
    ]);
      const matches = (snap) => snap.docs.filter((d) => {
      const t = normalizeText(d.data().ProductTitle || d.data().productTitle || '');
      const normArr = Array.isArray(d.data().productTitleArray) ? d.data().productTitleArray.map(normalizeText) : [];
      // EXACT match on productTitleArray tokens — prevents substring false positives like "bumetin" → "ALBUMIN"
      // Use toLowerCase() on BOTH sides since normalizeText does NOT lowercase
      // and Firebase may store tokens in any case (upper, lower, mixed)
      const allTokens = normalized.split(/\s+/);
      const qLower = normalized.toLowerCase();
      const tokenMatch = allTokens.some((tok) => normArr.some((a) => a.toLowerCase() === tok.toLowerCase()));
      // Also keep loose ProductTitle includes (case-insensitive)
      return tokenMatch || t.toLowerCase().includes(qLower);
    }).map((d) => ({ id: d.id, ProductTitle: d.data().ProductTitle || d.data().productTitle, productTitleArray: d.data().productTitleArray }));
    return { productsMarket: matches(pmSnap), providersProducts: matches(ppSnap) };
  } catch (e) {
    return { productsMarket: [], providersProducts: [], error: e.message };
  }
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

// Modifier tokens: adjectives/qualifiers that act as mandatory filters when paired
// with a product name (2nd+ token in a multi-token query). E.g. "atamel forte" →
// only products containing "forte". These are NOT dosage forms or stopwords.
const MODIFIER_TOKENS = new Set([
  'forte', 'plus', 'flex', 'duo', 'cor', 'bio', 'max', 'ultra', 'neo',
  'stop', 'gel', 'kids', 'infantil', 'ped', 'adulto', 'crono', 'retard',
  'noct', 'diario', 'semanal', 'mensual', 'caps', 'film', 'ocular',
  'nasal', 'oral', 'topico', 'cutaneo', 'endovenoso', 'ev', 'im',
  'sl', 'sublingual', 'rectal', 'vaginal', 'transdermico', 'patch',
'original', 'generico', 'marca', 'premium', 'basic', 'fresh',
  'classic', 'natural', 'sintetico', 'con', 'sin'
]);

// Salt forms that should be rejected as standalone medicine groups
// when they appear in segment-lists without a dosage (no mg/unit pattern).
// Must be defined at module scope so splitSingleLineMedicineList can use it.
const SALT_FORMS_SEG = new Set([
  'potasico', 'potásico', 'sodico', 'sódico', 'clorhidrato', 'maleato',
  'besilato', 'sulfato', 'nitrato', 'fosfato', 'acetato', 'diclorhidrato',
  'bromuro', 'acido', 'ácido'
]);

// ----------------------------------------------------
// Text helpers
// ----------------------------------------------------
function normalizeText(value) {
  return String(value || '')
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
    'gotas','crema','gel','unguento','pomada','polvo','sobres','granulado',
    'supositorio','ovulo','parche','aerosol','inhalador','spray','drop','barra',
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

  // Find the first line that looks like a drug name (has letters, not mostly numbers)
  // and has at least one dosage-like token (number followed by unit or number alone in dosage context)
  let bestLine = '';
  for (const line of lines) {
    const cleanLine = line.replace(/\s+/g, ' ').trim();
    // Skip lines that are purely numeric or too short
    if (cleanLine.replace(/\d/g, '').replace(/\s/g, '').length < 4) continue;
    // Skip lines that are mostly numbers/symbols
    if (/^[\d\s.,+-]+$/.test(cleanLine)) continue;
    // Skip lines that match classification/marketing/brand only
    const lineLower = cleanLine.toLowerCase();
    const words = lineLower.split(/\s+/);
    const hasContent = words.some(w => !TRASH_WORDS.has(w) && !PURE_DOSAGE_TOKEN.test(w) && /[a-záéíóúñ]/i.test(w));
    if (!hasContent) continue;
    bestLine = cleanLine;
    break;
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

  // Remove dosage suffixes like "120 mg" from the end, keeping just the drug name
  // But if there's a dosage number in the middle (e.g. "METFORMINA 500mg") keep it
  result = result
    .replace(/\s*\d+\s*(mg|mcg|g|gr|ml|mL|ui|iu)\b\.?/gi, '')
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

  // ── FAST PATH: DISABLED — returning the full multi-token string as a single
  // item causes it to appear as a search group, duplicating results from individual
  // tokens. Multi-medicine OCR lines MUST be split into individual tokens.
  // const fastTokens = raw.trim().split(/\s+/).filter((t) => t.length > 1);
  // if (fastTokens.length >= 2 && fastTokens.every((t) => /^[a-záéíóúñ]{3,}/i.test(t))) {
  //   console.log('🧪 [EXTRACT-RECIPE] raw value=%s → FAST PATH (full multi-token input)', raw.slice(0, 200));
  //   return [raw.trim()];
  // }

  // ── ALWAYS SPLIT multi-token single-line input into individual medicine tokens ─
  const DOSAGE_FORMS_RE = /^(?:mg|mcg|g|gr|ml|cc|ui|iu|cap|caps|susp|suspen|suspension|tableta|tabletas|capsula|capsulas|capsule|capsules|jarabe|gotas|crema|gel|polvo|polvos|unguento|sobres?|ampolla|ampollas|vial|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i;
  const SALT_FORMS_RE = /^(?:clorhidrato|cloruro|besilato|sulfato|fosfato|acetato|tartrato|malato|fumarato|succinato|bromuro|ioduro|nitrato|tiocianato|acido|ácido|potasico|potásico|potasi|dinitrato|dinitric)$/i;
  // "acido" / "ácido" is a chemical class prefix (e.g. "ácido ursodesoxicólico"),
  const fastTokens = raw.trim().split(/\s+/).filter((t) => t.length > 1);
  if (fastTokens.length >= 2 && !/\r?\n/.test(raw)) {
    // Single-line multi-token input: split into individual tokens
    // Filter out dosage forms (CAP, SUSP, etc.), salt forms (CLORHIDRATO, SULFATO, etc.),
    // and pure numeric tokens — they are not standalone medicines
    const splitTokens = fastTokens.filter(t => !DOSAGE_FORMS_RE.test(t) && !SALT_FORMS_RE.test(t) && !/^\d+(?:[.,]\d+)?$/.test(t));
    console.log('🧪 [EXTRACT-RECIPE] raw value=%s → SPLIT into tokens=%s', raw.slice(0, 200), JSON.stringify(splitTokens));
    return splitTokens;
  }

  // ── PRESCRIPTION-MULTI: split by newlines first, then refine each line ─────────
  // For prescription OCR, each line is a separate medicine. Split by newlines,
  // then use dosage-boundary detection to further split lines that contain
  // multiple medicines without explicit newlines (common in low-quality OCR).
  const LINE_SPLIT_RE = /\r?\n+|[•·●\u2022]+|(?:\s+[-–—]\s+)/g;
  let rawLines = raw.split(LINE_SPLIT_RE).map((l) => l.trim()).filter(Boolean);

  // ── DOSAGE-BOUNDARY SPLIT: split a line on dosage transitions ─────────────────
  // Strategy: pair each dosage "N UNIT" with the medicine name that precedes it.
  // e.g. "EVIGAX CAP MODERAN SUSP MILAX POLVO DAFLON 500 MG"
  //   → pair(0, "evigax cap modernan susp milax polvo daflon", "500 mg")
  //   → pair(0, "evigax cap modernan susp milax polvo", "daflon", "500 mg") ← wait
  // Actually simpler: for each dosage, the medicine name is the text BEFORE the dosage
  // up to the PREVIOUS dosage (or start of line).
  // e.g. "A B C 500 MG D E 300 MG" → ["A B C 500 MG", "D E 300 MG"]
  const unitListRe = /(\d+(?:[.,]\d+)?)\s*(?:m\s*g|mcg|g|gr|m\s*l|mL|ui|iu)\b/gi;

  const refinedLines = [];
  for (const line of rawLines) {
    const nmLine = normalizeText(line);
    if (!nmLine) continue;

    // ── PRE-PROCESS DOSAGE OCR ARTIFACTS ─────────────────────────────────────
    // OCR commonly produces "MGM" instead of "MG" and "MLL" instead of "ML"
    // due to letter doubling. Normalize these before dosage matching.
    // Apply same normalization to raw `line` to keep positions in sync with nmLine.
    const lineFixed = line
      .replace(/\bMGM\b/g, 'MG')
      .replace(/\bMGL\b/g, 'ML')
      .replace(/\bMLL\b/g, 'ML');
    const nmLineFixed = nmLine
      .replace(/\bmg\b/gi, 'MG')  // standardize "mg" → "MG"
      .replace(/\bmgm\b/gi, 'MG') // "mgm" → "MG" (OCR artifact)
      .replace(/\bmgl\b/gi, 'ML') // "mgl" → "ML"
      .replace(/\bmll\b/gi, 'ML'); // "mll" → "ML"

    // Find all dosage positions in this line (using fixed normalized text for matching)
    const dosages = [];
    let dm;
    const unitReLocal = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(?:m\\s*g|mcg|g|gr|m\\s*l|mL|ui|iu)\\b', 'gi');
    while ((dm = unitReLocal.exec(nmLineFixed)) !== null) {
      dosages.push({ start: dm.index, end: dm.index + dm[0].length, text: dm[0] });
    }

    if (dosages.length === 0) {
      // No dosage found — line might be "EVIGAX CAP" (form only) — keep as-is.
      // BUT: skip lines that are purely a salt form (e.g. "CLORHIDRATO") — they are
      // not standalone medicines. Also skip lines where every token is a salt form.
      const lineWords = lineFixed.split(/\s+/);
      const allSaltForm = lineWords.length > 0 && lineWords.every(w => SALT_FORMS_RE.test(w));
      if (!allSaltForm) {
        refinedLines.push(lineFixed);
      }
    } else if (dosages.length === 1) {
      // Single dosage — strip dosage suffix so we search by medicine name only
      // e.g. "BUMETIN RETADAR 300 MG" → "BUMETIN RETADAR"
      const d0 = dosages[0];
      const medicineOnly = lineFixed.slice(0, d0.start).trim();
      if (medicineOnly) refinedLines.push(medicineOnly);
    } else {
      // Multiple dosages — pair each dosage with the medicine name before it.
      // Segment i = text BEFORE dosage_i (from prev_end or 0) + " " + dosage_i
      let prevEnd = 0;
      for (let i = 0; i < dosages.length; i++) {
        const d = dosages[i];
        const segmentText = lineFixed.slice(prevEnd, d.start).trim() + (d.text ? ' ' + d.text : '');
        if (segmentText.trim()) refinedLines.push(segmentText.trim());
        prevEnd = d.end;
      }
      // Anything remaining after the last dosage is part of the last medicine
      // (e.g. "DAFLON 500 MG BARGONIL CREMA" → last medicine is "DAFLON 500 MG",
      // "BARGONIL CREMA" is remaining text that should be appended to last segment)
      const remainder = lineFixed.slice(prevEnd).trim();
      if (remainder) {
        // ── SINGLE-LINE MULTI-MEDICINE SPLIT ──────────────────────────────────
        // When a single-line OCR has no newlines but contains multiple medicines
        // separated by dosage form keywords (CAP, SUSP, POLVO, etc.) followed by
        // another capitalized medicine name, split the remainder at those boundaries.
        // E.g. "EVIGAX CAP MODERAN SUSP MILAX POLVO DAFLON 500 MG BARGONIL CREMA"
        //   → ["EVIGAX CAP", "MODERAN SUSP", "MILAX POLVO", "DAFLON 500 MG", "BARGONIL CREMA"]
        const FORM_KW_RE = /\b(CAP(?:S(?:US|pen|PA)?|ULOS?|ULAS?)?|SUSP(?:EN(?:SION)?)?|POLVO(?:S)?|CREMA(?:TOS?)?|GEL(?:S)?|UNG(?:UENTO)?(?:S)?|SOBRES?|AMPOLLAS?|TABLETAS?|CAPSULAS?|JARABE|GOTAS|RETAD|RETARD)\b/gi;
        // Find all form-keyword matches with their positions and what follows them
        const formMatches = [];
        let m;
        FORM_KW_RE.lastIndex = 0;
        while ((m = FORM_KW_RE.exec(remainder)) !== null) {
          const afterStart = m.index + m[0].length;
          const afterText = remainder.slice(afterStart);
          formMatches.push({
            keyword: m[1],
            end: afterStart,
            followedByUpper: /^\s+[A-ZÁÉÍÓÚÑ]/.test(afterText),
            followedByEnd: !afterText.trim()
          });
        }
        if (formMatches.length > 0) {
          // Use form keywords as split points.
          // For each form keyword followed by uppercase (new medicine boundary),
          // the medicine name = text from segment_start to keyword_start, last 1-2 words
          const splitSegments = [];
          let segStart = 0;
          for (const fm of formMatches) {
            if (fm.followedByUpper || fm.followedByEnd) {
              // Extract medicine name: text from segStart to fm.start (before keyword's leading space)
              const textBefore = remainder.slice(segStart, fm.start).trimEnd();
              const words = textBefore.split(/\s+/);
              // Last 1-2 words = medicine name (handles "BUMETIN RETARD" as 2 words)
              const medName = words.slice(-2).join(' ');
              if (medName) splitSegments.push(medName + ' ' + fm.keyword);
              // Next medicine starts after the keyword's TRAILING space (not leading space)
              // fm.end = position right after keyword; the trailing space is one char after
              // unless keyword is at end of string
              const trailingSpace = (fm.end < remainder.length && remainder[fm.end] === ' ') ? 1 : 0;
              segStart = fm.end + trailingSpace;
            }
            // If not followed by uppercase/end, this keyword belongs to current medicine — skip
          }
          // Final segment: from segStart to end (may contain dosage or another medicine)
          const finalText = remainder.slice(segStart).trimStart();
          if (finalText) {
            // Check for form keywords in finalText (e.g. "BARGONIL CREMA")
            const innerForms = [];
            let im;
            FORM_KW_RE.lastIndex = 0;
            while ((im = FORM_KW_RE.exec(finalText)) !== null) {
              innerForms.push({ keyword: im[1], start: im.index, end: im.index + im[0].length });
            }
            if (innerForms.length > 0) {
              // finalText has form keywords — split it
              // Handle orphan dosage before first form keyword: "DAFLON 500 MG BARGONIL CREMA"
              // → first form keyword "CREMA" at some pos
              // → text before = "DAFLON 500 MG BARGONIL"
              // → check if it ends with a dosage (e.g. "500 MG")
              const firstForm = innerForms[0];
              const textBeforeFirst = finalText.slice(0, firstForm.start).trimEnd();
              // Check for orphan dosage in textBeforeFirst
              const orpDosRe = /(\d+(?:[.,]\d+)?)\s+(mg|mcg|g|gr|ml|mL|ui|iu)\b[^a-zA-Z]*$/i;
              const orpMatch = orpDosRe.exec(textBeforeFirst);
              if (orpMatch) {
                // Orphan dosage: split at the last dosage, push "DAFLON 500 MG" first
                const dosEndInText = textBeforeFirst.indexOf(orpMatch[0]);
                const medBeforeDos = textBeforeFirst.slice(0, dosEndInText).trimEnd();
                if (medBeforeDos) splitSegments.push(medBeforeDos);
                splitSegments.push(orpMatch[0].trim());
              } else {
                // No orphan dosage — use last 1-2 words as medicine name
                const words = textBeforeFirst.split(/\s+/);
                const medName = words.slice(-2).join(' ');
                if (medName) splitSegments.push(medName + ' ' + firstForm.keyword);
              }
              // Remaining form keywords + what follows
              let iStart = firstForm.end;
              // Find trailing space after first form keyword
              const iTrailingSpace = (iStart < finalText.length && finalText[iStart] === ' ') ? 1 : 0;
              iStart += iTrailingSpace;
              for (let i = 1; i < innerForms.length; i++) {
                const ifm = innerForms[i];
                const textBefore = finalText.slice(iStart, ifm.start).trimEnd();
                const words2 = textBefore.split(/\s+/);
                const medName2 = words2.slice(-2).join(' ');
                if (medName2) splitSegments.push(medName2 + ' ' + ifm.keyword);
                const ifmTrailingSpace = (ifm.end < finalText.length && finalText[ifm.end] === ' ') ? 1 : 0;
                iStart = ifm.end + ifmTrailingSpace;
              }
              const lastBit = finalText.slice(iStart).trim();
              if (lastBit) splitSegments.push(lastBit);
            } else {
              // No form keywords in finalText — check for orphan dosage
              const dosRe = /(\d+(?:[.,]\d+)?)\s+(mg|mcg|g|gr|ml|mL|ui|iu)\b/i;
              const dosMatch = dosRe.exec(finalText);
              if (dosMatch) {
                // finalText = "DAFLON 500 MG" → push as-is
                splitSegments.push(finalText);
              } else {
                // No dosage — it's a single medicine name, push as-is
                splitSegments.push(finalText);
              }
            }
          }
          if (splitSegments.length > 1) {
            // Push all split segments as separate medicines
            for (const seg of splitSegments) {
              const segTrim = seg.trim();
              if (segTrim) refinedLines.push(segTrim);
            }
          } else if (refinedLines.length > 0) {
            // No split happened — fall back to appending to last segment
            refinedLines[refinedLines.length - 1] += ' ' + remainder;
          } else {
            refinedLines.push(remainder);
          }
        } else if (refinedLines.length > 0) {
          // No form keywords found — fall back to appending
          refinedLines[refinedLines.length - 1] += ' ' + remainder;
        } else {
          refinedLines.push(remainder);
        }
      }
    }
  }

  const chunks = refinedLines;

  const metaPatterns = [
    /^(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro)\b/i,
    /^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i,
    /^(paciente|rp|rx|receta|nombre|apellidos?|apellido|ano nac|año nac|fecha|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección)\b/i,
    /^(no\s+disponibles?|resultados?\s+encontrados|te\s+muestro|tasa\s+bcv|cuando\s+termines|otro\s+medicamento|para\s+agregar|ejemplo|receta\s+detectada)\b/i,
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
  console.log('🧪 [EXTRACT-RECIPE] raw value=%s chunks=%s', raw.slice(0, 200), JSON.stringify(chunks));
  const pushCandidate = (candidate) => {
    const normalized = normalizeText(candidate);
    if (!normalized) return;
    console.log('🧪 [PUSH-CANDIDATE] candidate="%s" normalized="%s"', candidate, normalized);
    if (metaPatterns.some((pattern) => pattern.test(candidate) || pattern.test(normalized))) return;
    if (isGreetingOrMenu(normalized) || isThanksMessage(normalized) || /^(listo|resumen)$/i.test(normalized)) return;
    if (!/[a-záéíóúñ]/i.test(candidate)) return;
    if (normalized.split(' ').length > 8) return;
    if (!formOrDose.test(candidate) && !shortBrandLike.test(normalized)) return;
    if (/\b(belen|belén|arcia|patient|paciente|nombre|apellido|ano nac|año nac|dr\.|dra\.|doctor|doctora|unidad|gastroenterologia|gastroenterología)\b/i.test(normalized)) return;
    // Skip lines that look like user query fragments (contain user query verbs)
    if (userQueryVerbPatterns.some((p) => p.test(normalized))) return;
    // Reject single-word generic selection tokens (caja, opcion, unidad, etc.)
    // These are not medicine names and should not trigger a catalog search.
    if (normalized.split(/\s+/).length === 1 && /^(?:caja[se]?|opcion(?:es)?|unidad(?:es)?|unidad(?:es)?)$/i.test(normalized)) return;
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

  console.log('🧪 [EXTRACT-RECIPE] candidates (before dedup)=%s', JSON.stringify(candidates));
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

  // Reject dosage-form OCR artifacts that look like medicines but are actually dosage forms.
  // "retadar" is a common OCR error for "retard" (Bumetin Retard / Bumetin Retadar).
  if (/\b(retad|retard)\b/i.test(normalized)) return false;
  if (isGreetingOrMenu(normalized) || isThanksMessage(normalized) || /^(listo|resumen)$/i.test(normalized)) return false;
if (/^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(raw)) return false;
  if (/\b(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro|paciente|stadium|ano nac|año nac|birthday|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección|gastroenterologia|gastroenterología)\b/i.test(normalized)) return false;
  // Reject standalone salt forms (e.g. "potásico", "clorhidrato") — they are pharmaceutical
  // descriptors, not medicines. The same check exists in extractPrimaryRecipeMedicineQuery
  // via MED_FORM_TOKENS but we add it here as an extra guard.
  if (/^(?:potasico|potásico|potasi|clorhidrato|clorhidrico|sodico|sodica|sodio|benzoico|acetico)$/i.test(normalized)) return false;

  return Boolean(extractPrimaryRecipeMedicineQuery(raw));
}

function extractPrimaryRecipeMedicineQuery(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeText(raw);
  if (!normalized) return '';

if (/^(dr\.?|dra\.?|doctor|doctora|medico|médico)\b/i.test(raw)) return '';
  if (/\b(unidad|servicio|departamento|especialidad|area|área|clinica|clínica|consultorio|sala|piso|pabellon|pabellón|urgencias|emergencias|hospital|centro|paciente|stadium|ano nac|año nac|datum|edad|sexo|peso|talla|ci|c\.i\.|cedula|cédula|firma|sello|telefono|teléfono|direccion|dirección|gastroenterologia|gastroenterología)\b/i.test(normalized)) return '';

  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) return '';

  const MED_FORM_TOKENS=new Set([
    'ampolla', 'ampollas', 'vial', 'viales', 'frasco', 'frascos', 'tableta', 'tabletas', 'capsula', 'capsulas',
    'cápsula', 'cápsulas', 'cap', 'caps', 'suspension', 'suspensión', 'susp', 'jarabe', 'gotas', 'crema', 'gel', 'polvo', 'polvos',
    'unguento', 'unguentos', 'sobres', 'sobresa', 'retad', 'retadar', 'retardar', 'retardado', 'retardada', 'capsules', 'tablet', 'tabletass',
    // Pharmaceutical salt forms — never standalone medicines
    'potasico', 'potásico', 'sodico', 'sódico', 'clorhidrato', 'maleato', 'besilato', 'sulfato', 'nitrato', 'fosfato', 'acetato', 'diclorhidrato', 'bromuro'
  ]);
  const isDoseToken = (token) => /^(\d+(?:[.,]\d+)?|mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i.test(token);
  const cleanedTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !isDoseToken(token));
  console.log('🧪 [EXTRACT-PRIMARY] raw="%s" tokens=%s cleanedTokens=%s => returning "%s"', raw, JSON.stringify(tokens), JSON.stringify(cleanedTokens), cleanedTokens[0] || 'NONE');

  if (cleanedTokens.length) return cleanedTokens[0];

  // Fallback: try to extract dosage (e.g. "40 mg" -> return "40 mg")
  const dosagePattern = /\b(\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?))\b/i;
  const dosageMatch = raw.match(dosagePattern);
  if (dosageMatch) return dosageMatch[1];

  return tokens[0] || '';
}

function looksLikeMedicineName(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (isGreetingOrMenu(text) || isThanksMessage(text) || /^(listo|resumen|bot on|bot off|bot status)$/i.test(text)) return false;

  // City names — these are NOT medicines
  const CITY_NAMES = new Set(['ciudad','bolivar','caracas','caja','seca','zaraza','maracaibo','valencia','barquisimeto','merida','maturin','barcelona','guayana','cuscas','cumana','cabimas','aturio','ipostel','fuerte','turmero','carrizal','guacara','san joaquin','anaco','turbaco','mérida','zulia','tachira','carabobo','aragua','vargas','miranda','lara']);
  const cityTokens = tokenize(text).filter((t) => t.length > 1);
  if (cityTokens.length > 0 && cityTokens.every((t) => CITY_NAMES.has(t))) {
    return false;
  }

  // ── Salt forms are NEVER standalone medicines ──────────────────────────
  const SALT_FORMS_CHECK = new Set(['potasico','potásico','sodico','sódico','clorhidrato','maleato','besilato','sulfato','nitrato','fosfato','acetato','diclorhidrato','bromuro','acido','ácido']);
  if (SALT_FORMS_CHECK.has(text)) return false;

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
    'poder', 'puede', 'pueden', 'ser', 'estar', 'ir', 'ver', 'dar', 'saber', 'querer',
    'feliz', 'viernes', 'buenos', 'buenas', 'dias', 'tardes', 'noches',
    // Bloquear palabras conversacionales de 4+ chars que se colaban como "medicinas"
    'hola', 'holas', 'quiero', 'saben', 'saber', 'hacen', 'haces', 'hacer',
    'disponen', 'disponer', 'tienes', 'tengo', 'tiene', 'buscar', 'busco']);
  const hasUsefulMultiTokenPhrase = tokens.length >= 2 && tokens.some((t) => t.length >= 4 && !GENERIC_TOKENS.has(t.toLowerCase()));
  // Also accept 4-char medicine names (e.g. "esoz", "fatr", "ferrz")
  // Reject single generic tokens even if 4+ chars (feliz/viernes/dias/buenos/buenas/etc.)
  // Also reject tokens that START with a WEAK_OPENER prefix (e.g. "dispones" starts with "dis")
  const WEAK_OPENER_PREFIXES_LM = ['me', 'te', 'le', 'nos', 'les', 'en', 'cuesta', 'cuanto', 'cuánto', 'necesito', 'busc', 'quier', 'quisier', 'dis'];
  const singleLower = tokens[0] ? tokens[0].toLowerCase() : '';
  const startsWithWeakOpener = singleLower.length >= 4
    && (WEAK_OPENER_PREFIXES_LM.some(p => singleLower.startsWith(p)) || GENERIC_TOKENS.has(singleLower));
  const hasStrongSingleToken = tokens.length === 1 && tokens[0].length >= 4
    && !/^(precio|costo|catalogo|catálogo|producto|medicamento|buscar|busco|tienes|tiene|hay|disponible|disponibilidad)$/.test(tokens[0])
    && !startsWithWeakOpener;

  return hasDosageOrForm || hasUsefulMultiTokenPhrase || hasStrongSingleToken;
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

function extractMedicineQuery(text) {
  // DEBUG: log input and output to trace production behavior
  const _dbg_input = String(text ?? '').trim().slice(0, 80);
  // HARD REJECT: dosage forms and quantity patterns that are NEVER medicine names
  if (/^(?:mgr|mgrs|x\d+|tabl|tabs?|caps|capsulas?|susp|jarabe|gotas|crema|gel|polvo|sobres?)$/i.test(String(text ?? '').trim())) {
    console.log('🧪 [DIAG-EMQ] IN="%s" => HARD-REJECT (dosage/quantity token)', _dbg_input);
    return '';
  }
  const cleaned = normalizeText(text);
  if (!cleaned) {
    console.log('🧪 [DIAG-EMQ] IN="%s" cleaned="%s" => "" (empty)', _dbg_input, cleaned);
    return '';
  }

  // Dosage strip: remove "100 mg", "gotas", etc. from candidate AFTER verb extraction
  const dosageStrip = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)\b/gi;

  const verbList = [
    'por\\sfavor','me\\spuedes\\sayudar\\scon','me\\sayudas\\scon','necesito','busco','busque','buscame','buscando','quiero',
    'quisiera','me\\sinteresa','me\\sinteresan','(?<!\\w)tienes\\b','(?<!\\w)tiene\\b','(?<!\\w)tienen\\b','(?<!\\w)hay\\b',
    'disponibilidad(?:\\sde)?','informar(?:\\ssobre)?','informe(?:\\ssobre)?','consultar(?:\\ssobre)?',
    'consulta(?:\\ssobre)?','informame(?:\\ssobre)?','informarme(?:\\ssobre)?','precio(?:\\sde)?','conoces','(?<!\\w)vendes?(?!\\w)',
    'dónde\\s(?:puedo\\s)?comprar','donde\\s(?:puedo\\s)?comprar','dónde\\scomprar','donde\\scomprar',
    'dónde\\s(?:puedo\\s)?conseguir','donde\\s(?:puedo\\s)?conseguir','dónde\\sconseguir','donde\\sconseguir',
    'dónde\\sconsigo','donde\\sconsigo','dónde\\sencuentro','donde\\sencuentro',
    '(?<!\\w)cuesta\\b'
  ];

  // Pattern 2a: "de X [unit]" where unit follows the number → strip X unit
  // e.g. "de 75 mg de Paracetamol" → strip "75 mg", keep "Paracetamol"
  const unitList = 'mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?';
  const P2A = new RegExp(`^(?:de|del|para|con)\\s+(\\d+(?:[.,]\\d+)?)\\s+(${unitList})\\b(?:\\s+|$)(.+)$`, 'i');
  // Pattern 2b: "de X" where X is a bare number followed by another word → DON'T strip
  const P2B = /^(?:de|del)\s+(\d+(?:[.,]\d+)?)(?:\s+|$)/i;

  // NOTE: (.+) is GREEDY so it captures the FULL query after the verb.
  const verbListJoined = verbList.join('|');
  const verbRe = new RegExp(`(?:^|\\s)(?:${verbListJoined})\\s+(.+)$`, 'i');
  console.log('🧪 [DIAG-EMQ] verbRe=%s', verbRe.toString().slice(0, 80));

  // FIX: Run verbRe on the ORIGINAL cleaned text (before dosageStrip) so that
  // "cotrimazol en gotas para el oido" is captured intact. Previously the
  // dosageStrip removed "gotas" first, leaving the verbRe to capture a broken
  // string that downstream filters rejected, returning "".
  let candidate = cleaned;
  const verbMatch = cleaned.match(verbRe);
  if (verbMatch?.[1]) {
    console.log('🧪 [DIAG-EMQ] IN="%s" verbMatch captured="%s"', _dbg_input, verbMatch[1]);
    candidate = normalizeText(verbMatch[1]);
  } else {
    // No verb matched — try P2A / P2B on the original text
    for (const pattern of [P2A, P2B]) {
      const match = cleaned.match(pattern);
      if (match?.[1]) {
        console.log('🧪 [DIAG-EMQ] IN="%s" pattern="%s" matched="%s" => candidate="%s"', _dbg_input, pattern.toString().slice(0, 40), match[0], match[1]);
        candidate = normalizeText(match[1]);
        break;
      }
    }
  }

  // Strip dosage from the extracted candidate (not from the original text before verb matching)
  candidate = candidate.replace(dosageStrip, ' ').replace(/\s+/g, ' ').trim();
  // ALSO strip trailing bare dosage that P2A/P2B might leave: "isosorbide 10", "medicine 30"
  candidate = candidate.replace(/\s+\d+(?:\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|mL))?\s*$/i, ' ').trim();

  candidate = candidate
    .replace(/^por\s+favor\s*/i, '')
    // Strip hola first (before the general greeting strip so it doesn't hide buenas noches)
    .replace(/^hola\b[\s,.-]*/i, '')
    .replace(/^(?:por\s+favor\s+)?(?:hola|buenas\s+noches|buenas\s+tardes|buenos\s+d[ií]as|buen\s+(?:dia|d[ií]a|tarde|noche)|saludos)\b[\s,.-]*/i, '')
    // Also strip trailing courtesy phrases like "feliz viernes", "feliz dia", "feliz semana"
    .replace(/\b(?:feliz\s+(?:viernes|lunes|martes|m[ií]ercoles|jueves|s[aá]bado|domingo|dia|d[ií]a|semana|año|navidad|cumpleaños|cumple))\b.*$/i, '')
    // If ONLY greeting/courtesy tokens remain, clear the candidate entirely
    .replace(/^(?:buenos\s+d[ií]as?|buenas\s+(?:noches|tardes)|buen\s+(?:dia|d[ií]a|tarde|noche)|feliz)\b[\s,.-]*$/i, '')
    .replace(/^(?:donde\s+puedo\s+comprar|dónde\s+puedo\s+comprar|donde\s+comprar|dónde\s+comprar|donde\s+consigo|dónde\s+consigo|donde\s+encuentro|dónde\s+encuentro)\s+/i, '')
    .replace(/^(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|hay\s+disponible|disponibilidad(?:\s+de)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|saber(?:\s+el)?(?:\s+precio)?(?:\s+de)?|cuanto\s+cuesta|cuánto\s+cuesta|conoces|vendes|venden)\s+/i, '')
    .replace(/^(?:comprar|conseguir|buscar|necesitar|querer|pedir|obtener|hallar|hallarme|buscame|buscame|buscarnos?|encuentra[rm]?)\s+/i, '')
    .replace(/^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a|la|el|las|los|unos|unas|y|acido|ácido)\s+/i, '')
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

const MED_FORM_TOKENS=new Set([
    'ampolla', 'ampollas', 'vial', 'viales', 'frasco', 'frascos', 'tableta', 'tabletas', 'capsula', 'capsulas',
    'cápsula', 'cápsulas', 'cap', 'caps', 'suspension', 'suspensión', 'susp', 'jarabe', 'gotas', 'crema', 'gel', 'polvo', 'polvos',
    'unguento', 'unguentos', 'sobres', 'sobresa', 'retad', 'retadar', 'retardar', 'retardado', 'retardada', 'capsules', 'tablet', 'tabletass',
    // Pharmaceutical salt forms — never standalone medicines
    'potasico', 'potásico', 'sodico', 'sódico', 'clorhidrato', 'maleato', 'besilato', 'sulfato', 'nitrato', 'fosfato', 'acetato', 'diclorhidrato', 'bromuro'
  ]);
  const MED_QUERY_WEAK_TOKENS=new Set([
    'precio', 'costo', 'valor', 'consulta', 'consultar', 'saber',
    'hola', 'buenas', 'gracias', 'medicamento', 'medicamentos', 'producto', 'productos', 'favor', 'por',
    'disponible', 'disponibles', 'disponibilidad',
    'me', 'te', 'le', 'nos', 'les', 'en', 'cuesta', 'cuanto', 'cuánto',
    'es', 'soy', 'son', 'está', 'están',
    'quiero', 'quisiera', 'necesito', 'busco', 'busque',
    'caja', 'cajas', 'unidad', 'unidades', 'opcion', 'opciones',
    // Verbs / conversational fragments that should never be medicine names
    'disponen', 'disponer', 'tengo', 'tienes', 'tiene', 'hacer', 'hace', 'haces'
  ]);
  const WEAK_OPENER_PREFIXES = ['me', 'te', 'le', 'nos', 'les', 'en', 'cuesta', 'cuanto', 'cuánto', 'necesito', 'busc', 'quier', 'quisier', 'dis'];
  function isWeakOpener(token) {
    const lower = token.toLowerCase();
    if (MED_QUERY_WEAK_TOKENS.has(lower)) return true;
    return WEAK_OPENER_PREFIXES.some(p => lower.startsWith(p) && lower !== p);
  }
  // Salt forms are NEVER standalone medicines — treat them as weak openers
  const SALT_FORMS_WEAK = new Set(['potasico','potásico','sodico','sódico','clorhidrato','maleato','besilato','sulfato','nitrato','fosfato','acetato','diclorhidrato','bromuro','mgr','mgrs','tabl','tabs','tab']);
  function isSaltForm(token) {
    return SALT_FORMS_WEAK.has(token.toLowerCase());
  }
  const isDoseToken = (token) => /^(\d+(?:[.,]\d+)?|mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|cap|caps|ampollas?|suspension|susp|jarabe|gotas|crema|gel|polvo|polvos|unguento|unguentos|sobres?|retad(?:ar|or)?|retard(?:ar|ado|ada)?)$/i.test(token);
  const cleanedTokens = tokens.filter((token) => !MED_FORM_TOKENS.has(token) && !isDoseToken(token));
  const firstStrongToken = cleanedTokens.find((token) => !isWeakOpener(token) && !isSaltForm(token));
  console.log('🧪 [DIAG-EMQ] IN="%s" cleaned="%s" => "%s" (cleanedTokens=%s firstStrong=%s)', _dbg_input, cleaned, firstStrongToken || '', JSON.stringify(cleanedTokens), firstStrongToken || 'none');
  // If multiple non-dose tokens remain, return the FULL normalized candidate
  // to preserve multi-token product names (e.g. "atamel forte", "dorixina flex").
  // The single-token case also returns the candidate (may be multi-word).
  if (firstStrongToken) {
    // Only use firstStrongToken alone if it is the ONLY non-weak token
    const otherStrongTokens = cleanedTokens.filter((t) => t !== firstStrongToken && !isWeakOpener(t) && !isSaltForm(t));
    if (otherStrongTokens.length > 0) {
      // Multiple strong tokens → return full normalized query to preserve all tokens
      console.log('🧪 [DIAG-EMQ] IN="%s" => returning FULL candidate="%s" (cleanedTokens=%s)', _dbg_input, candidate, JSON.stringify(cleanedTokens));
      return candidate;
    }
    // Reject salt forms even as single strong token — "potasico" alone is never a medicine
    if (isSaltForm(firstStrongToken)) {
      console.log('🧪 [DIAG-EMQ] IN="%s" => rejecting salt form "%s"', _dbg_input, firstStrongToken);
      return '';
    }
    console.log('🧪 [DIAG-EMQ] IN="%s" => returning firstStrongToken="%s" (cleanedTokens=%s)', _dbg_input, firstStrongToken, JSON.stringify(cleanedTokens));
    return firstStrongToken;
  }

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
    let beforeNum = '';
    if (lastIdx > 0) {
      beforeNum = candidate.slice(0, lastIdx).trim();
      if (beforeNum && !/^(?:de|del|para|con|sobre|la|el|las|los|una|unos|que|y|por|sin|no|si|un|une)$/i.test(beforeNum)) {
        const combined2 = `${beforeNum} ${numStr}`.trim();
        if (combined2.length >= 2) return combined2;
      }
    }
    if (!beforeNum || !beforeNum.trim()) return numStr;
  }

  const weakFiltered = cleanedTokens.filter((token) => !MED_QUERY_WEAK_TOKENS.has(token));
  if (weakFiltered.length) {
    const firstWeak = weakFiltered[0];
    // Never return a salt form or a weak opener as fallback result
    if (isSaltForm(firstWeak) || isWeakOpener(firstWeak)) {
      console.log('🧪 [DIAG-EMQ] IN="%s" => rejecting weak/salt fallback "%s"', _dbg_input, firstWeak);
      return '';
    }
    console.log('🧪 [DIAG-EMQ] IN="%s" => returning weakFiltered[0]="%s"', _dbg_input, firstWeak);
    return firstWeak;
  }
  console.log('🧪 [DIAG-EMQ] IN="%s" => returning "%s" (weakFiltered=%s)', _dbg_input, weakFiltered[0] || '', JSON.stringify(weakFiltered));
  return weakFiltered[0] || '';
}

function extractStrictConsultationMedicineQuery(text) {
  const extracted = extractMedicineQuery(text);
  if (!extracted) return '';

  const tokens = tokenize(extracted).filter((token) => !STOPWORDS.has(token) && token.length > 1);
  if (!tokens.length) return '';

  // Reject pure generic selection tokens — they should go to selection handler, not medicine search
  if (/^(?:caja[se]?|opcion(?:es)?|unidad(?:es)?)$/i.test(extracted.trim())) {
    return '';
  }

  if (/^vitamina\b/i.test(extracted)) return extracted;
  // Always return the FULL extracted query to preserve multi-token product names
  // like "atamel forte", "dorixina flex". The previous `tokens[0]` truncated to the
  // first token, breaking modifier-based filtering downstream.
  return extracted;
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
