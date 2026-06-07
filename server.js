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
      pendingSelectionResults: null,
      selectedProducts: [],
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
    pendingSelectionResults: null,
    selectedProducts: [],
    pendingOrder: null,
    updatedAt: Date.now()
  });
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
  if (session.mode === 'awaiting_choice') session.mode = 'idle';
}

function getCartTotals(session) {
  const items = ensureSelectedProducts(session);
  const totalUsd = items.reduce((sum, item) => sum + (Number(item.priceUsd) || 0) * (Number(item.quantity) || 0), 0);
  const totalBs = items.reduce((sum, item) => sum + (Number(item.priceBs) || 0) * (Number(item.quantity) || 0), 0);
  return { totalUsd, totalBs };
}

function parseSelectionAndQuantity(text) {
  const normalized = normalizeText(text)
    .replace(/\b(opcion|opci[oó]n|seleccionar|selecciona|agregar|agrega|elegir|elige|escoger|escoje|de)\b/g, ' ')
    .replace(/x|por|cantidad/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const numbers = normalized.match(/\d+/g) || [];
  if (!numbers.length) return null;

  const option = Number(numbers[0]);
  const quantity = numbers.length >= 2 ? Number(numbers[1]) : 1;

  if (!Number.isInteger(option) || option <= 0) return null;
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  return { option, quantity };
}

function parseQuantityOnly(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(\d+)\b/);
  if (!match) return null;
  const qty = Number(match[1]);
  return Number.isInteger(qty) && qty > 0 ? qty : null;
}

function formatSelectionSavedMessage(item, quantity, session) {
  const title = item.title || 'Medicamento';
  const usdUnit = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
  const bsUnit = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
  const totalUsd = item.priceUsd !== null ? `$${formatPrice((Number(item.priceUsd) || 0) * quantity)}` : 'No disponible';
  const totalBs = item.priceBs !== null ? `Bs ${formatPrice((Number(item.priceBs) || 0) * quantity)}` : 'No disponible';
  const { totalUsd: cartUsd, totalBs: cartBs } = getCartTotals(session);

  return [
    `✅ *Agregado a tu selección*`,
    `💊 *${title}*`,
    `Cantidad: *${quantity}*`,
    `Unitario: ${usdUnit}  |  ${bsUnit}`,
    `Subtotal: ${totalUsd}  |  ${totalBs}`,
    '',
    `🧾 Tu carrito actual: *$${formatPrice(cartUsd)}*  |  *Bs ${formatPrice(cartBs)}*`,
    'Escribe *RESUMEN* para ver el pedido completo o continúa buscando otro medicamento.'
  ].join('\n');
}

