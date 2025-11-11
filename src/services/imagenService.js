import { buildImagenPrompt, buildNegativePrompt } from '../utils/promptBuilder.js';

const IMAGEN_CONFIG = {
  aspectRatio: '4:5',
  numberOfImages: 1,
  safetyFilterLevel: 'block_some',
  personGeneration: 'allow_adult'
};

const IMAGEN_MODEL = 'models/imagen-3.0';
const GENERATE_IMAGES_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/${IMAGEN_MODEL}:generateImages`;
const LEGACY_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict';

const extractBase64Image = (payload) => {
  if (!payload) return '';

  const candidates = [
    payload?.predictions?.[0]?.bytesBase64Encoded,
    payload?.predictions?.[0]?.base64Image,
    payload?.images?.[0]?.base64,
    payload?.images?.[0]?.content,
    payload?.images?.[0]?.content?.base64,
    payload?.artifacts?.[0]?.base64,
    payload?.data?.[0]?.b64_json,
    payload?.generatedImages?.[0]?.bytesBase64Encoded
  ];

  return candidates.find((v) => typeof v === 'string' && v.length > 0) || '';
};

const createApiError = async (response) => {
  const errorPayload = await response.json().catch(() => ({}));
  const message = errorPayload?.error?.message || 'Falha ao gerar imagem com a Imagen API.';
  const error = new Error(message);
  error.status = response.status;
  error.payload = errorPayload;
  return error;
};

// --- Funções de verificação e tratamento de erro ---

const isNetworkError = (error) => {
  if (!error) return false;
  if (error.name === 'TypeError' && /fetch/i.test(error.message || '')) return true;
  return /network/i.test(error.message || '');
};

const shouldRetryWithLegacyPredict = (error) => {
  if (!error) return false;
  if (isNetworkError(error)) return true;

  if (error.status === 404 || error.status === 405) return true;
  if (error.status >= 500) return true;

  const message = (error.payload?.error?.message || error.message || '').toLowerCase();
  return (
    message.includes('legacy') ||
    message.includes('predict') ||
    message.includes('deprecated')
  );
};

const formatNetworkError = (error, fallbackMessage) => {
  if (!isNetworkError(error)) return error;

  const enhanced = new Error(
    fallbackMessage ||
      'Não foi possível se conectar à Imagen API. Verifique sua conexão com a internet, a chave de API e tente novamente.'
  );

  enhanced.cause = error;
  return enhanced;
};

// --- Chamadas às APIs ---

const callLegacyPredict = async ({ prompt, negativePrompt, apiKey, signal }) => {
  const response = await fetch(`${LEGACY_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey
    },
    body: JSON.stringify({
      instances: [{ prompt, negativePrompt }],
      parameters: {
        sampleCount: IMAGEN_CONFIG.numberOfImages,
        aspectRatio: IMAGEN_CONFIG.aspectRatio,
        safetyFilterLevel: IMAGEN_CONFIG.safetyFilterLevel,
        personGeneration: IMAGEN_CONFIG.personGeneration
      }
    }),
    signal
  });

  if (!response.ok) throw await createApiError(response);
  return response.json();
};

const callGenerateImages = async ({ prompt, negativePrompt, apiKey, signal }) => {
  const payload = {
    model: IMAGEN_MODEL,
    prompt: { text: prompt },
    imageGenerationConfig: {
      numberOfImages: IMAGEN_CONFIG.numberOfImages,
      aspectRatio: IMAGEN_CONFIG.aspectRatio,
      outputMimeType: 'image/png',
      safetyFilterLevel: IMAGEN_CONFIG.safetyFilterLevel,
      personGeneration: IMAGEN_CONFIG.personGeneration
    }
  };

  if (negativePrompt) {
    payload.negativePrompt = { text: negativePrompt };
  }

  const response = await fetch(GENERATE_IMAGES_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) throw await createApiError(response);
  return response.json();
};

// --- Função principal de geração ---

export async function generateSlideImage({ prompt, negativePrompt, apiKey, signal }) {
  if (!apiKey) throw new Error('Configure a Google AI API Key antes de gerar imagens.');

  const resolvedNegativePrompt = negativePrompt || buildNegativePrompt();

  const attemptExtraction = async (request) => {
    const payload = await request;
    const base64Image = extractBase64Image(payload);
    if (!base64Image) throw new Error('A resposta da Imagen API não contém imagem válida.');
    return base64Image;
  };

  try {
    return await attemptExtraction(
      callGenerateImages({ prompt, negativePrompt: resolvedNegativePrompt, apiKey, signal })
    );
  } catch (generateImagesError) {
    if (!shouldRetryWithLegacyPredict(generateImagesError)) {
      throw formatNetworkError(generateImagesError);
    }

    try {
      return await attemptExtraction(
        callLegacyPredict({ prompt, negativePrompt: resolvedNegativePrompt, apiKey, signal })
      );
    } catch (legacyError) {
      const formatted = formatNetworkError(legacyError);
      if (formatted === legacyError && generateImagesError?.message) {
        formatted.message = `${formatted.message} (tentativa anterior: ${generateImagesError.message})`;
      }
      throw formatted;
    }
  }
}

// --- Geração de múltiplas imagens (ex.: carrossel) ---

export async function generateCarouselImages({ slides, brandKit, apiKey, onProgress, signal }) {
  const results = [];

  for (const slide of slides) {
    if (signal?.aborted) throw new Error('Geração de imagens cancelada.');

    const prompt = buildImagenPrompt(slide, brandKit);
    const image = await generateSlideImage({ prompt, apiKey, signal });

    results.push({
      slideNumber: slide.slideNumber,
      imageUrl: image,
      status: 'generated'
    });

    onProgress?.(results.length / slides.length);
  }

  return results;
}
