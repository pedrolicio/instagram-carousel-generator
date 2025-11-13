import { NextResponse } from 'next/server';
import {
  IMAGEN_DEFAULT_ASPECT_RATIO,
  IMAGEN_DEFAULT_PERSON_GENERATION,
  IMAGEN_DEFAULT_SAMPLE_COUNT,
  IMAGEN_DEFAULT_SAFETY_FILTER_LEVEL
} from '../../../src/config/imagenDefaults.js';

export const runtime = 'edge';

const GEMINI_MODEL_NAME = 'gemini-2.5-flash-image';
const IMAGEN_40_MODEL_NAME = 'imagen-4.0-generate-001';
const IMAGEN_40_ULTRA_MODEL_NAME = 'imagen-4.0-ultra-generate-001';
const GEMINI_IMAGE_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent';
const IMAGEN_STANDARD_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict';
const IMAGEN_ULTRA_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-ultra-generate-001:predict';

const MISSING_IMAGE_ERROR_PATTERNS = [
  'não contém uma imagem válida',
  'não contém imagem válida',
  'não retornou imagem',
  'missing image',
  'missing an image_id',
  'missing image_id',
  'invalid image'
];

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://instagram-carousel-generator-git-main-pedro-licios-projects.vercel.app'
];

const IMAGEN_DEFAULT_PARAMETERS = {
  sampleCount: IMAGEN_DEFAULT_SAMPLE_COUNT,
  aspectRatio: IMAGEN_DEFAULT_ASPECT_RATIO,
  outputMimeType: 'image/png',
  safetyFilterLevel: IMAGEN_DEFAULT_SAFETY_FILTER_LEVEL,
  personGeneration: IMAGEN_DEFAULT_PERSON_GENERATION
};

const MIN_SLIDES = 3;
const MAX_SLIDES = 10;
const DEFAULT_SLIDE_COUNT = 5;
const DEFAULT_NEGATIVE_PROMPT =
  'sem texto embutido, sem marcas d\'água, sem fundo escuro, baixa qualidade, borrado, distorcido';
const STYLE_DIRECTIVES =
  'Ilustração vetorial flat moderna, fundo claro suave (ex.: #FAFAFA), ícones geométricos consistentes, gradientes sutis, sombras leves, estética minimalista e profissional, sem texto embutido.';
const RESOLUTION_DIRECTIVE = 'Formato quadrado 1080x1080 pixels, pronto para carrossel do Instagram.';

const makeRequestId = () => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (error) {
    // Ignored – falls back to timestamp-based id below.
  }

  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

const logWithContext = (level, requestId, message, meta) => {
  const prefix = requestId ? `[Imagen][${requestId}]` : '[Imagen]';
  const logger = typeof console[level] === 'function' ? console[level] : console.log;
  if (meta !== undefined) {
    logger(`${prefix} ${message}`, meta);
  } else {
    logger(`${prefix} ${message}`);
  }
};

const logInfo = (requestId, message, meta) => logWithContext('info', requestId, message, meta);
const logWarn = (requestId, message, meta) => logWithContext('warn', requestId, message, meta);
const logError = (requestId, message, meta) => logWithContext('error', requestId, message, meta);

const SENSITIVE_QUERY_PARAMETERS = ['key', 'api_key', 'apikey', 'x-goog-api-key'];

