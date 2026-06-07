require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

/**
 * =========================
 * ENVIRONMENT VARIABLES
 * =========================
 *
 * EVOLUTION_API_URL=https://evolution-go-dd3c.onrender.com
 * EVOLUTION_API_KEY=tu_apikey_de_evolution_go
 * PORT=3000
 *
 * Firebase:
 * Opción A:
 * FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
 *
 * Opción B:
 * FIREBASE_PROJECT_ID=...
 * FIREBASE_CLIENT_EMAIL=...
 * FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
 */

// ----------------------------------------------------
// FIREBASE INIT
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
// EVO GO CONFIG
// ----------------------------------------------------
const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';

const EVOLUTION_API_KEY =
  process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';

const PORT = process.env.PORT || 3000;

// ----------------------------------------------------
// SESSION MEMORY
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
// BASIC ROUTES
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
// WEBHOOK
// ----------------------------------------------------
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

    // Responder rápido a Evolution GO
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
// EVENT ROUTING
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
// MAIN MESSAGE PROCESSOR
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

async function routeMessage(phone, text, session) {
  const normalized = normalizeText(text);

  // --------------------------------------------------
  // 1. Derivación a humano
  // --------------------------------------------------
  if (isHumanRequest(normalized)) {
    resetSession(phone);
    return buildHumanAgentMessage();
  }

  function buildHumanAgentMessage() {
  return `👤 Te voy a pasar con un asesor

  Un agente de Gentefarma te atenderá en breve.

  Mientras tanto, si quieres, puedo ayudarte a buscar un medicamento, ver su mejor precio o iniciar un pedido.`;
  }
  
  // --------------------------------------------------
  // 2. Menú / saludo / ayuda
  // --------------------------------------------------
  if (isGreetingOrMenu(normalized)) {
    session.mode = 'idle';
    return buildMenuMessage();
  }

  // --------------------------------------------------
  // 3. Si el usuario responde con una opción numérica
  // --------------------------------------------------
  if (isMenuOption(normalized)) {
    return handleMenuOption(phone, normalized, session);
  }

  // --------------------------------------------------
  // 4. Flujo de pedido: cantidad
  // --------------------------------------------------
  if (session.mode === 'awaiting_quantity') {
    const qty = parsePositiveInteger(normalized);

    if (!qty) {
      return '⚠️ Indícame una cantidad válida, por favor. Ejemplo: *2*';
    }

    session.pendingOrder.quantity = qty;
    session.mode = 'awaiting_address';
    session.updatedAt = Date.now();

    return `📍 Perfecto. Ahora envíame tu *dirección de entrega* para continuar con el pedido de:

*${session.pendingOrder.productName}*
Cantidad: *${qty}*`;
  }

  // --------------------------------------------------
  // 5. Flujo de pedido: dirección
  // --------------------------------------------------
  if (session.mode === 'awaiting_address') {
    const address = text.trim();

    if (address.length < 6) {
      return '⚠️ La dirección parece muy corta. Envíamela un poco más detallada, por favor.';
    }

    const orderSummary = await createOrderFromSession(
      phone,
      address,
      session.pendingOrder
    );

    resetSession(phone);
    return orderSummary;
  }

  // --------------------------------------------------
  // 6. Flujo de aclaración de medicamento
  // --------------------------------------------------
  if (session.mode === 'awaiting_product_name') {
    const catalogResponse = await searchAndBuildCatalogResponse(text, session);
    return catalogResponse;
  }

  // --------------------------------------------------
  // 7. Intención de pedido
  // --------------------------------------------------
  if (isOrderRequest(normalized)) {
    const searchResult = await searchMedicinesByName(text);

    if (!searchResult) {
      session.mode = 'awaiting_product_name';
      return '🛒 Claro. ¿Qué medicamento deseas pedir? Escríbeme el nombre con su presentación, por ejemplo: *amoxicilina 500 mg suspensión*';
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

    return (
      buildCatalogResponse(searchResult) +
      '\n\n🛒 Si deseas pedirlo, respóndeme con la cantidad.'
    );
  }

  // --------------------------------------------------
  // 8. Búsqueda de producto / precio
  // --------------------------------------------------
  if (isProductSearchRequest(normalized)  looksLikeMedicineName(normalized)) {
    const catalogResponse = await searchAndBuildCatalogResponse(text, session);
    return catalogResponse;
  }

  // --------------------------------------------------
  // 9. Si no entiende, mostrar menú
  // --------------------------------------------------
  return buildMenuMessage();
}

function buildMenuMessage() {
  return `🏥 GENTEFARMA

Hola, soy tu asistente virtual.

Responde con una opción:

1️⃣ Buscar un medicamento
2️⃣ Ver mejor precio
3️⃣ Hacer un pedido
4️⃣ Hablar con un humano

O escríbeme directamente el nombre del medicamento.

Ejemplos:
• atamel forte
• amoxicilina 500 mg
• diclofenac ampollas`;
}



function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1'  text === '2'  text === '3'  text === '4';
}

