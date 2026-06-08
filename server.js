require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de Firebase y Evolution API
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'https://evolution-go-dd3c.onrender.com';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'd40b6635-752d-438a-9cfc-a8eff38385f9';

let db = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: String(process.env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n')
        })
      });
    }
  }
  db = admin.firestore();
} catch (error) {
  console.error('❌ Firebase no inicializado:', error.message);
}

// Endpoint principal del webhook
app.post('/webhook', async (req, res) => {
  try {
    const { event, data } = req.body || {};

    console.log('📩 Evento recibido:', event);

    const normalizedEvent = String(event || '').toLowerCase();
    if (normalizedEvent === 'messages.upsert' || normalizedEvent === 'message') {
      await processIncomingMessage(data || req.body);
    }

    if (normalizedEvent === 'messages.update') {
      await processMessageUpdate(data || req.body);
    }

    res.status(200).json({
      status: 'success',
      message: 'Webhook processado correctamente',
      event,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error en webhook:', error);
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

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
  const text = normalizeText(value);
  if (!text) return [];
  return text.split(' ').filter(Boolean);
}

function extractFrom(payload) {
  return String(
    payload?.Info?.Sender ||
    payload?.Info?.Chat ||
    payload?.key?.remoteJid ||
    payload?.from ||
    ''
  ).replace(/@s\.whatsapp\.net$/,'');
}

function extractBody(payload) {
  return String(
    payload?.Message?.conversation ||
    payload?.Message?.extendedTextMessage?.text ||
    payload?.message?.conversation ||
    payload?.text ||
    payload?.body ||
    ''
  );
}

function extractFromMe(payload) {
  const value = payload?.Info?.IsFromMe ?? payload?.key?.fromMe ?? payload?.fromMe;
  return Boolean(value);
}

const STOPWORDS = new Set([
  'por','favor','me','puede','puedes','informar','informe','informacion','información','dime','decime','quiero','necesito',
  'ver','buscar','consulta','consultar','disponibilidad','hay','tienen','tienes','tiene','precio','coste','costo','stock',
  'de','del','la','el','los','las','un','una','unos','unas','para','con','sin','y','o','u','en','al','a','que','si','porfa',
  'mostrar','muestra','consultame','consulte','pueden','podrias','podrías','favorito','quisiera','interesa','interesado',
  'estoy','buscando','busque','buscame','verme','saber','saberde','sobre','respecto','acerca','informarme','siempre'
]);

function extractMedicineQuery(text) {
  const cleaned = normalizeText(text);
  if (!cleaned) return '';

  const extractionPatterns = [
    /(?:^|\s)(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?)\s+(.+)$/i,
    /(?:^|\s)(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a)\s+(.+)$/i
  ];

  let candidate = cleaned;
  for (const pattern of extractionPatterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      candidate = normalizeText(match[1]);
      break;
    }
  }

  candidate = candidate
    .replace(/^(?:por\s+favor\s+)?(?:me\s+puedes\s+ayudar\s+con|me\s+ayudas\s+con|necesito|busco|busque|buscame|buscando|quiero|quisiera|me\s+interesa|me\s+interesan|tienes|tiene|tienen|hay|disponibilidad(?:\s+de)?|disponible(?:s)?|informar(?:\s+sobre)?|informe(?:\s+sobre)?|consultar(?:\s+sobre)?|consulta(?:\s+sobre)?|informame(?:\s+sobre)?|informarme(?:\s+sobre)?|precio(?:\s+de)?)\s+/i, '')
    .replace(/^(?:de|del|para|con|sobre|acerca\s+de|respecto\s+a)\s+/i, '')
    .trim();

  const tokens = tokenize(candidate)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));

  if (!tokens.length) return '';

  const normalized = tokens.join(' ').trim();
  if (tokens.length <= 5) return normalized;

  return tokens.slice(-5).join(' ').trim();
}

function getProductText(item) {
  return normalizeText([item.ProductTitle, ...(Array.isArray(item.productTitleArray) ? item.productTitleArray : [])].filter(Boolean).join(' '));
}

function scoreProduct(query, item) {
  const title = getProductText(item);
  const tokens = tokenize(query).filter((t) => t.length > 1);
  if (!title || !tokens.length) return 0;

  // Solo coincidencias reales en el título o sus keywords.
  // Evita que aparezcan productos sin relación.
  let score = 0;
  const exactQuery = normalizeText(query);

  if (title.includes(exactQuery)) score += 50;

  for (const token of tokens) {
    if (title.includes(token)) score += 10;
  }

  // Requiere al menos una coincidencia clara.
  const matches = tokens.filter((token) => title.includes(token)).length;
  if (matches === 0) return 0;

  // Refuerzo si el primer token aparece en el título al inicio de alguna palabra.
  const firstToken = tokens[0];
  if (firstToken && new RegExp(`(^|\\s)${firstToken}`).test(title)) score += 8;

  return score;
}

function formatPrice(value) {
  const num = Number(value);
  if (Number.isNaN(num)) return String(value);
  return new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
}

function getPriceUsd(item) {
  const raw = item.ProductPrice ?? item.productPrice ?? item.price ?? item.Price ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const normalized = String(raw).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return normalized ? Number(normalized[0]) : null;
}

async function getBcvRate() {
  if (!db) throw new Error('Firestore no está inicializado');
  try {
    const snap = await db.collection('divisabcv').limit(1).get();
    if (snap.empty) return null;
    const data = snap.docs[0].data() || {};
    const rate = Number(String(data.DivisaBs ?? '').replace(',', '.'));
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch (error) {
    console.error('❌ Error leyendo tasa BCV:', error.message);
    return null;
  }
}

async function searchProducts(query) {
  if (!db) throw new Error('Firestore no está inicializado');
  const rate = await getBcvRate();
  const snap = await db.collection('products-market').limit(2000).get();
  const items = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const scored = items
    .map((item) => {
      const score = scoreProduct(query, item);
      const priceUsd = getPriceUsd(item);
      const priceBs = priceUsd !== null && rate ? priceUsd * rate : null;
      return { item, score, priceUsd, priceBs };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      const scoreA = a.score || 0;
      const scoreB = b.score || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      const priceA = a.priceUsd ?? Number.MAX_SAFE_INTEGER;
      const priceB = b.priceUsd ?? Number.MAX_SAFE_INTEGER;
      return priceA - priceB;
    });

  return { rate, scored };
}

function buildProductResultsMessage(query, rate, scored) {
  const lines = [];
  lines.push(`🔎 *Resultados para: ${query}*`);
  if (rate) lines.push(`💱 Tasa BCV: *Bs ${formatPrice(rate)}* por *$1*`);
  lines.push('');

  scored.slice(0, 10).forEach((row, idx) => {
    const title = String(row.item.ProductTitle || 'Medicamento').trim();
    const usd = row.priceUsd !== null ? `$${formatPrice(row.priceUsd)}` : 'No disponible';
    const bs = row.priceBs !== null ? `Bs ${formatPrice(row.priceBs)}` : 'No disponible';
    lines.push(`💊 *${idx + 1}. ${title}*`);
    lines.push(`💵 ${usd}  |  💠 ${bs}`);
    lines.push('');
  });

  if (scored.length > 10) {
    lines.push(`ℹ️ Se muestran los *10* mejores resultados de *${scored.length}* coincidencias.`);
  }

  return lines.join('\n').trim();
}

async function processIncomingMessage(payload) {
  try {
    const from = extractFrom(payload);
    const body = extractBody(payload);
    const fromMe = extractFromMe(payload);

    if (fromMe) return;
    if (!from || !body) {
      console.log('⚠️ Payload sin from/body útil:', JSON.stringify(payload));
      return;
    }

    console.log('📨 Nuevo mensaje entrante:', { from, body });

    const autoResponse = await generateAutoResponse(body);
    if (autoResponse) {
      await sendWhatsAppMessage(from, autoResponse);
    }
  } catch (error) {
    console.error('❌ Error procesando mensaje:', error);
  }
}

async function processMessageUpdate(messageUpdate) {
  const { message, status } = messageUpdate;
  console.log('📊 Actualización de mensaje:', status);
}

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
  } catch (error) {
    console.error('❌ Error enviando WhatsApp:', error.message);
    console.error('Detalle:', error.response?.data);
  }
}