const sanitizeUrlForLogs = (url) => {
  if (typeof url !== 'string' || !url) {
    return url;
  }

  try {
    const parsed = new URL(url);
    for (const param of SENSITIVE_QUERY_PARAMETERS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch (error) {
    return url.replace(/(key|api_key|apikey|x-goog-api-key)=([^&]+)/gi, '$1=[REDACTED]');
  }
};

const formatErrorForLog = (error) => {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }

  const formatted = {
    name: error.name || 'Error',
    message: error.message || null,
    status: error.status ?? null,
    code: error.code || error?.payload?.error?.code || null
  };

  if (error?.payload?.error?.status) {
    formatted.remoteStatus = error.payload.error.status;
  }

  if (error?.payload?.error?.message) {
    formatted.remoteMessage = error.payload.error.message;
  }

  if (error?.details) {
    if (typeof error.details === 'string') {
      formatted.details = truncateForLog(error.details, 800);
    } else if (typeof error.details === 'object') {
      formatted.detailKeys = Object.keys(error.details);
    }
  }

  return formatted;
};

const truncateForLog = (value, maxLength = 500) => {
  if (typeof value !== 'string') {
    return value;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
};

const normalizeString = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const normalizeBase64 = (value) => (typeof value === 'string' ? value.trim() : '');

const clamp = (value, min, max) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
};

const parseSlideCountFromPrompt = (prompt) => {
  const normalized = normalizeString(prompt);
  if (!normalized) return null;

  const matches = normalized.match(/\d+/g);
  if (!matches) return null;

  for (const match of matches) {
    const numeric = Number.parseInt(match, 10);
    if (Number.isFinite(numeric) && numeric >= MIN_SLIDES && numeric <= MAX_SLIDES) {
      return numeric;
    }
  }

  return null;
};

const resolveTargetSlideCount = ({ explicit, providedCount, prompt }) => {
  const explicitNumber = Number.parseInt(explicit, 10);
  if (Number.isFinite(explicitNumber)) {
    return clamp(explicitNumber, MIN_SLIDES, MAX_SLIDES);
  }

  if (Number.isFinite(providedCount) && providedCount > 0) {
    return clamp(providedCount, MIN_SLIDES, MAX_SLIDES);
  }

  const promptNumber = parseSlideCountFromPrompt(prompt);
  if (Number.isFinite(promptNumber)) {
    return clamp(promptNumber, MIN_SLIDES, MAX_SLIDES);
  }

  return DEFAULT_SLIDE_COUNT;
};

const describeSlidePurpose = (index, total, baseContext) => {
  const slideNumber = index + 1;
  const context = normalizeString(baseContext) || 'o tema do carrossel';

  if (slideNumber === 1) {
    return `Capa impactante apresentando ${context} de forma inspiradora.`;
  }

  if (slideNumber === 2) {
    return `Visão geral destacando o principal benefício de ${context}.`;
  }

  if (slideNumber === total - 1 && total > 3) {
    return `Resumo visual das principais ideias sobre ${context}.`;
  }

  if (slideNumber === total) {
    return `Chamada para ação convidando o público a aplicar ${context}.`;
  }

  return `Ilustração representando a dica ${slideNumber - 1} relacionada a ${context}.`;
};

const extractFirstString = (...values) => {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return '';
};

const buildSlideDescription = (slide, index, total, baseContext) => {
  if (!slide || typeof slide !== 'object') {
    return { description: describeSlidePurpose(index, total, baseContext), source: 'generated' };
  }

  const description = extractFirstString(
    slide.visualPrompt,
    slide.visualDescription,
    slide.prompt,
    slide.description,
    slide.imagePrompt,
    slide.body,
    slide.subtitle,
    slide.title,
    slide.topic,
    slide.summary
  );

  if (description) {
    return { description, source: 'provided' };
  }

  return { description: describeSlidePurpose(index, total, baseContext), source: 'generated' };
};

const buildSlidePrompt = ({
  baseContext,
  slideDescription,
  slideNumber,
  totalSlides
}) => {
  const context = normalizeString(baseContext);
  const description = normalizeString(slideDescription);

  const parts = [];

  if (context) {
    parts.push(`Contexto geral: ${context}.`);
  }

  if (description) {
    parts.push(`Slide ${slideNumber} de ${totalSlides}: ${description}.`);
  } else {
    parts.push(`Slide ${slideNumber} de ${totalSlides}.`);
  }

  parts.push(STYLE_DIRECTIVES);
  parts.push(RESOLUTION_DIRECTIVE);

  return parts.join(' ');
};

const mergeNegativePrompt = (customPrompt) => {
  const normalizedCustom = normalizeString(customPrompt);
  if (!normalizedCustom) {
    return DEFAULT_NEGATIVE_PROMPT;
  }

  const lowerBase = DEFAULT_NEGATIVE_PROMPT.toLowerCase();
  if (lowerBase.includes(normalizedCustom.toLowerCase())) {
    return DEFAULT_NEGATIVE_PROMPT;
  }

  return `${DEFAULT_NEGATIVE_PROMPT}, ${normalizedCustom}`;
};

const normalizeSlideInput = (slides, baseContext, targetCount) => {
  const providedSlides = Array.isArray(slides)
    ? slides
        .map((slide, index) => ({
          slide,
          originalIndex: index,
          slideNumber: Number.parseInt(slide?.slideNumber, 10) || index + 1
        }))
        .filter((entry) => entry.slide)
    : [];

  providedSlides.sort((a, b) => a.slideNumber - b.slideNumber);

  const totalSlides = clamp(targetCount || providedSlides.length || DEFAULT_SLIDE_COUNT, MIN_SLIDES, MAX_SLIDES);
  const normalized = [];

  for (let index = 0; index < totalSlides; index += 1) {
    const provided = providedSlides[index];
    const { description, source } = buildSlideDescription(provided?.slide, index, totalSlides, baseContext);
    normalized.push({
      slideNumber: index + 1,
      description,
      source
    });
  }

  return normalized.map((entry, index, collection) => ({
    slideNumber: entry.slideNumber,
    description: entry.description,
    source: entry.source,
    prompt: buildSlidePrompt({
      baseContext,
      slideDescription: entry.description,
      slideNumber: entry.slideNumber,
      totalSlides: collection.length
    })
  }));
};

const buildSlidesForGeneration = ({ prompt, slides, slideCount }) => {
  const baseContext = normalizeString(prompt) || 'carrossel informativo';
  const providedCount = Array.isArray(slides) ? slides.length : 0;
  const targetCount = resolveTargetSlideCount({
    explicit: slideCount,
    providedCount,
    prompt: baseContext
  });

  if (providedCount === 0) {
    return normalizeSlideInput([], baseContext, targetCount);
  }

  return normalizeSlideInput(slides, baseContext, targetCount);
};

const normalizeErrorMessage = (message) => (typeof message === 'string' ? message.toLowerCase() : '');

const hasMissingImageMessage = (message) => {
  const normalized = normalizeErrorMessage(message);
  if (!normalized) {
    return false;
  }

  return MISSING_IMAGE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
};

const isMissingImageError = (error) => {
  if (!error) {
    return false;
  }

  if (hasMissingImageMessage(error.message)) {
    return true;
  }

  const payloadError = error.payload?.error || error.payload;
  if (hasMissingImageMessage(payloadError?.message)) {
    return true;
  }

  if (typeof error.details === 'string' && hasMissingImageMessage(error.details)) {
    return true;
  }

  return false;
};

const parseAllowedOrigins = () => {
  const raw = process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '';
  const entries = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    return ['*', ...DEFAULT_ALLOWED_ORIGINS];
  }

  return Array.from(new Set([...entries, ...DEFAULT_ALLOWED_ORIGINS]));
};

