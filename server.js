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
const GOOGLE_TOKEN_PATH='/opt/data/google_sheets_token.json';
const GOOGLE_CLIENT_SECRET_PATH='/opt/data/google_client_secret.json';

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
const globalCatalogByPhone = new Map(); // phone -> { options, timestamp } — survives session reloads
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
  if (existingIndex >= 0) {
    cart[existingIndex].quantity = (Number(cart[existingIndex].quantity) || 1) + quantity;
  } else {
    cart.push({ title: item.title || 'Unknown', priceUsd: item.priceUsd, priceBs: item.priceBs, quantity: quantity });
  }
  touchSession(session);
}

function formatPrice(num) {
  if (num === null || num === undefined) return '0.00';
  return Number(num).toFixed(2);
}

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function normalizeText(value) {
  if (!value) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿¡]/g, '')
    .toLowerCase()
    .trim();
}

function unwrapMessagePayload(payload) {
  if (!payload) return null;
  const unwrapped = payload?.message || payload?.data?.message || payload?.data?.data?.message || payload;
  if (typeof unwrapped === 'object' && unwrapped !== null) return unwrapped;
  return null;
}

// ----------------------------------------------------
// OCR — Computer Vision (OpenAI GPT-4o-mini with Vision)
// ----------------------------------------------------
async function extractTextFromImageOcr(mediaUrl) {
  if (!OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY no configurado — saltando OCR');
    return '';
  }

  try {
    const response = await axios.post(
      `${OPENAI_BASE_URL}/chat/completions`,
      {
        model: OPENAI_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: mediaUrl, detail: 'low' }
              },
              {
                type: 'text',
                text: OPENAI_VISION_PROMPT
              }
            ]
          }
        ],
        max_tokens: 1024,
        temperature: 0.1
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        timeout: MEDIA_ANALYSIS_TIMEOUT_MS
      }
    );

    const text = response?.data?.choices?.[0]?.message?.content?.trim() || '';
    console.log(`✅ OCR (OpenAI Vision) extrajo: "${text.slice(0, 200)}"`);
    return text;
  } catch (error) {
    console.error('❌ Error en OCR (OpenAI Vision):', error.response?.data || error.message);
    return '';
  }
}