function buildSelectedProductsSummary(session) {
  const items = ensureSelectedProducts(session);
  if (!items.length) {
    return '🧾 Aún no has agregado medicamentos a tu pedido.';
  }

  const lines = [];
  const { totalUsd, totalBs } = getCartTotals(session);

  lines.push('🧾 *Resumen de medicamentos seleccionados*');
  lines.push('');

  items.forEach((item, idx) => {
    const title = item.title || 'Medicamento';
    const qty = Number(item.quantity) || 1;
    const unitUsd = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const unitBs = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    const subtotalUsd = item.priceUsd !== null ? `$${formatPrice((Number(item.priceUsd) || 0) * qty)}` : 'No disponible';
    const subtotalBs = item.priceBs !== null ? `Bs ${formatPrice((Number(item.priceBs) || 0) * qty)}` : 'No disponible';

    lines.push(`${idx + 1}. ${title}`);
    lines.push(`   Cantidad: ${qty}`);
    lines.push(`   Unitario: ${unitUsd} | ${unitBs}`);
    lines.push(`   Subtotal: ${subtotalUsd} | ${subtotalBs}`);
    lines.push('');
  });

  lines.push(`💰 *Total pedido:* $${formatPrice(totalUsd)}  |  Bs ${formatPrice(totalBs)}`);
  lines.push('');
  lines.push('👤 *Pronto te atenderá un Auxiliar* para finalizar la compra y confirmar tu pedido.');

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
    raw: item.raw
  };

  if (existingIndex >= 0) {
    cart[existingIndex].quantity += quantity;
    cart[existingIndex].priceUsd = item.priceUsd;
    cart[existingIndex].priceBs = item.priceBs;
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

  if (isHumanRequest(normalized)) {
    resetSession(phone);
    return buildHumanAgentMessage();
  }

  if (/^resumen\b/.test(normalized)) {
    return buildSelectedProductsSummary(session);
  }

  if (session.mode === 'awaiting_choice') {
    const parsed = parseSelectionAndQuantity(normalized);
    if (!parsed) {
      return '⚠️ Escribe la opción y la cantidad. Ejemplos: *1 2*, *opción 1 cantidad 2*, *agregar 1 x 2*';
    }

    const results = session.pendingSelectionResults || [];
    const selected = results[parsed.option - 1];
    if (!selected) {
      return `⚠️ La opción *${parsed.option}* no está disponible. Escribe *RESUMEN* o busca otro medicamento.`;
    }

    addItemToCart(session, selected, parsed.quantity);
    session.updatedAt = Date.now();
    clearPendingSearch(session);

    return formatSelectionSavedMessage(selected, parsed.quantity, session);
  }

  if (session.mode === 'awaiting_quantity') {
    const qtyOnly = parseQuantityOnly(normalized);
    if (qtyOnly && session.pendingOrder?.productName) {
      session.pendingOrder.quantity = qtyOnly;
      session.mode = 'awaiting_address';
      session.updatedAt = Date.now();
      return `📍 Perfecto. Ahora envíame tu *dirección de entrega* para continuar con el pedido de:\n\n*${session.pendingOrder.productName}*\nCantidad: *${qtyOnly}*`;
    }

    const qty = parsePositiveInteger(normalized);
    if (!qty) {
      return '⚠️ Indícame una cantidad válida, por favor. Ejemplo: *2*';
    }

    session.pendingOrder.quantity = qty;
    session.mode = 'awaiting_address';
    session.updatedAt = Date.now();

    return `📍 Perfecto. Ahora envíame tu *dirección de entrega* para continuar con el pedido de:\n\n*${session.pendingOrder.productName}*\nCantidad: *${qty}*`;
  }

  if (session.mode === 'awaiting_quantity') {
    const qty = parseQuantityOnly(normalized) || parsePositiveInteger(normalized);
    if (!qty) {
      return '⚠️ Indícame una cantidad válida, por favor. Ejemplo: *2*';
    }

    session.pendingOrder.quantity = qty;
    session.mode = 'awaiting_address';
    session.updatedAt = Date.now();

    return `📍 Perfecto. Ahora envíame tu *dirección de entrega* para continuar con el pedido de:\n\n*${session.pendingOrder.productName}*\nCantidad: *${qty}*`;
  }

  if (session.mode === 'awaiting_address') {
    const address = text.trim();
    if (address.length < 6) {
      return '⚠️ La dirección parece muy corta. Envíamela un poco más detallada, por favor.';
    }

    const orderSummary = await createOrderFromSession(phone, address, session.pendingOrder);
    resetSession(phone);
    return orderSummary;
  }

  if (session.mode === 'awaiting_product_name') {
    return await searchAndBuildCatalogResponse(text, session);
  }

  if (isOrderRequest(normalized)) {
    const searchResult = await searchMedicinesByName(text);

    if (!searchResult || !searchResult.matches.length) {
      session.mode = 'awaiting_product_name';
      return '🛒 Claro. ¿Qué medicamento deseas pedir? Escríbeme el nombre del medicamento.';
    }

    session.lastSearch = searchResult;
    session.pendingOrder = {
      productName: searchResult.matches[0].title,
      bestPrice: searchResult.matches[0].priceUsd,
      quantity: 1
    };
    session.mode = 'awaiting_quantity';
    session.updatedAt = Date.now();

    return buildCatalogResponse(searchResult) + '\n\n🛒 Si deseas pedirlo, respóndeme con la cantidad.';
  }

  if (isGreetingOrMenu(normalized)) {
    session.mode = 'idle';
    return buildMenuMessage();
  }

  if (isProductSearchRequest(normalized) || looksLikeMedicineName(normalized)) {
    const searchResult = await searchMedicinesByName(text);

    if (!searchResult || !searchResult.matches.length) {
      session.mode = 'awaiting_product_name';
      return '⚠️ No encontré coincidencias. Prueba con otro nombre de medicamento.';
    }

    session.pendingSelectionResults = searchResult.matches;
    session.mode = 'awaiting_choice';
    session.updatedAt = Date.now();

    const resultText = buildCatalogResponse(searchResult);
    const choiceHint = [
      '',
      '➡️ Responde con la *opción y cantidad* que deseas agregar.',
      'Ejemplos:',
      '• *1 2*  = opción 1, cantidad 2',
      '• *3 1*  = opción 3, cantidad 1',
      '',
      'Cuando termines, escribe *RESUMEN* para ver tu pedido total.'
    ].join('\n');

    return `${resultText}\n\n${choiceHint}`;
  }

  return buildMenuMessage();
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

async function handleMenuOption(phone, option, session) {
  switch (option) {
    case '1':
    case '2':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🔎 Escribe el nombre del medicamento que deseas buscar.\n\nEjemplo: *atamel*';

    case '3':
      session.mode = 'awaiting_product_name';
      session.updatedAt = Date.now();
      return '🛒 Escribe el nombre del medicamento que deseas pedir.\n\nEjemplo: *amoxicilina*';

    case '4':
      resetSession(phone);
      return buildHumanAgentMessage();

    default:
      return buildMenuMessage();
  }
}

function buildMenuMessage() {
  return `🏥 *GENTEFARMA*\n\nHola, soy tu asistente virtual.\n\nResponde con una opción:\n\n1️⃣ Buscar un medicamento\n2️⃣ Ver mejor precio\n3️⃣ Hacer un pedido\n4️⃣ Hablar con un humano\n\nO escríbeme directamente el nombre del medicamento.\n\nEjemplos:\n• *atamel*\n• *amoxicilina*\n• *histaler ped*`;
}

function buildHumanAgentMessage() {
  return `👤 *Te voy a pasar con un asesor*\n\nUn agente de Gentefarma te atenderá en breve.\n\nMientras tanto, si quieres, puedo ayudarte a buscar un medicamento o ver su mejor precio.`;
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

  if (!result || !result.matches.length) {
    session.mode = 'awaiting_product_name';
    return `⚠️ No encontré coincidencias para *${text.trim()}*.

Intenta con el nombre del medicamento.
Ejemplos:
• *atamel*
• *histaler ped*
• *desloratadina*
• *ibuprofeno*`;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  session.updatedAt = Date.now();

  return buildCatalogResponse(result);
}

async function searchMedicinesByName(userQuery) {
  if (!db) return null;

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!queryTokens.length) return null;

  const exchangeRate = await getBcvRate();
  const products = await fetchCollectionDocuments('products-market', 2000);

  const scoredProducts = products
    .map((doc) => {
      const title = buildShortProductLabel(doc);
      const searchableText = normalizeText(buildProductSearchText(doc));
      const score = computeMatchScore(query, queryTokens, searchableText, doc);
      return {
        doc,
        title,
        score,
        priceUsd: getPrice(doc),
        priceBs: getPriceBs(doc, exchangeRate)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;

      const priceA = a.priceUsd ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.priceUsd ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  if (!scoredProducts.length) return null;

  return {
    query,
    queryTokens,
    exchangeRate,
    matches: scoredProducts.slice(0, 15).map((item) => ({
      title: item.title,
      priceUsd: item.priceUsd,
      priceBs: item.priceBs,
      raw: item.doc
    }))
  };
}

function buildCatalogResponse(result) {
  if (!result || !result.matches || !result.matches.length) {
    return '⚠️ Necesito un poco más de detalle para ayudarte.';
  }

  const lines = [];
  lines.push(`🔎 *Resultados para: ${result.query}*`);
  if (result.exchangeRate) {
    lines.push(`💱 Tasa BCV: *Bs ${formatPrice(result.exchangeRate)}* por *$1*`);
  }
  lines.push('');

  result.matches.forEach((item, index) => {
    const title = shortenText(item.title || 'Medicamento', 52);
    const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    const icon = getProductIcon(title);

    lines.push(`${icon} *${index + 1}. ${title}*`);
    lines.push(`💵 ${usdText}  |  💠 ${bsText}`);
    lines.push('');
  });

  return lines.join('\n').trim();
}

function shortenText(value, maxLength = 52) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function getProductIcon(title) {
  const text = normalizeText(title);
  if (/ampolla|inyeccion|injectable/.test(text)) return '💉';
  if (/suspension|jarabe|gotas|solucion/.test(text)) return '🧴';
  if (/tableta|capsula|capsulas|comprimido|pastilla/.test(text)) return '💊';
  if (/crema|unguento|gel|pomada/.test(text)) return '🧪';
  if (/polvo|sobres/.test(text)) return '📦';
  return '💊';
}

function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;
  if (!docText) return 0;

  const productTitle = normalizeText(buildShortProductLabel(doc));
  const titleArrayText = Array.isArray(doc?.productTitleArray)
    ? normalizeText(doc.productTitleArray.join(' '))
    : '';

  if (docText.includes(query)) score += 80;

  for (const token of queryTokens) {
    if (docText.includes(token)) score += 15;
    if (productTitle.includes(token)) score += 18;
    if (titleArrayText.includes(token)) score += 14;
  }

  if (queryTokens.some((t) => productTitle.includes(t))) score += 20;
  if (queryTokens.some((t) => titleArrayText.includes(t))) score += 16;

  // No dar puntaje por tener precio; solo deben aparecer productos con coincidencia real.
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