async function handleMenuOption(phone, option, session) {
  switch (option) {
    case '1':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '💊 Escribe el nombre del medicamento que deseas buscar.\n\nEjemplo: atamel forte';

    case '2':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🏷️ Escribe el nombre del medicamento para ver el mejor precio.\n\nEjemplo: ibuprofeno';

    case '3':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🛒 Escribe el nombre del medicamento que deseas pedir.\n\nEjemplo: amoxicilina 500 mg suspensión';

    case '4':
      resetSession(phone);
      return buildHumanAgentMessage();

    default:
      return buildMenuMessage();
  }
}
// ----------------------------------------------------
// CATALOG SEARCH
// ----------------------------------------------------
async function searchAndBuildCatalogResponse(text, session) {
  if (!db) {
    return '⚠️ No tengo conexión al catálogo en este momento. Intenta de nuevo más tarde.';
  }

  const result = await searchMedicinesByName(text);

  if (!result) {
    session.mode = 'awaiting_product_name';
    return `⚠️ No encontré coincidencias para ${text.trim()}.

Intenta con el nombre del medicamento.
Ejemplos:
• atamel forte
• amoxicilina
• ibuprofeno 400
• diclofenac ampollas`;
  }

  if (result.needsClarification) {
    session.mode = 'awaiting_product_name';
    return result.clarificationText;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  session.updatedAt = Date.now();

  return buildCatalogResponse(result) + '\n\nSi quieres, responde PEDIR para iniciar un pedido.';
}


async function searchMedicinesByName(userQuery) {
  if (!db) return null;

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);

  if (!queryTokens.length) return null;

  // Lee ambas colecciones
  const products = await fetchCollectionDocuments('products-market', 1000);
  const providers = await fetchCollectionDocuments('providers-products', 2000);

  // Scoring de productos
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
      // Primero mejor match, luego menor precio
      if (b.score !== a.score) return b.score - a.score;

      const priceA = a.price ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.price ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  if (!scoredProducts.length) return null;

  const top = scoredProducts[0];
  const second = scoredProducts[1];

  // Si la búsqueda es muy ambigua, pedimos aclaración
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

  // Buscar farmacias que tengan el mismo medicamento
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

  // Excluir la farmacia que tiene el mejor precio
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

// ----------------------------------------------------
// RESPONSE BUILDERS
// ----------------------------------------------------
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

      lines.push(
        `• ${providerName}${price !== null ? ` - $${formatPrice(price)}` : ''}${availability ? ` (${availability})` : ''}`
      );
    });
  } else {
    lines.push('');
    lines.push('ℹ️ No encontré otras farmacias con este mismo medicamento.');
  }

  return lines.join('\n');
}

