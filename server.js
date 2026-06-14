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

async function extractTextFromMedia(media) {
  const inlineBuffer = bufferFromInlineBase64(media?.base64 || media?.inlineBase64 || media?.rawBase64 || media?.payloadBase64 || media?.content || media?.data);
  const buffer = (inlineBuffer && inlineBuffer.length) ? inlineBuffer : await downloadMediaBuffer(media);
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
