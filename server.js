require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';
const PORT = process.env.PORT || 3000;

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

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      mode: 'idle',
      lastSearch: null,
      pendingOrder: null,
      updatedAt: Date.now()
    });
  }
  return sessions.get(phone);
}

function resetSession(phone) {
  sessions.set(phone, {
    mode: 'idle',
    lastSearch: null,
    pendingOrder: null,
    updatedAt: Date.now()
  });
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

    const session = getSession(from);
    session.updatedAt = Date.now();

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

// ----------------------------------------------------
// Conversation router
// ----------------------------------------------------
async function routeMessage(phone, text, session) {
  const normalized = normalizeText(text);

  // 1) Human handoff
  if (isHumanRequest(normalized)) {
    resetSession(phone);
    return buildHumanAgentMessage();
  }

  // 2) Menu / greetings
  if (isGreetingOrMenu(normalized)) {
    session.mode = 'idle';
    return buildMenuMessage();
  }

  // 3) Menu options
  if (isMenuOption(normalized)) {
    return await handleMenuOption(phone, normalized, session);
  }

  // 4) Order flow: quantity
  if (session.mode === 'awaiting_quantity') {
    const qty = parsePositiveInteger(normalized);
    if (!qty) {
      return '⚠️ Indícame una cantidad válida, por favor. Ejemplo: *2*';
    }

    session.pendingOrder.quantity = qty;
    session.mode = 'awaiting_address';
    session.updatedAt = Date.now();

    return `📍 Perfecto. Ahora envíame tu *dirección de entrega* para continuar con el pedido de:\n\n*${session.pendingOrder.productName}*\nCantidad: *${qty}*`;
  }

  // 5) Order flow: address
  if (session.mode === 'awaiting_address') {
    const address = text.trim();
    if (address.length < 6) {
      return '⚠️ La dirección parece muy corta. Envíamela un poco más detallada, por favor.';
    }

    const orderSummary = await createOrderFromSession(phone, address, session.pendingOrder);
    resetSession(phone);
    return orderSummary;
  }

  // 6) Awaiting product name / clarification
  if (session.mode === 'awaiting_product_name') {
    return await searchAndBuildCatalogResponse(text, session);
  }

  // 7) Order intent
  if (isOrderRequest(normalized)) {
    const searchResult = await searchMedicinesByName(text);

    if (!searchResult) {
      session.mode = 'awaiting_product_name';
      return '🛒 Claro. ¿Qué medicamento deseas pedir? Escríbeme el nombre del medicamento.';
    }

    if (searchResult.needsClarification) {
      session.mode = 'awaiting_product_name';
      return searchResult.clarificationText;
    }

    session.lastSearch = searchResult;
    session.pendingOrder = {
      productName: searchResult.bestProductName,
      bestPrice: searchResult.bestPrice,
      bestProviderName: searchResult.bestProviderName,
      bestProviderId: searchResult.bestProviderId,
      otherProviders: searchResult.otherProviders,
      matchedProduct: searchResult.bestProductName,
      quantity: 1
    };
    session.mode = 'awaiting_quantity';
    session.updatedAt = Date.now();

    return buildCatalogResponse(searchResult) + '\n\n🛒 Si deseas pedirlo, respóndeme con la cantidad.';
  }

  // 8) Product search / price inquiry
  if (isProductSearchRequest(normalized) || looksLikeMedicineName(normalized)) {
    return await searchAndBuildCatalogResponse(text, session);
  }

  // 9) Default fallback
  return buildMenuMessage();
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

async function handleMenuOption(phone, option, session) {
  switch (option) {
    case '1':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '💊 Escribe el nombre del medicamento que deseas buscar.\n\nEjemplo: *atamel forte*';

    case '2':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🏷️ Escribe el nombre del medicamento para ver el mejor precio.\n\nEjemplo: *ibuprofeno*';

    case '3':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🛒 Escribe el nombre del medicamento que deseas pedir.\n\nEjemplo: *amoxicilina 500 mg suspensión*';

    case '4':
      resetSession(phone);
      return buildHumanAgentMessage();

    default:
      return buildMenuMessage();
  }
}

function buildMenuMessage() {
  return `🏥 *GENTEFARMA*\n\nHola, soy tu asistente virtual.\n\nResponde con una opción:\n\n1️⃣ Buscar un medicamento\n2️⃣ Ver mejor precio\n3️⃣ Hacer un pedido\n4️⃣ Hablar con un humano\n\nO escríbeme directamente el nombre del medicamento.\n\nEjemplos:\n• *atamel forte*\n• *amoxicilina 500 mg*\n• *diclofenac ampollas*`;
}

function buildHumanAgentMessage() {
  return `👤 *Te voy a pasar con un asesor*\n\nUn agente de Gentefarma te atenderá en breve.\n\nMientras tanto, si quieres, puedo ayudarte a buscar un medicamento, ver su mejor precio o iniciar un pedido.`;
}

function buildOrderConfirmationMessage(orderId, orderData) {
  return `✅ *Pedido registrado correctamente*\n\n*ID:* ${orderId}\n*Producto:* ${orderData.productName}\n*Cantidad:* ${orderData.quantity}\n*Precio unitario:* $${formatPrice(orderData.unitPrice)}\n*Total estimado:* $${formatPrice(orderData.total)}\n\n📍 Dirección:\n${orderData.deliveryAddress}\n\nUn asesor revisará tu pedido y te contactará si hace falta confirmar algo.`;
}

// ----------------------------------------------------
// Catalog search
// ----------------------------------------------------
async function searchAndBuildCatalogResponse(text, session) {
  if (!db) {
    return '⚠️ No tengo conexión al catálogo en este momento. Intenta de nuevo más tarde.';
  }

  const result = await searchMedicinesByName(text);

  if (!result) {
    session.mode = 'awaiting_product_name';
    return `⚠️ No encontré coincidencias para *${text.trim()}*.\n\nIntenta con el nombre del medicamento.\nEjemplos:\n• *atamel forte*\n• *histaler ped*\n• *desloratadina*\n• *ibuprofeno 400*`;
  }

  if (result.needsClarification) {
    session.mode = 'awaiting_product_name';
    return result.clarificationText;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  session.updatedAt = Date.now();

  return buildCatalogResponse(result) + '\n\nSi quieres, responde *PEDIR* para iniciar un pedido.';
}

async function searchMedicinesByName(userQuery) {
  if (!db) return null;

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!queryTokens.length) return null;

  const products = await fetchCollectionDocuments('products-market', 1000);
  const providers = await fetchCollectionDocuments('providers-products', 2000);

  const scoredProducts = products
    .map((doc) => {
      const searchableText = normalizeText(buildProductSearchText(doc));
      const score = computeMatchScore(query, queryTokens, searchableText, doc);
      return {
        doc,
        score,
        price: getPrice(doc)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priceA = a.price ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.price ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  if (!scoredProducts.length) return null;

  const top = scoredProducts[0];
  const second = scoredProducts[1];

  const hasSpecificForm = hasDosageSpecificity(query);
  if (!hasSpecificForm && second && second.score >= top.score - 5 && top.score < 35) {
    const options = scoredProducts.slice(0, 3).map((item, index) => {
      const label = buildShortProductLabel(item.doc);
      const price = item.price;
      return `${index + 1}. ${label}${price !== null ? ` - $${formatPrice(price)}` : ''}`;
    });

    return {
      needsClarification: true,
      clarificationText:
        `Encontré varias coincidencias parecidas. ¿Cuál buscas?\n\n${options.join('\n')}\n\nResponde con el número o escríbeme el nombre exacto.`,
      candidates: scoredProducts.slice(0, 3).map((item) => item.doc)
    };
  }

  const bestProduct = top.doc;
  const bestProductName = buildShortProductLabel(bestProduct);
  const bestPrice = getPrice(bestProduct);
  const bestProviderName = buildProviderName(bestProduct);
  const bestProviderId = buildProviderId(bestProduct);

  const matchingProviders = providers
    .map((doc) => {
      const searchableText = normalizeText(buildProviderSearchText(doc));
      const score = computeProviderMatchScore(query, queryTokens, searchableText, doc, bestProductName);
      return {
        doc,
        score,
        price: getPrice(doc)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priceA = a.price ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.price ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  const otherProviders = matchingProviders
    .map((item) => item.doc)
    .filter((doc) => {
      const providerName = buildProviderName(doc);
      const providerId = buildProviderId(doc);

      if (bestProviderId && providerId && providerId === bestProviderId) return false;
      if (bestProviderName && providerName && normalizeText(providerName) === normalizeText(bestProviderName)) return false;
      return true;
    });

  return {
    needsClarification: false,
    bestProductName,
    bestPrice,
    bestProviderName,
    bestProviderId,
    otherProviders,
    product: bestProduct,
    matches: scoredProducts.slice(0, 5).map((item) => item.doc)
  };
}

function buildCatalogResponse(result) {
  if (!result || result.needsClarification) {
    return result?.clarificationText || '⚠️ Necesito un poco más de detalle para ayudarte.';
  }

  const lines = [];
  lines.push(`💊 *${result.bestProductName}*`);

  if (result.bestPrice !== null && result.bestPrice !== undefined) {
    lines.push(`🏷️ Mejor precio: *$${formatPrice(result.bestPrice)}*`);
  } else {
    lines.push('🏷️ Mejor precio: *No disponible*');
  }

  if (result.otherProviders && result.otherProviders.length) {
    lines.push('');
    lines.push('🏥 Otras farmacias que también lo tienen:');

    result.otherProviders.slice(0, 5).forEach((doc) => {
      const providerName = buildProviderName(doc) || 'Farmacia';
      const price = getPrice(doc);
      const availability = buildAvailabilityText(doc);

      lines.push(`• ${providerName}${price !== null ? ` - $${formatPrice(price)}` : ''}${availability ? ` (${availability})` : ''}`);
    });
  } else {
    lines.push('');
    lines.push('ℹ️ No encontré otras farmacias con este mismo medicamento.');
  }

  return lines.join('\n');
}

function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;
  if (!docText) return 0;

  const productName = normalizeText(buildShortProductLabel(doc));
  const titleArrayText = Array.isArray(doc?.productTitleArray)
    ? normalizeText(doc.productTitleArray.join(' '))
    : '';
  const activeIngredient = normalizeText(doc?.activeIngredient || doc?.ingredient || doc?.principle || '');
  const brand = normalizeText(doc?.brand || doc?.commercialName || '');
  const description = normalizeText(doc?.description || '');
  const presentation = normalizeText(buildDosageForm(doc));
  const strength = normalizeText(buildStrength(doc));

  if (docText.includes(query)) score += 60;

  for (const token of queryTokens) {
    if (docText.includes(token)) score += 12;
    if (productName.includes(token)) score += 15;
    if (titleArrayText.includes(token)) score += 14;
    if (activeIngredient.includes(token)) score += 10;
    if (brand.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
  }

  if (productName && query.includes(productName)) score += 25;
  if (queryTokens.some((t) => productName.includes(t))) score += 15;
  if (queryTokens.some((t) => titleArrayText.includes(t))) score += 18;
  if (queryTokens.some((t) => activeIngredient.includes(t))) score += 10;
  if (queryTokens.some((t) => brand.includes(t))) score += 8;

  if (presentation && query.includes(presentation)) score += 8;
  if (strength && query.includes(strength)) score += 8;

  return score;
}

function computeProviderMatchScore(query, queryTokens, docText, doc, productNameHint) {
  let score = 0;
  if (!docText) return 0;

  const providerName = normalizeText(buildProviderName(doc));
  const providerProductName = normalizeText(buildShortProductLabel(doc));

  if (docText.includes(query)) score += 30;

  for (const token of queryTokens) {
    if (docText.includes(token)) score += 6;
    if (providerName.includes(token)) score += 6;
    if (providerProductName.includes(token)) score += 8;
  }

  if (productNameHint) {
    const hint = normalizeText(productNameHint);
    if (hint && docText.includes(hint)) score += 20;
  }

  return score;
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

function buildProviderSearchText(doc) {
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
    doc?.keywords,
    doc?.ProviderName,
    doc?.providerName,
    doc?.pharmacyName,
    doc?.storeName,
    doc?.ProviderCity,
    doc?.providerCity,
    doc?.city
  ]
    .flat()
    .filter(Boolean)
    .join(' ');
}

function buildProviderName(doc) {
  return (
    doc?.ProviderName ||
    doc?.providerName ||
    doc?.pharmacyName ||
    doc?.storeName ||
    doc?.name ||
    doc?.company ||
    ''
  );
}

function buildProviderId(doc) {
  return (
    doc?.ProviderId ||
    doc?.providerId ||
    doc?.pharmacyId ||
    doc?.storeId ||
    doc?.id ||
    ''
  );
}

function buildAvailabilityText(doc) {
  if (doc?.availability !== undefined && doc?.availability !== null) {
    return String(doc.availability);
  }
  if (doc?.stock !== undefined && doc?.stock !== null) {
    return `stock ${doc.stock}`;
  }
  if (doc?.inStock !== undefined && doc?.inStock !== null) {
    return doc.inStock ? 'disponible' : 'sin stock';
  }
  return '';
}

function buildDosageForm(doc) {
  return doc?.form || doc?.dosageForm || doc?.presentationForm || doc?.presentation || '';
}

function buildStrength(doc) {
  return doc?.strength || doc?.concentration || doc?.dosage || doc?.dose || '';
}

function getPrice(doc) {
  const raw =
    doc?.price ??
    doc?.Price ??
    doc?.bestPrice ??
    doc?.BestPrice ??
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

function formatPrice(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
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

// ----------------------------------------------------
// WhatsApp send via Evolution GO
// ----------------------------------------------------
async function sendWhatsAppMessage(phone, text) {
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
function extractFrom(payload) {
  const jid =
    payload?.Info?.Sender ||
    payload?.Info?.Chat ||
    payload?.Sender ||
    payload?.sender ||
    payload?.from ||
    payload?.key?.remoteJid ||
    '';

  return String(jid)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/:\d+$/, '')
    .trim();
}

function extractBody(payload) {
  return (
    payload?.Message?.conversation ||
    payload?.Message?.extendedTextMessage?.text ||
    payload?.Message?.text ||
    payload?.body ||
    payload?.text ||
    payload?.data?.body ||
    payload?.data?.text ||
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

function isGreetingOrMenu(value) {
  const text = normalizeText(value);
  return (
    text === 'hola' ||
    text === 'buenos dias' ||
    text === 'buenas tardes' ||
    text === 'buenas noches' ||
    text === 'menu' ||
    text === 'menu' ||
    text === 'ayuda' ||
    /^(hola|menu|menú|ayuda)\b/.test(text)
  );
}

function isHumanRequest(value) {
  const text = normalizeText(value);
  return /\b(humano|agente|asesor|persona|operador|atencion humana|atencion al cliente)\b/.test(text);
}

function isOrderRequest(value) {
  const text = normalizeText(value);
  return /\b(pedir|pedido|comprar|ordenar|encargar|solicitar)\b/.test(text);
}

function isProductSearchRequest(value) {
  const text = normalizeText(value);
  return /\b(precio|costo|cuanto cuesta|cuanto vale|catalogo|catalogo de productos|medicamento|producto|buscar)\b/.test(text);
}

function looksLikeMedicineName(value) {
  const text = normalizeText(value);
  return text.length >= 4;
}

function hasDosageSpecificity(value) {
  const text = normalizeText(value);
  return /\b(mg|ml|suspension|ampollas|tabletas|capsulas|capsula|jarabe|gotas|solucion|inyeccion)\b/.test(text);
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

// ----------------------------------------------------
// Order creation
// ----------------------------------------------------
async function createOrderFromSession(phone, deliveryAddress, pendingOrder) {
  try {
    if (!db) {
      return '⚠️ No tengo conexión a Firebase para registrar el pedido en este momento.';
    }

    if (!pendingOrder) {
      return '⚠️ No tengo un producto pendiente para convertir en pedido.';
    }

    const quantity = Number(pendingOrder.quantity || 1);
    const unitPrice = Number(pendingOrder.bestPrice || 0);
    const total = quantity * unitPrice;

    const orderData = {
      phone,
      productName: pendingOrder.productName,
      quantity,
      unitPrice,
      total,
      deliveryAddress,
      providerHint: pendingOrder.bestProviderName || null,
      otherProvidersCount: pendingOrder.otherProviders ? pendingOrder.otherProviders.length : 0,
      status: 'pending',
      source: 'whatsapp',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const ref = await db.collection('whatsapp_orders').add(orderData);

    return buildOrderConfirmationMessage(ref.id, {
      productName: pendingOrder.productName,
      quantity,
      unitPrice,
      total,
      deliveryAddress
    });
  } catch (error) {
    console.error('❌ Error creando pedido:', error);
    return '⚠️ No pude registrar el pedido en este momento. Intenta de nuevo más tarde.';
  }
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