async function generateAutoResponse(message) {
  const query = normalizeText(message);

  if (!query) {
    return `🤖 *Asistente Gentefarma*\n\nEscribe el nombre de un medicamento o *auxiliar*.`;
  }

  if (query.match(/\b(hola|buenos|buenas|hi|hey)\b/)) {
    return `Gracias por comunicarte con el Agente IA de Gentefarma. Si buscas un medicamento específico, simplemente escribe el nombre (por ejemplo: atamel). Si necesitas hablar con uno de nuestros auxiliares, escribe ‘auxiliar’`;
  }

  if (query === 'auxiliar' || query.match(/\b(quiero\s+hablar\s+con\s+un\s+auxiliar|hablar\s+con\s+un\s+auxiliar|me\s+atiende\s+un\s+humano|hablar\s+con\s+alguien|quiero\s+un\s+humano|necesito\s+un\s+humano|auxiliar|humano|asesor|operador)\b/)) {
    return `👩‍⚕️ Claro, te conectamos con un auxiliar.\n\nEscribe tu consulta o el nombre del medicamento.`;
  }

  if (query.match(/\b(gracias|hasta|adios|adiós)\b/)) {
    return `👋 ¡Gracias por contactar a Gentefarma!\n\nSi necesitas algo más, escribe el nombre del medicamento o *auxiliar*.`;
  }

  const productQuery = extractMedicineQuery(query);
  if (productQuery) {
    try {
      const { rate, scored } = await searchProducts(productQuery);

      if (!scored.length) {
        return `⚠️ No encontré resultados para *${productQuery}*.\n\nPrueba con un nombre más corto, por ejemplo: *oxacilina*, *atamel*, *fulgram*.`;
      }

      return buildProductResultsMessage(productQuery, rate, scored);
    } catch (error) {
      console.error('❌ Error buscando productos:', error.message);
      return `⚠️ No pude consultar el catálogo en este momento.`;
    }
  }

  if (query.match(/\b(producto|medicamento|farmacia)\b/)) {
    return `📦 *PRODUCTOS DISPONIBLES*\n\nEscribe el nombre del medicamento y te mostraré los resultados.\n\nEjemplos:\n• *atamel*\n• *fulgram*\n• *oxacilina 1gr*`;
  }

  return `🤖 *Asistente Gentefarma*\n\nEscribe el nombre de un medicamento o *auxiliar*.`;
}

function extractMedicineQuery(text) {
  const tokens = tokenize(text)
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));

  if (!tokens.length) return null;

  const joined = tokens.join(' ');

  // Si el texto incluye palabras de contexto pero también un nombre de medicamento,
  // devolvemos solo las keywords útiles.
  if (joined.length >= 3) return joined;

  return null;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gentefarma-webhook',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Gentefarma Webhook Service running on port ${PORT}`);
});