const ALLOWED_ORIGINS = parseAllowedOrigins();

const resolveAllowedOrigin = (requestOrigin) => {
  if (!requestOrigin) {
    return ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS[0];
  }

  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }

  return ALLOWED_ORIGINS[0];
};

const ensureCors = (response, request) => {
  const origin = request?.headers?.get?.('origin');
  const allowedOrigin = resolveAllowedOrigin(origin);

  response.headers.set('Access-Control-Allow-Origin', allowedOrigin || '*');
  response.headers.set('Access-Control-Allow-Methods', 'POST,OPTIONS');

  const requestHeaders = request?.headers?.get?.('access-control-request-headers');
  const allowedHeaders = requestHeaders || 'Content-Type,X-Goog-Api-Key';
  response.headers.set('Access-Control-Allow-Headers', allowedHeaders);

  if (allowedOrigin !== '*') {
    response.headers.set('Vary', 'Origin');
  }

  return response;
};

const jsonResponse = (data, init, request) => ensureCors(NextResponse.json(data, init), request);

const PROMPT_EXEMPLO =
  'Ilustração minimalista 1080x1080 de uma banana geométrica centralizada, fundo azul-claro #A3D9FF, sombras suaves, sem pessoas, estilo clean de identidade visual.';

const collectCandidateContentParts = (payload) => {
  const parts = [];
  if (!payload || typeof payload !== 'object') {
    return parts;
  }

  const candidates = payload.candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const candidateParts =
        candidate?.content?.parts ||
        candidate?.content?.data ||
        candidate?.content?.contents ||
        candidate?.parts ||
        candidate?.contents ||
        [];
      if (Array.isArray(candidateParts)) {
        parts.push(...candidateParts);
      } else if (candidateParts) {
        parts.push(candidateParts);
      }
    }
  }

  const contents = payload.contents;
  if (Array.isArray(contents)) {
    for (const content of contents) {
      const contentParts = content?.parts || content?.data || content?.contents || [];
      if (Array.isArray(contentParts)) {
        parts.push(...contentParts);
      } else if (contentParts) {
        parts.push(contentParts);
      }
    }
  }

  return parts;
};

