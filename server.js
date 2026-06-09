equire('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

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
      humanHandoff: false,
      lastSearch: null,
      pendingSelectionResults: null,
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
  const quantityMatch = normalized.match(/\b(\d+)\s*(?:cajas?|box|unidades?|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/i);
  const optionAfter = normalized.match(/\b(\d+)\s*(?:de\s+la\s+)?(?:opcion|opci[oó]n)\b/i);

  if (optionMatch || optionAfter) {
    const option = Number((optionMatch || optionAfter)[1]);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
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

  const numbers = normalized.match(/\d+/g) || [];
  if (!numbers.length) return null;

  const option = Number(numbers[0]);
  const quantity = numbers.length >= 2 ? Number(numbers[1]) : 1;

  if (!Number.isInteger(option) || option <= 0) return null;
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  return { option, quantity };
}

function isSelectionIntent(value) {
  const text = normalizeText(value);
  return /\b(opcion|opci[oó]n|seleccionar|selecciona|agregar|agrega|quiero|quisiera|caja|cajas|unidad|unidades|frascos?|tabletas?|capsulas?|ampollas?|sobres?)\b/.test(text) && /\d+/.test(text);
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
    'Escribe *LISTO* para ver el pedido completo o continúa buscando otro medicamento.'
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

// ----------------------------------------------------
// Conversation router
// ----------------------------------------------------
async function routeMessage(phone, text, session) {
  const normalized = normalizeText(text);

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

  if (isThanksMessage(normalized)) {
    return 'Con gusto. Estoy aquí para ayudarte cuando necesites buscar otro medicamento.';
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

    const parsed = parseSelectionAndQuantity(normalized);
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

    const parsed = parseSelectionAndQuantity(normalized);
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
      return `⚠️ No encontré *${productQuery}* o una presentación muy cercana.\n\nPrueba con otro nombre o una presentación distinta. Ejemplos:\n• *oxacilina*\n• *oxacilina 500mg*\n• *otro nombre del me
dicamento*`;
    }

    session.pendingSelectionResults = searchResult.matches;
    session.mode = 'awaiting_choice';
    touchSession(session);

      return buildCatalogResponse(searchResult);
  }

  return buildMenuMessage();
}

function buildMenuMessage() {
  return `🏥 *GENTEFARMA*\n\n¡Hola! Soy *Robi*, el asistente virtual de Gentefarma. 🤖👋\n\nEstoy aquí para ayudarte a encontrar el medicamento que necesitas de forma rápida y sencilla.\n\n👉 Escríbeme el n
ombre del medicamento que estás buscando y te digo si está disponible.\n\nEjemplos:\n*atamel* ·\n*amoxicilina* ·\n*losartan*`;
}

function buildHumanAgentMessage() {
  return `👤 *Atención de Gentefarma*\n\nUno de nuestros colaboradores te atenderá en breve.\n\nMientras esperas, también puedo ayudarte a buscar un medicamento.`;
}

function buildInstagramReelMessage() {
  return `Claro, aquí tienes más información:\n\nhttps://www.instagram.com/reel/DU3hPpJDquf/?igsh=MWJnczFxMDgyMTh3aQ==`;
}

function shouldSendInstagramReel(value) {
  const text = normalizeText(value);
  const isGentefarmaContext = /\b(gentefarma|farmacia|farmacias|como funciona|cómo funciona|beneficios|promocion|promoción|promo|planes|servicio|servicios|pedido|pedidos|catalogo|catálogo|mas infor
macion|más informacion|informacion de gentefarma|quienes somos|quiénes somos)\b/.test(text);
  const asksForMedia = /\b(reel|video|video de presentacion|presentacion|presentación|instagram|redes|publicacion|publicación)\b/.test(text);
  const wantsInfo = /\b(quiero|necesito|me interesa|puedo ver|dame|envíame|enviame|mostrar|muéstrame|mostrame)\b/.test(text);

  return Boolean((isGentefarmaContext && wantsInfo) || asksForMedia);
}

function isInstagramInfoRequest(value) {
  const text = normalizeText(value);
  return /\b(mas\s+informacion|más\s+informacion|informacion|info|quiero\s+saber\s+mas|quiero\s+más\s+saber|quiero\s+mas\s+informacion|quiero\s+más\s+información)\b/.test(text);
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
  const candidateMedicines = dedupeStrings([
    ...requestedMedicines,
    ...fallbackMedicines
  ]);

  if (candidateMedicines.length > 1) {
    const exchangeRate = await getBcvRate();
    const products = await fetchCollectionDocuments('products-market', 2000);
    const groups = [];

    for (const medicineQuery of candidateMedicines) {
      const result = await searchMedicinesByName(medicineQuery, { products, exchangeRate });
      if (result && result.matches && result.matches.length) groups.push(result);
    }

    if (groups.length > 0) {
      const flattenedOptions = flattenCatalogResults(groups);
      session.lastSearch = groups[0];
      session.pendingSelectionResults = flattenedOptions;
      session.mode = 'awaiting_choice_global';
      touchSession(session);
      return buildMultiCatalogResponse(groups, flattenedOptions);
    }

    session.mode = 'awaiting_product_name';
    return `⚠️ No encontré coincidencias para esa lista de medicamentos.

Prueba enviándolos de nuevo, uno por línea, por ejemplo:
• Candesartan 160mg
• Clopidogrel 75mg
• Omeprazol 20mg`;
  }

  const singleQuery = candidateMedicines[0] || extractMedicineQuery(text) || text;
  const result = await searchMedicinesByName(singleQuery);

  if (!result || !result.matches.length) {
    session.mode = 'awaiting_product_name';
    return `⚠️ No encontré coincidencias para *${singleQuery.trim()}*.

Intenta con el nombre del medicamento.
Ejemplos:
• *atamel*
• *histaler ped*
• *desloratadina*
• *ibuprofeno*`;
  }

  session.lastSearch = result;
  session.mode = 'idle';
  touchSession(session);

  return buildCatalogResponse(result);
}

async function searchMedicinesByName(userQuery, options = {}) {
  if (!db) return null;

  const query = normalizeText(userQuery);
  const queryTokens = tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1);
  if (!queryTokens.length) return null;

  const exchangeRate = options.exchangeRate ?? await getBcvRate();
  const products = options.products ?? await fetchCollectionDocuments('products-market', 2000);

  const exactQuery = query;
  const exactRoot = queryTokens.join(' ');
  const dosageLessQuery = queryTokens
    .filter((token) => !/^(\d+(?:[.,]\d+)?)$/.test(token))
    .filter((token) => !/^(mg|mcg|g|gr|ml|cc|ui|iu|tabletas?|capsulas?|capsules?|ampollas?|suspension|jarabe|gotas|crema|gel|unguento|unguentos|sobres?)$/.test(token))
    .join(' ')
    .trim();
  const vitaminPhrases = extractVitaminFocusPhrases(query);
  const vitaminFocusWord = extractVitaminFocusTokens(query)[0] || '';

  const scoredProducts = products
    .map((doc) => {
      const title = buildShortProductLabel(doc);
      const productTitle = normalizeText(title);
      const productText = normalizeText(buildProductSearchText(doc));
      const titleArrayText = Array.isArray(doc?.productTitleArray)
        ? normalizeText(doc.productTitleArray.join(' '))
        : '';
      const ingredient = normalizeText(doc?.activeIngredient || doc?.active_ingredient || doc?.ingredient || '');
      const score = computeMatchScore(query, queryTokens, productText, doc);

      const variants = [exactQuery, exactRoot, dosageLessQuery, ...vitaminPhrases].filter(Boolean);
      const exactHit = variants.some((variant) => {
        if (!variant) return false;
        const variantTokens = tokenize(variant).filter((t) => !STOPWORDS.has(t) && t.length > 1);
        const tokenCoverageTitle = variantTokens.filter((t) => productTitle.includes(t)).length;
        const tokenCoverageArray = variantTokens.filter((t) => titleArrayText.includes(t)).length;
        const tokenCoverageIngredient = variantTokens.filter((t) => ingredient.includes(t)).length;

        return (
          productTitle === variant ||
          productTitle.includes(variant) ||
          titleArrayText === variant ||
          titleArrayText.includes(variant) ||
          ingredient === variant ||
          ingredient.includes(variant) ||
          productText.includes(variant) ||
          tokenCoverageTitle === variantTokens.length ||
          tokenCoverageArray === variantTokens.length ||
          tokenCoverageIngredient === variantTokens.length
        );
      });

      const focusTitleHit = Boolean(vitaminFocusWord) && (
        productTitle.includes(vitaminFocusWord) ||
        titleArrayText.includes(vitaminFocusWord) ||
        ingredient.includes(vitaminFocusWord)
      );

      const phraseHit = queryTokens.length > 1 && (
        productTitle.includes(query) ||
        titleArrayText.includes(query) ||
        ingredient.includes(query) ||
        productTitle.includes(exactRoot) ||
        titleArrayText.includes(exactRoot) ||
        ingredient.includes(exactRoot) ||
        vitaminPhrases.some((phrase) => productTitle.includes(phrase) || titleArrayText.includes(phrase) || ingredient.includes(phrase))
      );

      const tokenCoverageTitle = queryTokens.filter((t) => productTitle.includes(t)).length;
      const tokenCoverageArray = queryTokens.filter((t) => titleArrayText.includes(t)).length;
      const tokenCoverageIngredient = queryTokens.filter((t) => ingredient.includes(t)).length;
      const tokenCoverage = Math.max(tokenCoverageTitle, tokenCoverageArray, tokenCoverageIngredient);

      const basePriceUsd = getPrice(doc);
      const basePriceBs = getPriceBs(doc, exchangeRate);
      const pricing = applySalesPricing(basePriceUsd, exchangeRate);

      return {
        doc,
        title,
        score: score + (phraseHit ? 220 : 0) + (queryTokens.length > 1 ? tokenCoverage * 12 : 0) + (focusTitleHit ? 250 : 0),
        exactHit,
        phraseHit,
        focusTitleHit,
        tokenCoverage,
        basePriceUsd,
        basePriceBs,
        priceUsd: pricing.displayUsd,
        priceBs: pricing.displayBs,
        feeRate: pricing.feeRate,
        feeAmountUsd: pricing.feeAmountUsd
      };
    })
    .sort((a, b) => {
      const focusA = a.focusTitleHit ? 1 : 0;
      const focusB = b.focusTitleHit ? 1 : 0;
      if (focusA !== focusB) return focusB - focusA;

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

  const exactMatches = scoredProducts.filter((item) => item.exactHit || item.focusTitleHit);
  let candidateMatches = exactMatches.length
    ? exactMatches
    : scoredProducts.filter((item) => (item.score ?? 0) >= 25 || item.phraseHit || item.focusTitleHit || (item.tokenCoverage ?? 0) > 0);

  if (!candidateMatches.length) {
    candidateMatches = scoredProducts.filter((item) => (item.score ?? 0) >= 15);
  }

  if (!candidateMatches.length) {
    candidateMatches = scoredProducts.filter((item) => (item.score ?? 0) > 0);
  }

  if (!candidateMatches.length) {
    candidateMatches = scoredProducts.slice(0, 5);
  }

  const focusCandidates = vitaminFocusWord
    ? candidateMatches.filter((item) => {
        const itemText = normalizeText(`${item.title || ''} ${buildProductSearchText(item.doc)} ${item.raw?.activeIngredient || ''}`);
        return itemText.includes(vitaminFocusWord);
      })
    : [];

  if (vitaminFocusWord && focusCandidates.length) candidateMatches = focusCandidates;

  const topMatches = candidateMatches.slice(0, 5).sort((a, b) => {
    const priceA = a.priceUsd ?? Number.MAX_SAFE_INTEGER;
    const priceB = b.priceUsd ?? Number.MAX_SAFE_INTEGER;
    if (priceA !== priceB) return priceA - priceB;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  return {
    query,
    queryTokens,
    exchangeRate,
    matches: topMatches.map((item) => ({
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
      focusTitleHit: item.focusTitleHit
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
    lines.push(`💱 Tasa BCV: *Bs ${formatPrice(result.exchangeRate)}* por *$1*`);
  }
  lines.push('');

  result.matches.forEach((item, index) => {
    const title = shortenText(item.title || 'Medicamento', 52);
    const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
    const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
    lines.push(`*${title}*`);
    lines.push(`Opción ${index + 1} — ${bsText} — ${usdText}`);
    lines.push('');
  });

  lines.push('');
  lines.push('Para agregar al pedido: *1 2*');
  lines.push('Luego escribe otro medicamento o *LISTO* para el resumen.');

  return lines.join('\n').trim();
}

function buildMultiCatalogResponse(results, flatOptions = []) {
  if (!Array.isArray(results) || !results.length) {
    return '⚠️ Necesito un poco más de detalle para ayudarte.';
  }

  const lines = [];
  lines.push('🔎 *Resultados encontrados*');
  lines.push('');

  let optionNumber = 1;
  results.forEach((result) => {
    const title = shortenText(result.query || 'Medicamento', 52);
    lines.push(`*${title}*`);

    (result.matches || []).forEach((item) => {
      const name = shortenText(item.title || 'Medicamento', 52);
      const usdText = item.priceUsd !== null ? `$${formatPrice(item.priceUsd)}` : 'No disponible';
      const bsText = item.priceBs !== null ? `Bs ${formatPrice(item.priceBs)}` : 'No disponible';
      lines.push(`${optionNumber}. ${name} — ${bsText} — ${usdText}`);
      optionNumber += 1;
    });

    lines.push('');
  });

  lines.push('');
  lines.push('Para agregar al pedido: *1 2*');
  lines.push('Luego escribe otro medicamento o *LISTO* para el resumen.');

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
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|ampollas?|suspension|jarabe|gotas|crema|gel|unguento|sobres?|vitamina)/.test(cleaned)) continue;

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
    if (!/(\d|mg|mcg|g|gr|ml|ui|iu|tabletas?|capsulas?|capsules?|ampollas?|suspension|jarabe|gotas|crema|gel|unguento|sobres?|vitamina)/.test(cleaned)) continue;

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
    for (const item of group?.matches || []) {
      flattened.push({
        groupQuery: group?.query || '',
        groupTitle: group?.query || 'Medicamento',
        ...item
      });
    }
  }
  return flattened;
}

function computeMatchScore(query, queryTokens, docText, doc) {
  let score = 0;
  if (!docText) return 0;

  const productTitle = normalizeText(buildShortProductLabel(doc));
  const titleArrayText = Array.isArray(doc?.productTitleArray)
    ? normalizeText(doc.productTitleArray.join(' '))
    : '';
  const activeIngredient = normalizeText(doc?.activeIngredient || doc?.active_ingredient || doc?.ingredient || '');
  const searchArea = [docText, productTitle, titleArrayText, activeIngredient].filter(Boolean).join(' | ');
  const searchTokens = tokenize(searchArea).filter((t) => t.length > 1);
  const phraseQuery = queryTokens.join(' ');
  const multiWord = queryTokens.length > 1;

  if (productTitle === query) score += 400;
  if (titleArrayText === query) score += 320;
  if (activeIngredient && activeIngredient === query) score += 300;

  if (productTitle.includes(query) || query.includes(productTitle)) score += 220;
  if (titleArrayText.includes(query) || query.includes(titleArrayText)) score += 180;
  if (activeIngredient && (activeIngredient.includes(query) || query.includes(activeIngredient))) score += 160;

  if (multiWord && phraseQuery) {
    if (productTitle.includes(phraseQuery)) score += 260;
    if (titleArrayText.includes(phraseQuery)) score += 220;
    if (activeIngredient.includes(phraseQuery)) score += 200;
  }

  const tokenMatchCountTitle = queryTokens.filter((t) => productTitle.includes(t)).length;
  const tokenMatchCountArray = queryTokens.filter((t) => titleArrayText.includes(t)).length;
  const tokenMatchCountIngredient = queryTokens.filter((t) => activeIngredient.includes(t)).length;

  if (tokenMatchCountTitle === queryTokens.length && queryTokens.length > 0) score += 140;
  if (tokenMatchCountArray === queryTokens.length && queryTokens.length > 0) score += 120;
  if (tokenMatchCountIngredient === queryTokens.length && queryTokens.length > 0) score += 130;

  for (const token of queryTokens) {
    if (searchArea.includes(token)) score += 8;
    if (productTitle.includes(token)) score += 18;
    if (titleArrayText.includes(token)) score += 14;
    if (activeIngredient.includes(token)) score += 16;

    if (!searchArea.includes(token)) {
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

      if (bestDistance <= 1) score += 36;
      else if (bestDistance === 2) score += 24;
      else if (bestDistance === 3) score += 12;
    }
  }

  if (multiWord) {
    const titleStartsWithPhrase = productTitle.startsWith(phraseQuery);
    const arrayStartsWithPhrase = titleArrayText.startsWith(phraseQuery);
    const ingredientStartsWithPhrase = activeIngredient.startsWith(phraseQuery);
    if (titleStartsWithPhrase || arrayStartsWithPhrase || ingredientStartsWithPhrase) score += 90;
  }

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
    '';

  return String(jid)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/:\d+$/, '')
    .trim();
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
    if (tokens[i] !== 'vitamina') continue;

    const next = tokens[i + 1];
    const next2 = tokens[i + 2];

    if (next && !STOPWORDS.has(next) && next.length >= 1 && next !== 'vitamina') {
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
    if (tokens[i] !== 'vitamina') continue;

    const next = tokens[i + 1];
    const next2 = tokens[i + 2];
    if (!next) continue;

    if (/^[a-z]$/.test(next) && next2 && /^\d+$/.test(next2)) {
      phrases.push(`vitamina ${next}${next2}`);
    } else {
      phrases.push(`vitamina ${next}`);
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
  return text.length >= 4;
}

function isMenuOption(value) {
  const text = normalizeText(value);
  return text === '1' || text === '2' || text === '3' || text === '4';
}

function extractMedicineQuery(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return '';

  const patterns = [/(?:^|\s)(?:por\s+favor\s+)?(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?|conoces|vendes|venden)\s+(.+)$/i,
    /(?:^|\s)(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a)\s+(.+)$/i
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
    .replace(/^(?:por\s+favor\s+)?(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?|conoces|vendes|venden)\s+/i, '')
    .replace(/^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a)\s+/i, '')
    .trim();

  const tokens = tokenize(candidate)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));

  if (!tokens.length) return '';

  const dosagePattern = /\b(\d+(?:[.,]\d+)?\s?(?:mg|mcg|g|gr|ml|cc|ui|iu|mL|tabletas?|capsulas?|capsules?|ampollas?|suspension|jarabe|gotas|crema|gel|unguento|unguentos|sobres?))\b/i;
  const dosageMatch = candidate.match(dosagePattern);
  if (dosageMatch) {
    const dose = normalizeText(dosageMatch[1]);
    const beforeDose = candidate.slice(0, dosageMatch.index).trim();
    const beforeTokens = tokenize(beforeDose).filter((t) => !STOPWORDS.has(t) && t.length > 1);
    if (beforeTokens.length) {
      return `${beforeTokens.slice(-3).join(' ')} ${dose}`.trim();
    }
    return dose;
  }

  if (tokens.length <= 4) return tokens.join(' ').trim();

  return tokens.slice(-4).join(' ').trim();
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