// ----------------------------------------------------
// MATCHING LOGIC
// ----------------------------------------------------
function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;
  if (!docText) return 0;

  const productName = normalizeText(buildShortProductLabel(doc));
  const activeIngredient = normalizeText(doc?.activeIngredient || doc?.ingredient || doc?.principle || '');
  const brand = normalizeText(doc?.brand || doc?.commercialName || '');
  const description = normalizeText(doc?.description || '');
  const presentation = normalizeText(buildDosageForm(doc));
  const strength = normalizeText(buildStrength(doc));

  // Coincidencia fuerte por query completa
  if (docText.includes(query)) score += 60;

  // Coincidencias por palabra
  for (const token of queryTokens) {
    if (docText.includes(token)) score += 12;
    if (productName.includes(token)) score += 15;
    if (activeIngredient.includes(token)) score += 10;
    if (brand.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
  }

  // Bonus por nombre principal
  if (productName && query.includes(productName)) score += 25;

  // Bonus por coincidencias parciales útiles
  if (queryTokens.some((t) => productName.includes(t))) score += 15;
  if (queryTokens.some((t) => activeIngredient.includes(t))) score += 10;
  if (queryTokens.some((t) => brand.includes(t))) score += 8;

  // Bonus si coincide forma o concentración, pero sin exigirlo
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

// ----------------------------------------------------
// DOC TEXT BUILDERS
// ----------------------------------------------------
function buildShortProductLabel(doc) {
  return (
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
  return [
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
  return [
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
    doc?.pharmacyName,
    doc?.providerName,
    doc?.storeName
  ]
    .flat()
    .filter(Boolean)
    .join(' ');
}

function buildProviderName(doc) {
  return (
    doc?.pharmacyName ||
    doc?.providerName ||
    doc?.storeName ||
    doc?.name ||
    doc?.company ||
    ''
  );
}

function buildProviderId(doc) {
  return (
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
  return (
    doc?.form ||
    doc?.dosageForm ||
    doc?.presentationForm ||
    doc?.presentation ||
    ''
  );
}

function buildStrength(doc) {
  return (
    doc?.strength ||
    doc?.concentration ||
    doc?.dosage ||
    doc?.dose ||
    ''
  );
}

function getPrice(doc) {
  const raw =
    doc?.price ??
    doc?.bestPrice ??
    doc?.amount ??
    doc?.salePrice ??
    doc?.unitPrice ??
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
// ORDER FLOW
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

function buildOrderConfirmationMessage(orderId, orderData) {
  return `✅ Pedido registrado correctamente

ID: ${orderId}
Producto: ${orderData.productName}
Cantidad: ${orderData.quantity}
Precio unitario: $${formatPrice(orderData.unitPrice)}
Total estimado: $${formatPrice(orderData.total)}

📍 Dirección:
${orderData.deliveryAddress}

Un asesor revisará tu pedido y te contactará si hace falta confirmar algo.`;
}

// ----------------------------------------------------
// EVOLUTION GO SEND MESSAGE
// ----------------------------------------------------
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

// ----------------------------------------------------
// EVOLUTION PAYLOAD EXTRACTORS
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

  // 584128009482@s.whatsapp.net -> 584128009482
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
// TEXT / MATCH HELPERS
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
  'comprar'
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
    text === 'menú' ||
    text === 'ayuda' ||
    text === '1' ||
    text === '2' ||
    text === '3' ||
    text === '4' ||
    /^(hola|menu|menú|ayuda)\b/.test(text)
  );
}

function isHumanRequest(value) {
  const text = normalizeText(value);
  return (
    /\b(humano|agente|asesor|persona|operador|atencion humana|atencion al cliente)\b/.test(text)
  );
}

function isOrderRequest(value) {
  const text = normalizeText(value);
  return (
    /\b(pedir|pedido|comprar|ordenar|encargar|solicitar)\b/.test(text)
  );
}

function isProductSearchRequest(value) {
  const text = normalizeText(value);
  return (
    /\b(precio|costo|cuanto cuesta|cuanto vale|catalogo|catalogo de productos|medicamento|producto|buscar)\b/.test(text)
  );
}

function looksLikeMedicineName(value) {
  const text = normalizeText(value);
  return (
    /\b(mg|ml|suspension|ampollas|tabletas|capsulas|capsula|jarabe|gotas|solucion|inyeccion)\b/.test(text) ||
    text.length >= 6
  );
}

function hasDosageSpecificity(value) {
  const text = normalizeText(value);
  return /\b(mg|ml|suspension|ampollas|tabletas|capsulas|capsula|jarabe|gotas|solucion|inyeccion)\b/.test(text);
}

function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;

  if (!docText) return 0;

  if (docText.includes(query)) score += 50;

  for (const token of queryTokens) {
    if (docText.includes(token)) score += 8;

    if (token === 'mg' || token === 'ml') score += 2;
    if (token === 'suspension' || token === 'ampollas') score += 5;
  }

  const productName = normalizeText(buildShortProductLabel(doc));
  if (productName && docText.includes(productName)) score += 15;

  const form = normalizeText(buildDosageForm(doc));
  if (form && query.includes(form)) score += 10;

  const strength = normalizeText(buildStrength(doc));
  if (strength && query.includes(strength)) score += 10;

  return score;
}

function computeProviderMatchScore(query, queryTokens, docText, doc, productNameHint) {
  let score = 0;

  if (!docText) return 0;

  if (docText.includes(query)) score += 30;

  for (const token of queryTokens) {
    if (docText.includes(token)) score += 6;
  }

  if (productNameHint) {
    const hint = normalizeText(productNameHint);
    if (hint && docText.includes(hint)) score += 20;
  }

  return score;
}

// ----------------------------------------------------
// DOC TEXT BUILDERS
// ----------------------------------------------------
function buildShortProductLabel(doc) {
  return (
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
  return [
    doc?.name,
    doc?.productName,
    doc?.medicineName,
    doc?.medication,
    doc?.title,
    doc?.description,
    doc?.presentation,
    doc?.form,
    doc?.dosage,
    doc?.strength,
    doc?.concentration,
    doc?.activeIngredient,
    doc?.composition
  ]
    .filter(Boolean)
    .join(' ');
}

function buildProviderSearchText(doc) {
  return [
    doc?.name,
    doc?.productName,
    doc?.medicineName,
    doc?.medication,
    doc?.title,
    doc?.description,
    doc?.presentation,
    doc?.form,
    doc?.dosage,
    doc?.strength,
    doc?.concentration,
    doc?.activeIngredient,
    doc?.composition,
    doc?.pharmacyName,
    doc?.providerName,
    doc?.storeName
  ]
    .filter(Boolean)
    .join(' ');
}

function buildProviderName(doc) {
  return (
    doc?.pharmacyName ||
    doc?.providerName ||
    doc?.storeName ||
    doc?.name ||
    doc?.company ||
    ''
  );
}

function buildProviderId(doc) {
  return (
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
  return (
    doc?.form ||
    doc?.dosageForm ||
    doc?.presentationForm ||
    doc?.presentation ||
    ''
  );
}

function buildStrength(doc) {
  return (
    doc?.strength ||
    doc?.concentration ||
    doc?.dosage ||
    doc?.dose ||
    ''
  );
}

function getPrice(doc) {
  const raw =
    doc?.price ??
    doc?.bestPrice ??
    doc?.amount ??
    doc?.salePrice ??
    doc?.unitPrice ??
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
// FIRESTORE HELPERS
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
// CLEANUP
// ----------------------------------------------------
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

// ----------------------------------------------------
// START
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Gentefarma Webhook Service running on port ${PORT}`);
});