const pickBase64FromValue = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = pickBase64FromValue(item);
      if (candidate) return candidate;
    }
    return '';
  }

  if (!value) return '';

  const candidates = [
    value.data,
    value.base64,
    value.b64,
    value.imageBase64,
    value.image_base64,
    value.base64Image,
    value.base64_image,
    value.bytesBase64Encoded,
    value.bytes_base64_encoded,
    value
  ];

  for (const candidate of candidates) {
    const normalized = normalizeBase64(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const resolveFileUriFromValue = (value) => {
  const candidates = Array.isArray(value)
    ? value
    : [value?.fileData, value?.file_data, value?.media, value?.mediaData, value?.media_data, value];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;

    const uri =
      candidate.fileUri ||
      candidate.file_uri ||
      candidate.uri ||
      candidate.url ||
      candidate.source ||
      candidate.downloadUri ||
      candidate.download_uri;

    if (typeof uri === 'string' && uri.startsWith('http')) {
      return uri;
    }
  }

  return '';
};

const collectMediaCandidates = (payload) => {
  const entries = [];
  if (!payload) return entries;

  const parts = collectCandidateContentParts(payload);
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    const base64 = pickBase64FromValue(inline) || pickBase64FromValue(part);
    const fileUri = resolveFileUriFromValue(part);

    if (base64 || fileUri) {
      entries.push({ base64, fileUri });
    }
  }

  const fallbackContainers = [
    payload?.files,
    payload?.generatedImages,
    payload?.generated_images,
    payload?.images
  ];

  for (const container of fallbackContainers) {
    if (!container) continue;
    const items = Array.isArray(container) ? container : [container];
    for (const item of items) {
      const base64 = pickBase64FromValue(item);
      const fileUri = resolveFileUriFromValue(item);
      if (base64 || fileUri) {
        entries.push({ base64, fileUri });
      }
    }
  }

  return entries;
};

const extractFileUri = (payload) => {
  if (!payload) return '';

  const contentParts = collectCandidateContentParts(payload);
  for (const part of contentParts) {
    const fileData =
      part?.fileData ||
      part?.file_data ||
      part?.media ||
      part?.mediaData ||
      part?.media_data ||
      part;
    const fileUri =
      fileData?.fileUri ||
      fileData?.file_uri ||
      fileData?.uri ||
      fileData?.source ||
      fileData?.downloadUri ||
      fileData?.download_uri ||
      fileData?.url;
    if (typeof fileUri === 'string' && fileUri.startsWith('https://')) {
      return fileUri;
    }
  }

  const fallbackUris = [
    payload?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri,
    payload?.candidates?.[0]?.content?.parts?.[0]?.file_data?.file_uri,
    payload?.files?.[0]?.uri,
    payload?.generatedImages?.[0]?.fileUri
  ];

  return fallbackUris.find((u) => typeof u === 'string' && u.startsWith('https://')) || '';
};

const extractBase64 = (payload) => {
  if (!payload) return '';

  const parts = collectCandidateContentParts(payload);
  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    const inlineBase64 = inline?.data || inline?.base64 || inline?.b64 || inline?.imageBase64;
    if (typeof inlineBase64 === 'string' && inlineBase64.trim()) {
      return inlineBase64.trim();
    }

    const direct =
      part?.data ||
      part?.base64 ||
      part?.b64 ||
      part?.imageBase64 ||
      part?.image_base64 ||
      part?.base64Image ||
      part?.base64_image;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim();
    }
  }

  const visited = new Set();
  const queue = [payload];

  const pickBase64 = (value) => {
    const candidates = Array.isArray(value)
      ? value
      : [
          value?.data,
          value?.base64,
          value?.b64,
          value?.bytesBase64Encoded,
          value?.bytes_base64_encoded,
          value?.base64Image,
          value?.base64_image,
          value?.imageBase64,
          value?.image_base64,
          value
        ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return '';
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (typeof current !== 'object') continue;

    const inline = current.inlineData || current.inline_data;
    const inlineBase64 = pickBase64(inline);
    if (inlineBase64) return inlineBase64;

    const directBase64 = pickBase64(current);
    if (directBase64) return directBase64;

    const nestedKeys = [
      'predictions',
      'candidates',
      'generatedImages',
      'generated_images',
      'images',
      'contents',
      'content',
      'data',
      'items',
      'output',
      'outputs',
      'media',
      'mediaData',
      'media_data'
    ];

    for (const key of nestedKeys) {
      const value = current[key];
      if (value) {
        queue.push(value);
      }
    }
  }

  return '';
};

const detectSafetyBlock = (payload) => {
  if (!payload || typeof payload !== 'object') return null;

  const reasons = new Set();
  const messages = new Set();
  const queue = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    if (typeof current !== 'object') continue;

    const finishReason = current.finishReason || current.finish_reason;
    if (typeof finishReason === 'string') {
      const normalized = finishReason.toUpperCase();
      if (normalized.includes('SAFETY')) {
        reasons.add('SAFETY');
      }
    }

    const blockReason = current.blockReason || current.block_reason;
    if (typeof blockReason === 'string') {
      const normalized = blockReason.toUpperCase();
      if (normalized.includes('SAFETY')) {
        reasons.add('SAFETY');
      }
    }

    const description = current.description || current.message || current.text;
    if (typeof description === 'string' && description.trim()) {
      messages.add(description.trim());
    }

    const safetyRatings = current.safetyRatings || current.safety_ratings;
    if (Array.isArray(safetyRatings)) {
      for (const rating of safetyRatings) {
        const category = rating?.category;
        const blocked = rating?.blocked || rating?.probability === 'VERY_LIKELY';
        if (blocked && typeof category === 'string') {
          reasons.add('SAFETY');
          messages.add(category.replace(/^HARM_CATEGORY_/, '').replace(/_/g, ' ').toLowerCase());
        }
      }
    }

    Object.values(current).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  if (!reasons.has('SAFETY')) {
    return null;
  }

  const detail = Array.from(messages).join(' ').trim();
  return detail || 'Conteúdo bloqueado por segurança.';
};

