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
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '***';
const PORT = process.env.PORT || 3000;
const MEDIA_ANALYSIS_TIMEOUT_MS = Number(process.env.MEDIA_ANALYSIS_TIMEOUT_MS || 45000);
const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OCR_PROVIDER = String(process.env.OCR_PROVIDER || 'auto').toLowerCase();
const GOOGLE_VISION_MODEL = process.env.GOOGLE_VISION_MODEL || 'DOCUMENT_TEXT_DETECTION';
const OPENAI_VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
const OPENAI_VISION_PROMPT = process.env.OPENAI_VISION_PROMPT || 'Extract all readable text from the image, preserving line breaks and returning only the text.';

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function downloadMediaBuffer(media) {
  const downloadMessage = media?.downloadMessage || null;
  if (downloadMessage) {
    try {
      const response = await axios.post(
        `${EVOLUTION_API_URL}/message/downloadimage`,
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
    } catch (error) {
      console.error('❌ Error descargando media vía Evolution GO:', error.response?.data || error.message);
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
    node?.key?.message
  ].filter(Boolean);

  const mediaKeys = [
    'imageMessage',
    'documentMessage',
    'mediaMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage'
  ];

  const buildDescriptor = (media, mediaType) => {
    if (!media || !mediaType) return null;
    const cloned = JSON.parse(JSON.stringify(media));
    const url = cloned.URL || cloned.url || cloned.mediaUrl || cloned.directPath || cloned.thumbnailDirectPath || cloned.thumbnailUrl || cloned.filePath || cloned.path || '';

    return {
      ...cloned,
      mediaType,
      mimeType: cloned.mimeType || cloned.mimetype || '',
      url,
      directPath: cloned.directPath || '',
      fileName: cloned.fileName || cloned.filename || '',
      mediaKey: cloned.mediaKey || '',
      fileEncSHA256: cloned.fileEncSHA256 || '',
      fileSHA256: cloned.fileSHA256 || '',
      headers: cloned.headers || {},
      downloadMessage: { [mediaType]: cloned }
    };
  };

  for (const candidate of candidates) {
    for (const mediaKey of mediaKeys) {
      const media = candidate?.[mediaKey] || candidate?.message?.[mediaKey] || candidate?.Message?.[mediaKey];
      if (!media) continue;

      const descriptor = buildDescriptor(media, mediaKey);
      if (!descriptor) continue;
      if (!descriptor.url && !descriptor.directPath && !descriptor.mediaKey) continue;
      return descriptor;
    }
  }

  return null;
}

function bufferFromEvolutionDownloadResponse(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return Buffer.alloc(0);
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
      try { return Buffer.from(trimmed, 'base64'); } catch (_) {}
    }
    return Buffer.from(trimmed);
  }
  if (data?.base64) return Buffer.from(String(data.base64), 'base64');
  if (data?.image) return bufferFromEvolutionDownloadResponse(data.image);
  if (data?.data) return bufferFromEvolutionDownloadResponse(data.data);
  if (data?.buffer) return bufferFromEvolutionDownloadResponse(data.buffer);
  return Buffer.alloc(0);
}

// ... trimmed for remote update ...