// ----------------------------------------------------
// External media download (Evolution API / download)
// ----------------------------------------------------
async function downloadMedia(mediaUrlOrBase64, context = 'media') {
  if (!mediaUrlOrBase64) return null;
  if (mediaUrlOrBase64.startsWith('data:')) {
    const base64Data = mediaUrlOrBase64.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const tmpPath = `/tmp/${context}_${Date.now()}.jpg`;
    fs.writeFileSync(tmpPath, buffer);
    console.log(`💾 Media guardada desde base64: ${tmpPath}`);
    return tmpPath;
  }

  if (!mediaUrlOrBase64.startsWith('http')) {
    try {
      const parsed = JSON.parse(mediaUrlOrBase64);
      const url = parsed?.url || parsed?.downloadUrl || parsed?.link || null;
      if (!url) return null;
      const tmpPath = `/tmp/${context}_${Date.now()}.jpg`;
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      fs.writeFileSync(tmpPath, response.data);
      return tmpPath;
    } catch {
      return null;
    }
  }

  try {
    const tmpPath = `/tmp/${context}_${Date.now()}.jpg`;
    const response = await axios.get(mediaUrlOrBase64, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/*' }
    });
    fs.writeFileSync(tmpPath, response.data);
    console.log(`💾 Media descargada: ${tmpPath} (${response.data.length} bytes)`);
    return tmpPath;
  } catch (error) {
    console.error(`❌ Error descargando media: ${error.message}`);
    return null;
  }
}

// ----------------------------------------------------
// STOPWORDS
// ----------------------------------------------------
const STOPWORDS = new Set([
  'de','la','que','el','en','y','a','los','del','se','las','por','un','para','con','no','una','su','al','lo','como','más','pero','sus','le','ya','o','este','sí','porque','esta','entre','cuando','muy','sin','sobre','también','me','hasta','hay','donde','quien','desde','todo','nos','durante','todos','uno','les','ni','contra','otros','ese','eso','ante','ellos','e','esto','mí','antes','algunos','qué','unos','yo','otro','otras','otra','él','tanto','esa','estos','mucho','quienes','nada','muchos','cual','poco','ella','estar','estas','algunas','algo','nosotros','mi','mis','tú','te','ti','tu','tus','ellas','nosotras','vosotros','vosotras','os','mío','mía','míos','mías','tuyo','tuya','tuyos','tuyas','suyo','suya','suyos','suyas','nuestro','nuestra','nuestros','nuestras','vuestro','vuestra','vuestros','vuestras','esos','esas','estoy','estás','está','estamos','estáis','están','esté','estés','estemos','estéis','estén','estaré','estarás','estará','estaremos','estaréis','estarán','estaría','estarías','estaríamos','estaríais','estarían','estaba','estabas','estábamos','estabais','estaban','estuve','estuviste','estuvo','estuvimos','estuvisteis','estuvieron','estuviera','estuvieras','estuviéramos','estuvierais','estuvieran','estuviese','estuvieses','estuviésemos','estuvieseis','estuviesen','estando','estado','estada','estados','estadas','estad','he','has','ha','hemos','habéis','han','haya','hayas','hayamos','hayáis','hayan','habré','habrás','habrá','habremos','habréis','habrán','habría','habrías','habríamos','habríais','habrían','había','habías','habíamos','habíais','habían','hube','hubiste','hubo','hubimos','hubisteis','hubieron','hubiera','hubieras','hubiéramos','hubierais','hubieran','hubiese','hubieses','hubiésemos','hubieseis','hubiesen','habiendo','habido','habida','habidos','habidas','soy','eres','es','somos','sois','son','sea','seas','seamos','seáis','sean','seré','serás','será','seremos','seréis','serán','sería','serías','seríamos','seríais','serían','era','eras','éramos','erais','eran','fui','fuiste','fue','fuimos','fuisteis','fueron','fuera','fueras','fuéramos','fuerais','fueran','fuese','fueses','fuésemos','fueseis','fuesen','siendo','sido','tengo','tienes','tiene','tenemos','tenéis','tienen','tenga','tengas','tengamos','tengáis','tengan','tendré','tendrás','tendrá','tendremos','tendréis','tendrán','tendría','tendrías','tendríamos','tendríais','tendrían','tenía','tenías','teníamos','teníais','tenían','tuve','tuviste','tuvo','tuvimos','tuvisteis','tuvieron','tuviera','tuvieras','tuviéramos','tuvierais','tuvieran','tuviese','tuvieses','tuviésemos','tuvieseis','tuviesen','teniendo','tenido','tenida','tenidos','tenidas','tened',
  'x','por','favor','gracias','hola','bueno','buena','buenas','buenos',' ok ','okay','si','sí','no','nel','pa','ahi','ahí','dame','manda','ver','vas','vas a','va a','van','va','vamos','va','voy','vas','vas a','ir','es','son','ser','fue','fueron','hizo','hizo','hacen','hace','hacer','hay','haber','aquí','ahí','allí','allá','这条','这个','什么','怎么','如何','为什么','哪','哪个','哪儿','哪里','谁','多少','几','怎么样','好不好','可以吗','可以吗','帮我','请','打扰','抱歉','对不起','谢谢','感谢','厉害','真的','是啊','对啦','好嘛','好吗','好的','没问题','Ok','OK','k','K','bb','B','👍','👌','🙏','😊','😁','🤗','🤔','🤨','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥺','😘','😍','🥰','😇','🤩','🤔🤔'
]);

// ----------------------------------------------------
// Medicine name normalizer — strip dosage forms for matching
// ----------------------------------------------------
function normalizeMedicineName(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*\b(retard|retadar|retador|retardar|retardado|retardada|retad|forte|plus|flex|inyectable|jarabe|suspension|susp|gotas|crema|gel|polvo|unguento|capsulas?|capsulas|capsules?|tabletas?|ampollas?|sobres?|vial|viables?|frasco)\b/gi, ' ')
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|gr|ml|cc|ui|iu|mL)\b/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ----------------------------------------------------
// Similarity (Jaro-Winkler)
// ----------------------------------------------------
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const a = s1.length, b = s2.length;
  if (!a || !b) return 0;
  const matchWindow = Math.floor(Math.max(a, b) / 2) - 1;
  const matches = new Array(a).fill(false);
  const matches2 = new Array(b).fill(false);
  let matchesCount = 0;
  let transpositions = 0;
  for (let i = 0; i < a; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b);
    for (let j = start; j < end; j++) {
      if (matches2[j] || s2[j] !== s1[i]) continue;
      matches[i] = true;
      matches2[j] = true;
      matchesCount++;
      break;
    }
  }
  if (!matchesCount) return 0;
  let k = 0;
  for (let i = 0; i < a; i++) {
    if (!matches[i]) continue;
    while (!matches2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const m = matchesCount;
  return (m / a + m / b + (m - transpositions / 2) / m) / 3;
}

// ----------------------------------------------------
// Extract a single medicine name from a line (for recipe mode)
// Tries to split by common delimiters and pick the medicine part
// ----------------------------------------------------
function extractSingleMedicineName(line) {
  const raw = String(line || '').trim();
  if (!raw) return '';
  // Try comma/semicolon delimiters
  const parts = raw.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    // Pick the first part that looks like a medicine name
    for (const part of parts) {
      const extracted = extractMedicineQuery(part);
      if (extracted && extracted.length >= 3) return extracted;
    }
  }
  // Fallback: try the whole line
  return extractMedicineQuery(raw);
}

// ----------------------------------------------------
// Tokenizer
// ----------------------------------------------------
function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

// ----------------------------------------------------
// Fuzzy match with Jaro-Winkler
// ----------------------------------------------------
function fuzzyMatch(queryToken, productToken, threshold = 0.76) {
  const q = queryToken.toLowerCase();
  const p = productToken.toLowerCase();
  if (q === p) return 1;
  const sim = jaroWinkler(q, p);
  return sim >= threshold ? sim : 0;
}

// ----------------------------------------------------
// Check if query tokens roughly match product title tokens
// ----------------------------------------------------
function tokensMatch(queryTokens, productTokens, threshold = 0.76) {
  let matchCount = 0;
  for (const qt of queryTokens) {
    for (const pt of productTokens) {
      if (fuzzyMatch(qt, pt, threshold) > 0) {
        matchCount++;
        break;
      }
    }
  }
  return matchCount / queryTokens.length;
}

// ----------------------------------------------------
// Load Google Sheets credentials
// ----------------------------------------------------
function loadGoogleSheetsCredentials() {
  try {
    const tokenPath = process.env.GOOGLE_TOKEN_PATH || '/opt/data/google_sheets_token.json';
    const secretPath = process.env.GOOGLE_CLIENT_SECRET_PATH || '/opt/data/google_client_secret.json';
    if (!fs.existsSync(tokenPath) || !fs.existsSync(secretPath)) return null;
    return {
      token: JSON.parse(fs.readFileSync(tokenPath, 'utf8')),
      secret: JSON.parse(fs.readFileSync(secretPath, 'utf8'))
    };
  } catch {
    return null;
  }
}

// ----------------------------------------------------
// Divisa/tasa
// ----------------------------------------------------
async function getDivisaBs() {
  try {
    if (!db) return null;
    const doc = await db.collection('divisabcv').doc('tasabcv').get();
    if (!doc.exists) return null;
    return doc.data().DivisaBs || doc.data().divisaBs || doc.data().tasabcv || null;
  } catch (error) {
    console.error('❌ Error consultando.divisabcv:', error.message);
    return null;
  }
}

// ----------------------------------------------------
// Firestore — fetch catalog
// ----------------------------------------------------
async function fetchCatalogProducts(limit = 2000) {
  try {
    if (!db) return [];
    const snapshot = await db.collection('products-market').orderBy('ProductTitle').limit(limit).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('❌ Error consultando products-market:', error.message);
    return [];
  }
}

async function fetchAllProviderProducts(limit = 2000) {
  try {
    if (!db) return [];
    const snapshot = await db.collection('providers-products').orderBy('productTitle').limit(limit).get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('❌ Error consultando providers-products:', error.message);
    return [];
  }
}

// ----------------------------------------------------
// Firestore — find product by normalized name
// ----------------------------------------------------
async function findProductByNormalizedName(name) {
  if (!db) return { productsMarket: [], providersProducts: [] };
  const normalized = normalizeMedicineName(name);
  try {
    const [pmSnap, ppSnap] = await Promise.all([
      db.collection('products-market').get(),
      db.collection('providers-products').get()
    ]);
    const pm = pmSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => {
        const pTitle = normalizeMedicineName(p.ProductTitle || p.productTitle || '');
        return pTitle.includes(normalized) || normalized.includes(pTitle);
      });
    const pp = ppSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => {
        const pTitle = normalizeMedicineName(p.ProductTitle || p.productTitle || '');
        return pTitle.includes(normalized) || normalized.includes(pTitle);
      });
    return { productsMarket: pm, providersProducts: pp };
  } catch (error) {
    console.error('❌ Error en findProductByNormalizedName:', error.message);
    return { productsMarket: [], providersProducts: [] };
  }
}

// ----------------------------------------------------
// Firestore — update user cart
// ----------------------------------------------------
async function updateUserCart(phone, items) {
  if (!db) return;
  try {
    const cartRef = db.collection('user_carts').doc(String(phone));
    await cartRef.set({ items, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } catch (error) {
    console.error('❌ Error actualizando carrito:', error.message);
  }
}

// ----------------------------------------------------
// Firestore — save consultation record
// ----------------------------------------------------
async function saveConsultation({ phone, userName, products, exists }) {
  if (!db) return;
  try {
    await db.collection('consultations').add({
      phone: String(phone || ''),
      userName: String(userName || '').slice(0, 100),
      products: Array.isArray(products) ? products : [],
      exists: Boolean(exists),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('❌ Error guardando consulta:', error.message);
  }
}

// ----------------------------------------------------
// Google Sheets — append
// ----------------------------------------------------
async function appendToSheet({ products, exists, phone, userName }) {
  const sheets = getSheetsClient();
  if (!sheets) return;
  const now = new Date();
  const fecha = now.toLocaleDateString('es-VE');
  const hora = now.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
  const rows = products.map((p) => [fecha, hora, p, exists ? 1 : 0, phone || '', userName || '']);
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB_NAME}!A:F`,
      valueInputOption: 'RAW',
      resource: { values: rows }
    });
    console.log(`📊 Loggeado a Sheets: ${rows.length} fila(s) — existe=${exists}`);
  } catch (error) {
    console.error('❌ Error en Sheets:', error.message);
  }
}

// ----------------------------------------------------
// Catalog search — full pipeline
// ----------------------------------------------------
async function searchAndBuildCatalogResponse({ userQuery, phone, options = {} }) {
  const {
    products: preloadedProducts,
    exchangeRate,
    isCallFromRecipePipeline = false,
    rawOcr = null
  } = options;

  console.log(`🧪 [CATALOG-RESPONSE] userQuery="${userQuery}" isCallFromRecipePipeline=${isCallFromRecipePipeline} rawOcr=${rawOcr ? rawOcr.slice(0, 50) : null}`);

  if (!userQuery && !rawOcr) {
    return null;
  }

  // Use rawOcr as the search query if provided (image input)
  const effectiveQuery = rawOcr || userQuery;

  const results = await searchMedicinesByName(effectiveQuery, {
    products: preloadedProducts,
    exchangeRate,
    isCallFromRecipePipeline,
    ...options
  });

  if (!results || !results.matches || !results.matches.length) {
    return null;
  }

  const session = getSession(phone);

  const responseText = formatCatalogResponse({
    matches: results.matches,
    query: results.query,
    exchangeRate: results.exchangeRate,
    session,
    label: 'medicamentos'
  });

  // Store the latest catalog snapshot both in session and globally (for serverless stateless recovery)
  rememberCatalogSnapshot(session, results.matches, 'medicamentos', responseText);

  // Store globally for stateless recovery
  globalCatalogByPhone.set(phone, {
    options: results.matches,
    query: results.query,
    exchangeRate: results.exchangeRate,
    timestamp: Date.now()
  });

  return {
    text: responseText,
    matches: results.matches,
    query: results.query
  };
}

// ----------------------------------------------------
// Format catalog response (unified — no grouping, global numbering)
// ----------------------------------------------------
function formatCatalogResponse({ matches, query, exchangeRate, session, label = 'resultado' }) {
  const exchangeRate_ = exchangeRate || 1;
  const lines = [];

  lines.push(`🔎 *Búsqueda:* "${query}"\n`);
  lines.push(`📦 *${matches.length} ${matches.length === 1 ? 'opción encontrada' : 'opciones encontradas'}*\n`);

  let globalCounter = 0;

  for (const item of matches) {
    globalCounter++;
    const title = item.title || 'Sin nombre';
    const usd = item.priceUsd != null ? `$${formatPrice(item.priceUsd)}` : 'N/A';
    const bs = item.priceBs != null ? `Bs ${formatPrice(item.priceBs)}` : 'N/A';

    lines.push(`${globalCounter}. *${title}*`);
    lines.push(`   💲 ${usd}  |  Bs ${bs}`);
    lines.push('');
  }

  lines.push('Escribe *LISTO* si ya seleccionaste todo lo que necesitas.');
  return lines.join('\n').trim();
}

// ----------------------------------------------------
// Fuzzy search core
// ----------------------------------------------------
async function searchMedicinesByName(userQuery, options = {}) {
  console.log(`🧪 [SEARCH-KICK] userQuery='${userQuery}' strictConsultationMode=${options.strictConsultationMode} preExtractedMedicines=${JSON.stringify(options.preExtractedMedicines)}`);
  if (!db) return null;

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
    console.log(`🧪 [SEARCH-MAIN] passedDosageSigs=${JSON.stringify(passedDosageSigs)}`);
  }

  const products = options.products ?? await fetchCatalogProducts(2000);
  const catalogHealth = summarizeCatalogHealth(products);
  // TEMP DIAGNOSTIC: check raw Firebase matches for "calaminol"
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
  // Note: "retard"|"retadar"|"retador"|"retardar"|"retardado"|"retardada" are dosage forms but not in the isDosageToken pattern to avoid being stripped

  let exchangeRate = options.exchangeRate;
  if (!exchangeRate) {
    const rate = await getDivisaBs();
    exchangeRate = rate ? Number(rate) : 1;
  }

  const allProviderProducts = options.providerProducts ?? await fetchAllProviderProducts(2000);

  const scored = [];

  // --- Normalize product titles once for efficiency ---
  const productSignals = buildProductSignals(products, allProviderProducts);
  console.log(`🧪 [SEARCH-MAIN] productSignals=${productSignals.length} products=${products.length} providerProducts=${allProviderProducts.length}`);

  // --- Normalize query once ---
  const queryDosageFree = queryTokens.filter((t) => !isDosageToken(t)).join(' ');

  // --- Build normalized query token set for efficient lookup ---
  const queryTokenSet = new Set(queryTokens.map((t) => normalizeText(t)));

  // --- Build a normalized title lookup map for exact matching ---
  const normalizedTitleMap = new Map();
  for (const signal of productSignals) {
    const key = signal.productTitleNorm;
    if (!normalizedTitleMap.has(key)) normalizedTitleMap.set(key, []);
    normalizedTitleMap.get(key).push(signal);
  }

  for (const signal of productSignals) {
    // --- Pre-filter: reject products with no token overlap at all ---
    // This is a cheap first-pass filter to skip products that clearly don't match.
    const overlap = [...signal.normalizedTokens]
      .filter((t) => queryTokenSet.has(t)).length;
    if (overlap === 0) {
      // Special case: single-token query with very high similarity to product title
      // (handles cases where query "lipocut" matches "lipocut 200mg" via JW~0.83)
      if (queryTokens.length === 1 && signal.normalizedTokens.size >= 1) {
        const sim = jaroWinkler(queryTokens[0], [...signal.normalizedTokens][0]);
        if (sim < 0.90) continue; // Only skip if clearly unrelated
      } else {
        continue;
      }
    }

    const { score, matchedTokens, dosageMatches, referenceScore } = computeProductScore({
      signal,
      query,
      queryTokens,
      queryDosageFree,
      matchQuery,
      matchTokens,
      exactQuery,
      exactRoot,
      dosageLessQuery,
      isDosageToken,
      strictReferenceThreshold,
      consultationMode,
      hasPassedDosage,
      passedDosageSigs
    });

    if (score > 0) {
      scored.push({ signal, score, matchedTokens, dosageMatches, referenceScore });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);

  const matches = top.map(({ signal, score, matchedTokens, dosageMatches }) => {
    const providerEntry = signal.providerEntry || null;
    const priceUsd = signal.priceUsd;
    const priceBs = signal.priceBs;

    // Build matchedTokens display string (for debugging)
    const matchedCount = matchedTokens ? matchedTokens.size : 0;
    const dosageCount = dosageMatches ? dosageMatches.length : 0;

    return {
      title: signal.productTitleFull,
      priceUsd,
      priceBs,
      raw: signal,
      score,
      matchedTokens: matchedCount,
      dosageMatches: dosageCount
    };
  });

  if (matches.length === 0) {
    return { query, queryTokens, exchangeRate, matches: [] };
  }

  return { query, queryTokens, exchangeRate, matches };
}

// ----------------------------------------------------
// Build product signals (normalize product data once)
// ----------------------------------------------------
function buildProductSignals(products, allProviderProducts) {
  const signals = [];

  for (const product of products) {
    const productTitleFull = String(product.ProductTitle || product.productTitle || '').trim();
    if (!productTitleFull) continue;

    const normalizedTokens = new Set(
      tokenize(normalizeMedicineName(productTitleFull)).filter((t) => t.length > 1)
    );

    // Build productTitleArray from the product or default to [productTitleFull]
    const productTitleArray = Array.isArray(product.productTitleArray)
      ? product.productTitleArray
      : productTitleFull ? [productTitleFull] : [];

    const priceUsd = product.priceUsd != null ? Number(product.priceUsd) : null;
    const priceBs = product.priceBs != null ? Number(product.priceBs) : null;

    signals.push({
      productTitleFull,
      productTitleNorm: normalizeMedicineName(productTitleFull),
      normalizedTokens,
      productTitleArray,
      priceUsd,
      priceBs,
      providerEntry: product,
      source: 'products-market'
    });
  }

  for (const providerProduct of allProviderProducts) {
    const productTitleFull = String(providerProduct.ProductTitle || providerProduct.productTitle || '').trim();
    if (!productTitleFull) continue;

    // Skip if already in products-market (deduplicate by normalized title)
    const norm = normalizeMedicineName(productTitleFull);
    if (signals.some((s) => s.productTitleNorm === norm)) continue;

    const normalizedTokens = new Set(
      tokenize(normalizeMedicineName(productTitleFull)).filter((t) => t.length > 1)
    );

    const productTitleArray = Array.isArray(providerProduct.productTitleArray)
      ? providerProduct.productTitleArray
      : productTitleFull ? [productTitleFull] : [];

    const priceUsd = providerProduct.priceUsd != null ? Number(providerProduct.priceUsd) : null;
    const priceBs = providerProduct.priceBs != null ? Number(providerProduct.priceBs) : null;

    signals.push({
      productTitleFull,
      productTitleNorm: norm,
      normalizedTokens,
      productTitleArray,
      priceUsd,
      priceBs,
      providerEntry: providerProduct,
      source: 'providers-products'
    });
  }

  return signals;
}

// ----------------------------------------------------
// Compute score for one product
// ----------------------------------------------------
function computeProductScore({
  signal,
  query,
  queryTokens,
  queryDosageFree,
  matchQuery,
  matchTokens,
  exactQuery,
  exactRoot,
  dosageLessQuery,
  isDosageToken,
  strictReferenceThreshold,
  consultationMode,
  hasPassedDosage,
  passedDosageSigs
}) {
  let score = 0;
  const matchedTokens = new Set();
  const dosageMatches = [];

  const normTitle = signal.productTitleNorm;
  const titleTokens = signal.normalizedTokens || new Set();

  // --- Token overlap score ---
  let tokenOverlapCount = 0;
  for (const qt of queryTokens) {
    let bestSim = 0;
    let bestTitleToken = null;
    for (const tt of titleTokens) {
      const sim = jaroWinkler(qt, tt);
      if (sim > bestSim) {
        bestSim = sim;
        bestTitleToken = tt;
      }
    }
    // Lowered threshold: allow matches down to 0.70 for OCR errors
    // But only when the rest of the tokens in the query have some overlap
    const tokenThreshold = 0.70;
    if (bestSim >= 0.95) {
      score += 150;
      matchedTokens.add(qt);
      tokenOverlapCount++;
    } else if (bestSim >= 0.85) {
      score += 100;
      matchedTokens.add(qt);
      tokenOverlapCount++;
    } else if (bestSim >= tokenThreshold) {
      // Partial credit for fuzzy matches in the [0.70, 0.85) range
      score += 60;
      matchedTokens.add(qt);
      tokenOverlapCount++;
    }
  }

  // Normalize by query token count
  const tokenScore = tokenOverlapCount > 0 ? (score * tokenOverlapCount) / queryTokens.length : 0;
  score = tokenScore;

  // --- Exact title match bonus (before dosage stripping) ---
  if (normTitle === queryDosageFree) {
    score += 320;
  }

  // --- Exact root match ---
  const rootTokens = exactRoot.split(' ').filter(Boolean);
  const titleTokenArr = [...titleTokens];
  const rootMatch = rootTokens.every((rt) =>
    titleTokenArr.some((tt) => jaroWinkler(rt, tt) >= 0.88)
  );
  if (rootMatch && rootTokens.length > 0) {
    score += 280;
  }

  // --- Exact query vs full title ---
  if (normTitle.includes(exactQuery) || exactQuery.includes(normTitle)) {
    score += 220;
  }

  // --- Whole-token containment bonus (bounded by word boundaries) ---
  // Only give +320 if the match is a whole-token hit (bounded by word boundaries)
  // This prevents "DORIXINA" from scoring +320 when query="DORIXINA FLEX"
  const queryTokensForBoundCheck = tokenize(matchQuery);
  const productTitleBounded = queryTokensForBoundCheck.some(t =>
    t === normalizeText(signal.productTitleFull) || // exact token match
    matchQuery.includes(signal.productTitleFull) && ( // title is substring of query
      matchQuery.startsWith(signal.productTitleFull + ' ') ||
      matchQuery.endsWith(' ' + signal.productTitleFull) ||
      matchQuery.includes(' ' + signal.productTitleFull + ' ') ||
      matchQuery === signal.productTitleFull
    )
  );
  if (signal.productTitleFull.includes(matchQuery) || productTitleBounded) score += 320;

  // --- Multi-word query match bonus ---
  if (queryTokens.length >= 2) {
    const queryWordSet = new Set(queryTokens);
    const intersection = [...queryWordSet].filter((t) => titleTokens.has(t));
    if (intersection.length === queryTokens.length) {
      score += 200;
    }
  }

  // --- providerProducts secondary source: price from provider entry ---
  const priceUsd = signal.priceUsd;
  const priceBs = signal.priceBs;

  // --- Dosage match scoring ---
  const dosageRegex = /\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|gr|ml|cc|ui|iu|mL)\b/gi;
  const dosageMatchesInQuery = [...queryDosageFree.matchAll(dosageRegex)].map((m) => m[1] + m[2]);
  const dosageMatchesInTitle = [...normTitle.matchAll(dosageRegex)].map((m) => m[1] + m[2]);
  const matchedDosages = dosageMatchesInQuery.filter((dq) =>
    dosageMatchesInTitle.some((dt) => jaroWinkler(dq, dt) >= 0.85)
  );
  if (matchedDosages.length > 0) {
    score += matchedDosages.length * 35;
    dosageMatches.push(...matchedDosages);
  }

  // --- Single-token query: boost products whose first token matches the query ---
  if (queryTokens.length === 1 && titleTokens.size > 0) {
    const firstTitleToken = [...titleTokens][0];
    const sim = jaroWinkler(queryTokens[0], firstTitleToken);
    if (sim >= strictReferenceThreshold) {
      score += 250;
    }
  }

  // --- Reference threshold: penalize products that don't meet minimum similarity ---
  if (queryTokens.length === 1) {
    const sim = jaroWinkler(queryTokens[0], normTitle);
    if (sim < strictReferenceThreshold) {
      score -= 500;
    }
  }

  // --- Strict consultation mode: require strong match ---
  if (consultationMode && tokenOverlapCount === 0) {
    score -= 1000;
  }

  return { score, matchedTokens, dosageMatches, referenceScore: score };
}

// ----------------------------------------------------
// Summarize catalog health
// ----------------------------------------------------
function summarizeCatalogHealth(products) {
  const total = products.length;
  const withPrice = products.filter((p) => p.priceUsd != null || p.priceBs != null).length;
  return { total, available: withPrice };
}

// ----------------------------------------------------
// Route message
// ----------------------------------------------------
async function routeMessage(payload) {
  const node = unwrapMessagePayload(payload);
  if (!node) return;

  const phone = node?.key?.remoteJid || node?.from || node?.phone || '';
  const rawText = node?.message?.conversation || node?.message?.extendedTextMessage?.text || node?.message?.imageMessage?.caption || node?.message?.videoMessage?.caption || '';
  const text = String(rawText || '').trim();
  const fromMe = node?.key?.fromMe || false;
  const messageId = extractMessageId(payload);

  if (!phone || fromMe) return;

  const normalizedFrom = normalizeText(phone);
  const session = getSession(phone);
  session.phone = phone;

  // --- Detect bot control (admin only) ---
  if (isBotControlMessage(text)) {
    if (!isAdminSender(phone)) {
      await sendOutboundWhatsAppMessage(phone, '❌ No tienes permiso para usar este comando.');
      return;
    }
    if (/^bot\s+off$/i.test(text)) {
      botEnabled = false;
      await sendOutboundWhatsAppMessage(phone, '✅ Bot desactivado.');
    } else if (/^bot\s+on$/i.test(text)) {
      botEnabled = true;
      await sendOutboundWhatsAppMessage(phone, '✅ Bot activado.');
    } else if (/^bot\s+status$/i.test(text)) {
      await sendOutboundWhatsAppMessage(phone, `✅ Estado del bot: *${botEnabled ? 'ACTIVO' : 'INACTIVO'}*`);
    }
    return;
  }

  if (!botEnabled) {
    console.log('🔇 Bot desactivado — ignorando mensaje');
    return;
  }

  // --- Duplicate check ---
  if (isDuplicateInboundMessage(payload, phone, text)) {
    console.log('🔁 Mensaje duplicado — ignorando');
    return;
  }

  console.log(`📩 [INBOUND] from=${phone} text="${text}" mode=${session.mode} humanHandoff=${session.humanHandoff}`);

  // --- Human handoff: forward to human and stop ---
  if (session.humanHandoff) {
    console.log('🙋 Modo handoff activo — ignorando обработку бота');
    return;
  }

  // --- LISTO / RESUMEN ---
  if (normalizeText(text) === 'listo' || normalizeText(text) === 'resumen') {
    const summary = buildSelectedProductsSummary(session);
    await sendOutboundWhatsAppMessage(phone, summary);
    return;
  }

  // --- Previous catalog request ---
  if (isPreviousCatalogRequest(text)) {
    const prev = getPreviousCatalogSnapshot(session);
    if (!prev) {
      await sendOutboundWhatsAppMessage(phone, '📭 No hay resultados anteriores para mostrar.');
      return;
    }
    const prevText = formatCatalogResponse({
      matches: prev.options,
      query: prev.label,
      exchangeRate: 1,
      session,
      label: prev.label
    });
    await sendOutboundWhatsAppMessage(phone, prevText);
    return;
  }

  // --- Selection intent ---
  if (isSelectionIntent(text)) {
    const parsed = parseSelectionCommand(text);
    if (parsed) {
      const { results, selected } = resolveSelectionByHistory(session, parsed.option);
      if (!results.length) {
        await sendOutboundWhatsAppMessage(phone, '⚠️ No hay resultados activos para seleccionar. Realiza una búsqueda primero.');
        return;
      }
      if (!selected) {
        await sendOutboundWhatsAppMessage(phone, `⚠️ La opción ${parsed.option} no existe. Hay ${results.length} opción(es) disponible(s).`);
        return;
      }
      addItemToCart(session, selected, parsed.quantity);
      pushSelectionHistory(session, selected, parsed.quantity);
      await sendOutboundWhatsAppMessage(phone, formatSelectionSavedMessage(selected, parsed.quantity, session));
      return;
    }
  }

  // --- /start ---
  if (normalizeText(text) === 'start' || normalizeText(text) === '/start') {
    await sendOutboundWhatsAppMessage(phone, '👋 ¡Hola! Soy el asistente de Gentefarma. ¿En qué puedo ayudarte hoy?');
    return;
  }

  // --- /menu ---
  if (normalizeText(text) === 'menu' || normalizeText(text) === '/menu') {
    await sendOutboundWhatsAppMessage(phone, '📋 *Menú de opciones:*\n\n1. 🔍 Buscar medicamento\n2. 🛒 Ver carrito\n3. 📞 Contactar a un collaborator\n\nEscribe el número o el nombre de la opción.');
    return;
  }

  // --- Human handoff request ---
  if (isHumanRequest(text)) {
    enableHumanHandoff(session);
    await sendOutboundWhatsAppMessage(phone, '🙋 Un collaborator se pondrá en contacto contigo pronto. Gracias por tu paciencia.');
    return;
  }

  // --- Admin commands ---
  if (isAdminSender(phone)) {
    if (normalizeText(text) === 'reset session') {
      resetSession(phone);
      await sendOutboundWhatsAppMessage(phone, '🔄 Sesión reiniciada.');
      return;
    }
    if (normalizeText(text) === 'debug session') {
      const sessionData = getSession(phone);
      await sendOutboundWhatsAppMessage(phone, `🔍 Debug:\n\`\`\`\n${JSON.stringify(sessionData, null, 2)}\n\`\`\``);
      return;
    }
    if (normalizeText(text).startsWith('broadcast ')) {
      const broadcastText = text.slice(10).trim();
      console.log(`📢 Broadcast: ${broadcastText}`);
      await sendOutboundWhatsAppMessage(phone, `📢 Broadcast guardado: "${broadcastText}"`);
      return;
    }
  }

  // --- Image / media ---
  const hasMedia = node?.message?.imageMessage || node?.message?.videoMessage;
  if (hasMedia) {
    await handleIncomingMedia(node, session);
    return;
  }

  // --- Text-based flows ---

  // Greeting
  if (isGreetingOrMenu(text)) {
    await sendOutboundWhatsAppMessage(phone, '👋 ¡Hola! Soy el asistente de Gentefarma. ¿En qué puedo ayudarte hoy?\n\nPuedes escribir el nombre de un medicamento para consultar su precio y disponibilidad.');
    return;
  }

  // Thanks
  if (isThanksMessage(text)) {
    await sendOutboundWhatsAppMessage(phone, '😊 ¡De nada! Estoy aquí para ayudarte. ¿Necesitas algo más?');
    return;
  }

  // Medicine consultation (consultation intent + looks like medicine name)
  if (looksLikeMedicineName(text)) {
    await handleMedicineConsultation({ text, phone, session, isCallFromRecipePipeline: false });
    return;
  }

  // Default: suggest search
  if (text.length > 0) {
    const extracted = extractMedicineQuery(text);
    if (extracted && extracted.length >= 3) {
      await handleMedicineConsultation({ text, phone, session, isCallFromRecipePipeline: false });
      return;
    }
    await sendOutboundWhatsAppMessage(phone, '🤖 No estoy seguro de entender. ¿Podrías escribir el nombre de un medicamento?\n\nPor ejemplo: "Dolocyl 500 mg" o "Paracetamol"');
    return;
  }
}

// ----------------------------------------------------
// Handle incoming media (image/video with caption)
// ----------------------------------------------------
async function handleIncomingMedia(node, session) {
  const phone = node?.key?.remoteJid || '';
  const caption = node?.message?.imageMessage?.caption || node?.message?.videoMessage?.caption || '';
  const mediaUrl = node?.message?.imageMessage?.url || node?.message?.videoMessage?.url || '';

  console.log(`🖼️ [MEDIA-IN] phone=${phone} caption="${caption}" mediaUrl=${mediaUrl ? 'present' : 'missing'}`);

  if (!mediaUrl && !caption) {
    await sendOutboundWhatsAppMessage(phone, '📷 No pude obtener la imagen. ¿Podrías enviarla de nuevo?');
    return;
  }

  let imagePath = null;
  if (mediaUrl) {
    imagePath = await downloadMedia(mediaUrl, 'inbound_media');
    if (!imagePath) {
      console.warn('⚠️ No se pudo descargar media, usando caption como texto');
    }
  }

  // Determine the text to search: caption > OCR of image
  let searchText = caption.trim();
  let ocrText = null;

  if (imagePath && !searchText) {
    console.log(`🔍 [MEDIA-OCR] Running OCR on ${imagePath}`);
    ocrText = await extractTextFromImageOcr(`file://${imagePath}`);
    if (ocrText && ocrText !== 'NO ENCONTRADO' && ocrText.length > 3) {
      searchText = ocrText;
      console.log(`✅ [MEDIA-OCR] Using OCR text: "${searchText.slice(0, 100)}"`);
    } else {
      console.log(`⚠️ [MEDIA-OCR] OCR returned empty or NO_ENCONTRADO`);
    }
  }

  if (!searchText) {
    await sendOutboundWhatsAppMessage(phone, '🤖 No pude leer medicamentos en la imagen. ¿Podrías escribir el nombre del medicamento?');
    return;
  }

  // Try to detect if it's a recipe (multiple medicines) or single product
  const isRecipe = isLikelyRecipeMedicineCandidate(searchText);

  if (isRecipe) {
    console.log(`📋 [MEDIA] Detected recipe-like image, processing as recipe`);
    // Treat as recipe — extract all medicine names
    const medicineLines = extractRecipeMedicineLines(searchText);
    if (!medicineLines || !medicineLines.length) {
      console.log(`⚠️ [MEDIA] No medicine lines extracted, falling back to single-medicine search`);
      await handleMedicineConsultation({
        text: searchText,
        phone,
        session,
        isCallFromRecipePipeline: false,
        rawOcr: searchText
      });
      return;
    }

    // Process each medicine
    const preloadedProducts = await fetchCatalogProducts(2000);
    const preloadedProviders = await fetchAllProviderProducts(2000);
    const rate = await getDivisaBs();
    const exchangeRate = rate ? Number(rate) : 1;

    for (const medicineName of medicineLines) {
      console.log(`🧪 [MEDIA-RECIPE] Processing medicine: "${medicineName}"`);
      await handleMedicineConsultation({
        text: medicineName,
        phone,
        session,
        isCallFromRecipePipeline: true,
        preloadedProducts,
        preloadedProviderProducts: preloadedProviders,
        exchangeRate
      });
    }
    return;
  }

  // Single medicine
  await handleMedicineConsultation({
    text: searchText,
    phone,
    session,
    isCallFromRecipePipeline: false,
    rawOcr: searchText
  });
}

// ----------------------------------------------------
// Handle medicine consultation
// ----------------------------------------------------
async function handleMedicineConsultation({ text, phone, session, isCallFromRecipePipeline = false, rawOcr = null, preloadedProducts = null, preloadedProviderProducts = null, exchangeRate = null }) {
  console.log(`🧪 [CONSULT] text="${text}" isCallFromRecipePipeline=${isCallFromRecipePipeline} rawOcr=${rawOcr ? rawOcr.slice(0, 30) : null}`);

  // 1. Determine the query to search
  const primaryQuery = extractStrictConsultationMedicineQuery(text);
  if (!primaryQuery) {
    console.log(`⚠️ [CONSULT] No medicine query extracted from "${text}", skipping`);
    if (!isCallFromRecipePipeline) {
      await sendOutboundWhatsAppMessage(phone, '🤖 No pude identificar el medicamento. ¿Podrías escribir el nombre con más claridad?\n\nEjemplo: "Paracetamol 500 mg"');
    }
    return;
  }

  // 2. Build options
  const options = {
    strictConsultationMode: !isCallFromRecipePipeline,
    products: preloadedProducts,
    providerProducts: preloadedProviderProducts,
    exchangeRate,
    rawOcr
  };

  // 3. Search
  const result = await searchAndBuildCatalogResponse({
    userQuery: primaryQuery,
    phone,
    options
  });

  if (!result) {
    console.log(`⚠️ [CONSULT] No results for "${primaryQuery}"`);
    if (!isCallFromRecipePipeline) {
      await sendOutboundWhatsAppMessage(phone, `🤖 No encontré "${primaryQuery}" en el catálogo.\n\n¿Podrías verificar el nombre o escribirlo de otra forma?`);
    }
    return;
  }

  // 4. Send result
  session.lastSearch = result;
  clearPendingSearch(session);

  await sendOutboundWhatsAppMessage(phone, result.text);

  // 5. Log
  if (!isCallFromRecipePipeline) {
    const productNames = result.matches.map((m) => m.title);
    await Promise.all([
      saveConsultation({ phone, userName: '', products: productNames, exists: true }),
      appendConsultationToSheet({ products: productNames, exists: true, phone, userName: '' })
    ]);
  }
}

// ----------------------------------------------------
// Recipe line extraction
// ----------------------------------------------------
function extractRecipeMedicineLines(raw) {
  const STOPWORDS_MEDICINE = new Set([
    'de','la','que','el','en','y','a','los','del','se','las','por','un','para','con','no','una','su','al','lo','como','más','pero','sus','le','ya','o','este','sí','porque','esta','entre','cuando','muy','sin','sobre','también','me','hasta','hay','donde','quien','desde','todo','nos','durante','todos','uno','les','ni','contra','otros','ese','eso','ante','ellos','e','esto','mí','antes','algunos','qué','unos','yo','otro','otras','otra','él','tanto','esa','estos','mucho','quienes','nada','muchos','cual','poco','ella','estar','estas','algunas','algo','nosotros','mi','mis','tú','te','ti','tu','tus','ellas','nosotras','vosotros','vosotras','os','mío','mía','míos','mías','tuyo','tuya','tuyos','tuyas','suyo','suya','suyos','suyas','nuestro','nuestra','nuestros','nuestras','vuestro','vuestra','vuestros','vuestras','esos','esas','estoy','estás','está','estamos','estáis','están','esté','estés','estemos','estéis','estén','estaré','estarás','estará','estaremos','estaréis','estarán','estaría','estarías','estaríamos','estaríais','estarían','estaba','estabas','estábamos','estabais','estaban','estuve','estuviste','estuvo','estuvimos','estuvisteis','estuvieron','estuviera','estuvieras','estuviéramos','estuvierais','estuvieran','estuviese','estuvieses','estuviésemos','estuvieseis','estuviesen','estando','estado','estada','estados','estadas','estad','he','has','ha','hemos','habéis','han','haya','hayas','hayamos','hayáis','hayan','habré','habrás','habrá','habremos','habréis','habrán','habría','habrías','habríamos','habríais','habrían','había','habías','habíamos','habíais','habían','hube','hubiste','hubo','hubimos','hubisteis','hubieron','hubiera','hubieras','hubiéramos','hubierais','hubieran','hubiese','hubieses','hubiésemos','hubieseis','hubiesen','habiendo','habido','habida','habidos','habidas','soy','eres','es','somos','sois','son','sea','seas','seamos','seáis','sean','seré','serás','será','seremos','seréis','serán','sería','serías','seríamos','seríais','serían','era','eras','éramos','erais','eran','fui','fuiste','fue','fuimos','fuisteis','fueron','fuera','fueras','fuéramos','fuerais','fueran','fuese','fueses','fuésemos','fueseis','fuesen','siendo','sido','tengo','tienes','tiene','tenemos','tenéis','tienen','tenga','tengas','tengamos','tengáis','tengan','tendré','tendrás','tendrá','tendremos','tendréis','tendrán','tendría','tendrías','tendríamos','tendríais','tendrían','tenía','tenías','teníamos','teníais','tenían','tuve','tuviste','tuvo','tuvimos','tuvisteis','tuvieron','tuviera','tuvieras','tuviéramos','tuvierais','tuvieran','tuviese','tuvieses','tuviésemos','tuvieseis','tuviesen','teniendo','tenido','tenida','tenidos','tenidas','tened',
    // Excluded medicine name fragments that are not actual brand names:
    'mg','mcg','g','gr','ml','cc','ui','iu','tab','tabs','tabletas','capsulas','capsulas','capsules','cap','caps','ampollas','ampolla','susp','suspension','jarabe','gotas','crema','gel','polvo','polvos','unguento','sobres','sobresa','retad','retadar','retard','retardar','retardado','retardada',
    // Common verbs and filler words
    'cada','dia','dias','día','días','vez','veces','antes','después','durante','juntos','juntas','adulto','adultos','adulta','adultas','niño','niños','niña','niñas','bebe','bebes','bebé','bebés','indicaciones','posologia','posología','contraindicaciones','efectos','adversos','adverso','presentacion','presentación','contenido','contenido','cantidad','instrucciones','instrucción','modo','uso','administracion','administración','tratamiento','receta','nombre','apellido','ci','cedula','cédula','edad','peso','talla','sexo','sangre','orina','hipertension','hipertensión','diabetes','asma','alergia','alergias','embarazo','lactancia','hepatico','hepática','renal','cardiaco','cardíaco','precaucion','precaución','advertencia','interaccion','interacción'
  ]);

  const value = String(raw || '').trim();
  if (!value) return [];

  // Split on newlines first, then on numbered patterns
  const lines = value.split(/\n/).map(l => l.trim()).filter(Boolean);

  // Also try to split on patterns like "1. " or "1)" or "- " that indicate multiple items
  const additionalLines = [];
  const numberPattern = /(?:^|\n)(\d+)[.)]\s*(.+)/g;
  let match;
  while ((match = numberPattern.exec(value)) !== null) {
    const line = match[2].trim();
    if (line) additionalLines.push(line);
  }

  // Combine unique lines
  const allLines = [...new Set([...lines, ...additionalLines])];

  const refinedLines = [];
  let i = 0;

  while (i < allLines.length) {
    let line = allLines[i].trim();
    if (!line) { i++; continue; }

    // Strip leading bullet points, numbers, etc.
    line = line.replace(/^[-•·]\s*/, '').replace(/^\d+[.)]\s*/, '').trim();
    if (!line) { i++; continue; }

    // Extract medicine name from line (handle dosage first)
    // e.g. "DAFLON 500 MG" -> ["DAFLON", "500 MG"]
    const dosagePattern = /^([A-ZÁÉÍÓÚÑ0-9\s-]+?)\s*(\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|TAB|CAP|AMP|TABS|CAPS|AMPS)\b.*)$/i;
    const dosageMatch = line.match(dosagePattern);
    let medicineName;
    let dosagePart;

    if (dosageMatch) {
      medicineName = dosageMatch[1].trim();
      dosagePart = dosageMatch[2].trim();
    } else {
      // Try comma or parenthesis split
      const parts = line.split(/[,;(]/).map(p => p.trim()).filter(Boolean);
      medicineName = parts[0] || line;
      dosagePart = parts.slice(1).join(' ');
    }

    // Normalize medicine name
    const normalizedName = normalizeText(medicineName);
    const tokens = normalizedName.split(/\s+/).filter(Boolean);

    // Reject lines with no meaningful tokens (e.g. just "500 mg")
    if (tokens.length === 0) { i++; continue; }

    // Reject if the line is mostly a dosage (e.g. "500 mg")
    const pureDosagePattern = /^\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|cc|ui|iu|mL|TAB|CAP|AMP|TABS|CAPS|AMPS)?$/i;
    if (pureDosagePattern.test(normalizedName)) { i++; continue; }

    // Reject if the line has too few characters to be a medicine name
    if (medicineName.length < 3) { i++; continue; }

    // Reject if the line contains common non-medicine words
    const nonMedicinePatterns = [
      /^(receta|médica|receta\s+médica|fecha|doctor|dr|dra|paciente|nombre|apellido|edad|peso|talla|sexo|ci|cedula|diagnostico|diagnóstico|tratamiento|indicaciones|posología|contraindicaciones|efectos\s+adversos)$/i,
      /^(hospital|clínica|clínica|consultorio|urgencias|emergencias)$/i
    ];
    if (nonMedicinePatterns.some(p => p.test(medicineName))) { i++; continue; }

    // Build final medicine string: name + dosage (if available)
    let finalText = medicineName;
    if (dosagePart) {
      finalText = `${medicineName} ${dosagePart}`;
    }

    refinedLines.push(finalText);
    i++;
  }

  // Post-process: merge dosage lines with medicine names
  const mergedLines = [];
  for (let i = 0; i < refinedLines.length; i++) {
    const line = refinedLines[i];
    const nextLine = refinedLines[i + 1];

    // If current line is just a dosage and next line is a medicine name, swap
    if (nextLine && pureDosagePattern.test(normalizeText(line)) && !pureDosagePattern.test(normalizeText(nextLine))) {
      mergedLines.push(`${nextLine} ${line}`);
      i++; // Skip next line since we merged it
    } else {
      mergedLines.push(line);
    }
  }

  return [...new Set(mergedLines)];
}