const isQuotaError = (error) => {
  const status = error?.status;
  if (status === 429) return true;
  const message = (error?.message || '').toLowerCase();
  if (message.includes('quota') || message.includes('rate limit') || message.includes('exceeded')) {
    return true;
  }
  const payloadMessage = (error?.payload?.error?.message || '').toLowerCase();
  return payloadMessage.includes('quota') || payloadMessage.includes('rate limit');
};

const callApi = async (url, payload, apiKey, context = {}) => {
  const { requestId, step } = context;
  const sanitizedUrl = sanitizeUrlForLogs(url);
  logInfo(requestId, `Enviando requisição ${step || ''}`.trim(), {
    url: sanitizedUrl,
    hasPayload: Boolean(payload),
    payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload) : []
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey
    },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || `Falha na chamada da API (${response.status}).`;
    const apiError = new Error(message);
    apiError.status = response.status;
    apiError.payload = data;
    logError(requestId, `Resposta não-ok da API em ${step || sanitizedUrl}`, {
      status: response.status,
      statusText: response.statusText,
      requestUrl: sanitizedUrl,
      body: data?.error || data,
      message
    });
    throw apiError;
  }

  logInfo(requestId, `Resposta bem-sucedida em ${step || sanitizedUrl}`, {
    status: response.status,
    requestUrl: sanitizedUrl,
    hasData: Boolean(data),
    dataKeys: data && typeof data === 'object' ? Object.keys(data) : []
  });

  return data;
};

const buildImagenPredictPayload = ({ prompt, negativePrompt, parameters }) => {
  const instance = { prompt };

  if (negativePrompt) {
    instance.negativePrompt = negativePrompt;
    instance.negative_prompt = negativePrompt;
  }

  const mergedParameters = {
    ...IMAGEN_DEFAULT_PARAMETERS,
    ...(parameters || {})
  };

  const compatibility = {};

  if (mergedParameters.sampleCount != null) {
    compatibility.sample_count = mergedParameters.sampleCount;
  }

  if (mergedParameters.aspectRatio) {
    compatibility.aspect_ratio = mergedParameters.aspectRatio;
  }

  if (mergedParameters.outputMimeType) {
    compatibility.output_mime_type = mergedParameters.outputMimeType;
  }

  if (mergedParameters.safetyFilterLevel) {
    compatibility.safety_filter_level = mergedParameters.safetyFilterLevel;
  }

  if (mergedParameters.personGeneration) {
    compatibility.person_generation = mergedParameters.personGeneration;
  }

  return {
    instances: [instance],
    parameters: {
      ...mergedParameters,
      ...compatibility
    }
  };
};

const callGeminiBatchModel = async ({ slides, negativePrompt, apiKey, requestId }) => {
  const url = new URL(GEMINI_IMAGE_ENDPOINT);
  url.searchParams.set('key', apiKey);

  const slideCount = Array.isArray(slides) ? slides.length : 0;
  const safeSlides = Array.isArray(slides) ? slides : [];

  const introText = `Gere ${slideCount} ilustrações consistentes para um carrossel de Instagram. Use estilo flat minimalista, fundo claro e mantenha a paleta e iluminação semelhantes em todos os slides.`;

  const parts = [
    { text: introText },
    ...safeSlides.map((slide) => ({
      text: `Slide ${slide.slideNumber}: ${slide.prompt}`
    }))
  ];

  if (negativePrompt) {
    parts.push({ text: `Restrições visuais: ${negativePrompt}` });
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts
      }
    ]
  };

  const result = await callApi(url.toString(), payload, apiKey, {
    requestId,
    step: `${GEMINI_MODEL_NAME} (batch)`
  });
  return result;
};

const callImagenStandardApi = async ({ prompt, negativePrompt, apiKey, requestId }) => {
  const url = new URL(IMAGEN_STANDARD_ENDPOINT);
  url.searchParams.set('key', apiKey);

  const payload = buildImagenPredictPayload({ prompt, negativePrompt });

  const result = await callApi(url.toString(), payload, apiKey, {
    requestId,
    step: IMAGEN_40_MODEL_NAME
  });
  return result;
};

const callImagenUltraApi = async ({ prompt, negativePrompt, apiKey, requestId }) => {
  const url = new URL(IMAGEN_ULTRA_ENDPOINT);
  url.searchParams.set('key', apiKey);

  const payload = buildImagenPredictPayload({
    prompt,
    negativePrompt,
    parameters: {
      ...IMAGEN_DEFAULT_PARAMETERS,
      sampleCount: 1
    }
  });

  const result = await callApi(url.toString(), payload, apiKey, {
    requestId,
    step: IMAGEN_40_ULTRA_MODEL_NAME
  });
  return result;
};

const generateImageWithImagenFallback = async ({
  prompt,
  negativePrompt,
  apiKey,
  requestId,
  tracker,
  slideNumber
}) => {
  const track = (step, status, extra) => {
    if (!Array.isArray(tracker)) return;
    tracker.push({
      slide_number: slideNumber,
      modelo: step,
      status,
      ...(extra || {})
    });
  };

  const attemptModel = async (callFn, modelName) => {
    track(modelName, 'pending');
    const response = await callFn();

    const safetyDetail = detectSafetyBlock(response);
    if (safetyDetail) {
      const safetyError = new Error('Bloqueado por segurança');
      safetyError.status = 422;
      safetyError.details = safetyDetail;
      track(modelName, 'safety_block', { detalhe: safetyDetail });
      throw safetyError;
    }

    const base64 = await resolveBase64Image(response, apiKey);
    if (base64) {
      track(modelName, 'success');
      return { base64, model: modelName };
    }

    const noImageError = new Error(`O modelo ${modelName} não retornou imagem.`);
    noImageError.status = 502;
    noImageError.details = response;
    track(modelName, 'invalid_response');
    throw noImageError;
  };

  try {
    return await attemptModel(
      () => callImagenStandardApi({ prompt, negativePrompt, apiKey, requestId }),
      IMAGEN_40_MODEL_NAME
    );
  } catch (primaryError) {
    const shouldTryUltra =
      isMissingImageError(primaryError) ||
      !primaryError?.status ||
      primaryError.status >= 500 ||
      primaryError.status === 404 ||
      primaryError.status === 405;

    if (!shouldTryUltra && primaryError?.status && primaryError.status < 500 && primaryError.status !== 422) {
      track(IMAGEN_40_MODEL_NAME, 'failed', formatErrorForLog(primaryError));
      throw primaryError;
    }

    try {
      return await attemptModel(
        () => callImagenUltraApi({ prompt, negativePrompt, apiKey, requestId }),
        IMAGEN_40_ULTRA_MODEL_NAME
      );
    } catch (ultraError) {
      track(IMAGEN_40_ULTRA_MODEL_NAME, 'failed', formatErrorForLog(ultraError));
      ultraError.cause = primaryError;
      throw ultraError;
    }
  }
};

const arrayBufferToBase64 = (arrayBuffer) => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(arrayBuffer).toString('base64');
  }

  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }

  if (typeof btoa === 'function') {
    return btoa(binary);
  }

  return '';
};

const fetchFileUriAsBase64 = async (fileUri, apiKey) => {
  if (!fileUri || typeof fileUri !== 'string') {
    return '';
  }

  try {
    const headers = {};
    if (apiKey) {
      headers['X-Goog-Api-Key'] = apiKey;
    }

    const response = await fetch(fileUri, { headers });
    if (!response.ok) {
      return '';
    }

    const arrayBuffer = await response.arrayBuffer();
    return arrayBufferToBase64(arrayBuffer);
  } catch (error) {
    console.error('[Imagen] Falha ao baixar fileUri:', error);
    return '';
  }
};

const resolveBase64Image = async (payload, apiKey) => {
  const inlineBase64 = extractBase64(payload);
  if (inlineBase64) {
    return inlineBase64;
  }

  const fileUri = extractFileUri(payload);
  if (!fileUri) {
    return '';
  }

  const base64 = await fetchFileUriAsBase64(fileUri, apiKey);
  return base64;
};