function pureDosagePattern(text) {
  return /^\d+(?:[.,]\d+)?\s*(mg|mcg|g|gr|ml|cc|ui|iu|mL|TAB|CAP|AMP|TABS|CAPS|AMPS)?$/i.test(text);
}

// ----------------------------------------------------
// Express routes
// ----------------------------------------------------
app.get('/', (req, res) => {
  res.send('✅ Gentefarma Webhook is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', botEnabled, sessions: sessions.size });
});

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let payload;
    try {
      payload = JSON.parse(req.body);
    } catch {
      payload = typeof req.body === 'object' ? req.body : {};
    }
    console.log(`📨 [WEBHOOK] POST /webhook received`);
    await routeMessage(payload);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Error en /webhook:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/webhook/instance/connect', async (req, res) => {
  try {
    console.log('🔗 Instance connect event received');
    res.status(200).json({ status: 'connected' });
  } catch (error) {
    console.error('❌ Error en /webhook/instance/connect:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/webhook/events', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    let payload;
    try {
      payload = JSON.parse(req.body);
    } catch {
      payload = typeof req.body === 'object' ? req.body : {};
    }
    console.log(`📨 [EVENTS] POST /webhook/events`);
    await routeMessage(payload);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('❌ Error en /webhook/events:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/send/text', async (req, res) => {
  try {
    const { number, text } = req.body;
    if (!number || !text) {
      return res.status(400).json({ error: 'number and text are required' });
    }
    await sendOutboundWhatsAppMessage(number, text);
    res.json({ status: 'sent' });
  } catch (error) {
    console.error('❌ Error en /send/text:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send/media', async (req, res) => {
  try {
    const { number, mediaUrl, caption } = req.body;
    if (!number || !mediaUrl) {
      return res.status(400).json({ error: 'number and mediaUrl are required' });
    }
    const response = await axios.post(
      `${EVOLUTION_API_URL}/send/media`,
      { number, mediaUrl, caption: caption || '' },
      { headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY }, timeout: 30000 }
    );
    res.json(response.data);
  } catch (error) {
    console.error('❌ Error en /send/media:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ----------------------------------------------------
// Process incoming messages (from other endpoints)
// ----------------------------------------------------
async function processIncomingMessage(payload) {
  await routeMessage(payload);
}

// ----------------------------------------------------
// Bot status
// ----------------------------------------------------
app.get('/bot/status', (req, res) => {
  res.json({ botEnabled, sessions: sessions.size });
});

app.post('/bot/enable', (req, res) => {
  botEnabled = true;
  res.json({ status: 'enabled' });
});

app.post('/bot/disable', (req, res) => {
  botEnabled = false;
  res.json({ status: 'disabled' });
});

// ----------------------------------------------------
// Error handlers
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