const resolveAllBase64Images = async (payload, apiKey) => {
  const candidates = collectMediaCandidates(payload);
  if (!candidates.length) {
    return [];
  }

  const seen = new Set();
  const uniqueCandidates = candidates.filter((candidate) => {
    const base64Key = candidate.base64 ? `b64:${candidate.base64.slice(0, 40)}` : '';
    const fileUriKey = candidate.fileUri ? `uri:${candidate.fileUri}` : '';
    const key = base64Key || fileUriKey;
    if (!key) {
      return false;
    }

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  const results = [];

  for (const candidate of uniqueCandidates) {
    let base64 = normalizeBase64(candidate.base64);
    const fileUri = candidate.fileUri || '';

    if (!base64 && fileUri) {
      const fetched = await fetchFileUriAsBase64(fileUri, apiKey);
      base64 = normalizeBase64(fetched);
    }

    if (base64) {
      results.push({ base64, fileUri });
    }
  }

  return results;
};

const generateImagesBatch = async ({ slides, negativePrompt, apiKey, requestId }) => {
  if (!Array.isArray(slides) || slides.length === 0) {
    throw new Error('Nenhum slide disponível para geração de imagens.');
  }

  const fallbackTracker = [];

  const mapSlidesWithImages = (images) =>
    slides.map((slide, index) => {
      const resolved = images[index] || {};
      return {
        slide_number: slide.slideNumber,
        prompt_gerado: slide.prompt,
        modelo_utilizado: resolved.model || (resolved.base64 ? resolved.modelName || GEMINI_MODEL_NAME : null),
        imagem_base64: resolved.base64 || null,
        file_uri: resolved.fileUri || null
      };
    });

  try {
    logInfo(requestId, `Iniciando batch com ${GEMINI_MODEL_NAME}.`, { totalSlides: slides.length });
    const gemini = await callGeminiBatchModel({ slides, negativePrompt, apiKey, requestId });

    const safetyDetail = detectSafetyBlock(gemini);
    if (safetyDetail) {
      const safetyError = new Error('Bloqueado por segurança');
      safetyError.status = 422;
      safetyError.details = safetyDetail;
      logWarn(requestId, `${GEMINI_MODEL_NAME} bloqueou por segurança.`, { detail: safetyDetail });
      throw safetyError;
    }

    const geminiImagesRaw = await resolveAllBase64Images(gemini, apiKey);
    const geminiImages = geminiImagesRaw.map((entry) => ({
      ...entry,
      base64: entry.base64,
      model: GEMINI_MODEL_NAME,
      modelName: GEMINI_MODEL_NAME
    }));

    const mapped = mapSlidesWithImages(geminiImages);
    const missingIndices = mapped
      .map((item, index) => (!item.imagem_base64 ? index : -1))
      .filter((index) => index >= 0);

    if (missingIndices.length === 0) {
      logInfo(requestId, `${GEMINI_MODEL_NAME} retornou todas as imagens com sucesso.`);
      return {
        images: mapped,
        fallbackUsed: false,
        fallbackTracker,
        primaryModel: GEMINI_MODEL_NAME
      };
    }

    logWarn(requestId, `${GEMINI_MODEL_NAME} retornou menos imagens do que o esperado. Iniciando fallback.`, {
      missingSlides: missingIndices.map((index) => slides[index]?.slideNumber)
    });

    for (const index of missingIndices) {
      const slide = slides[index];
      try {
        const fallbackResult = await generateImageWithImagenFallback({
          prompt: slide.prompt,
          negativePrompt,
          apiKey,
          requestId,
          tracker: fallbackTracker,
          slideNumber: slide.slideNumber
        });

        mapped[index] = {
          slide_number: slide.slideNumber,
          prompt_gerado: slide.prompt,
          modelo_utilizado: fallbackResult.model,
          imagem_base64: fallbackResult.base64,
          file_uri: null
        };
      } catch (fallbackError) {
        logError(
          requestId,
          `Fallback falhou para o slide ${slide.slideNumber}.`,
          formatErrorForLog(fallbackError)
        );
        throw fallbackError;
      }
    }

    return {
      images: mapped.map((item) => ({
        ...item,
        modelo_utilizado: item.modelo_utilizado || GEMINI_MODEL_NAME
      })),
      fallbackUsed: true,
      fallbackTracker,
      primaryModel: GEMINI_MODEL_NAME
    };
  } catch (error) {
    const shouldTryLegacy =
      isMissingImageError(error) ||
      !error?.status ||
      error.status >= 500 ||
      error.status === 404 ||
      error.status === 405;

    if (!shouldTryLegacy && error?.status !== 422) {
      logError(requestId, `Falha irrecuperável em ${GEMINI_MODEL_NAME}.`, formatErrorForLog(error));
      throw error;
    }

    logWarn(
      requestId,
      `${GEMINI_MODEL_NAME} indisponível (fallbackCandidate=${shouldTryLegacy}). Gerando com Imagen.`,
      formatErrorForLog(error)
    );

    const mapped = [];

    for (const slide of slides) {
      try {
        const fallbackResult = await generateImageWithImagenFallback({
          prompt: slide.prompt,
          negativePrompt,
          apiKey,
          requestId,
          tracker: fallbackTracker,
          slideNumber: slide.slideNumber
        });

        mapped.push({
          slide_number: slide.slideNumber,
          prompt_gerado: slide.prompt,
          modelo_utilizado: fallbackResult.model,
          imagem_base64: fallbackResult.base64,
          file_uri: null
        });
      } catch (fallbackError) {
        logError(
          requestId,
          `Fallback falhou para o slide ${slide.slideNumber}.`,
          formatErrorForLog(fallbackError)
        );
        throw fallbackError;
      }
    }

    return {
      images: mapped,
      fallbackUsed: true,
      fallbackTracker,
      primaryModel: GEMINI_MODEL_NAME
    };
  }
};

export async function OPTIONS(request) {
  return ensureCors(new NextResponse(null, { status: 204 }), request);
}

export async function POST(request) {
  const requestId = makeRequestId();
  const origin = request?.headers?.get?.('origin') || null;
  logInfo(requestId, 'Requisição recebida para geração de imagem.', { origin });

  let body;
  try {
    body = await request.json();
  } catch (error) {
    logError(requestId, 'Falha ao interpretar JSON da requisição.', formatErrorForLog(error));
    return jsonResponse({ error: 'Corpo da requisição inválido.' }, { status: 400 }, request);
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const slidesInput = Array.isArray(body?.slides) ? body.slides : [];
  const slideCountInput =
    body?.slideCount ?? body?.slidesCount ?? body?.totalSlides ?? slidesInput.length ?? null;
  const negativePromptInput = typeof body?.negativePrompt === 'string' ? body.negativePrompt.trim() : '';
  const providedKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
  const apiKey = providedKey || (process.env.GOOGLE_API_KEY || '').trim();

  if (!apiKey) {
    logWarn(requestId, 'Requisição sem API key.');
    return jsonResponse({ error: 'A API Key é obrigatória.' }, { status: 401 }, request);
  }

  if (!prompt && slidesInput.length === 0) {
    logWarn(requestId, 'Prompt e lista de slides ausentes na requisição.');
    return jsonResponse({ error: 'Informe um prompt base ou os detalhes dos slides.' }, { status: 400 }, request);
  }

  const slidesForGeneration = buildSlidesForGeneration({
    prompt,
    slides: slidesInput,
    slideCount: slideCountInput
  });

  const resolvedNegativePrompt = mergeNegativePrompt(negativePromptInput);

  logInfo(requestId, 'Contexto recebido para geração.', {
    prompt: prompt ? truncateForLog(prompt) : undefined,
    slides: slidesForGeneration.length,
    negativePrompt: truncateForLog(resolvedNegativePrompt, 200)
  });

  logInfo(requestId, 'Prompts visuais gerados para os slides.', {
    slides: slidesForGeneration.map((slide) => ({
      slide: slide.slideNumber,
      origem: slide.source,
      prompt: truncateForLog(slide.prompt, 200)
    }))
  });

  try {
    const generationResult = await generateImagesBatch({
      slides: slidesForGeneration,
      negativePrompt: resolvedNegativePrompt,
      apiKey,
      requestId
    });

    logInfo(requestId, 'Imagens geradas com sucesso.', {
      fallback: generationResult.fallbackUsed,
      totalSlides: slidesForGeneration.length
    });

    const responsePayload = {
      requestId,
      modelo_principal: generationResult.primaryModel,
      negative_prompt_utilizado: resolvedNegativePrompt,
      fallback: {
        utilizado: generationResult.fallbackUsed,
        etapas: generationResult.fallbackTracker
      },
      imagens: generationResult.images
    };

    if (generationResult.images.length === 1 && generationResult.images[0]?.imagem_base64) {
      responsePayload.image = generationResult.images[0].imagem_base64;
    }

    return jsonResponse(responsePayload, undefined, request);
  } catch (error) {
    const formattedError = formatErrorForLog(error);
    logError(requestId, 'Falha ao gerar imagem.', formattedError);

    if (error?.status === 422 && error.message.includes('Bloqueado')) {
      return jsonResponse({ error: 'Bloqueado por segurança', detalhes: error.details || null }, { status: 422 }, request);
    }

    if (isQuotaError(error)) {
      return jsonResponse({ error: 'Quota excedida', detalhes: error.message }, { status: error.status || 429 }, request);
    }

    const status = error?.status && Number.isInteger(error.status) ? error.status : 500;
    const message = error?.message || 'Falha ao gerar imagem.';
    return jsonResponse({ error: message, exemplo: PROMPT_EXEMPLO }, { status }, request);
  }
}
