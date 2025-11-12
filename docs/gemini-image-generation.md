# Estudo da API Google Gemini para Geração de Imagens

Este documento resume os modelos, endpoints, payloads, limitações e exemplos práticos para utilizar a API Gemini (v1beta) na geração de imagens, cobrindo tanto o modelo Gemini 2.5 Flash Image quanto a família Imagen 4/3.

## Modelos Disponíveis

### Gemini 2.5 Flash Image ("nano-banana")
- **IDs:** `gemini-2.5-flash-image` (stable) e `gemini-2.5-flash-image-preview` (preview).
- **Lançamento:** Outubro/2025, modelo multimodal de última geração.
- **Entradas/Saídas:** aceita texto e imagem; retorna imagem(s) e/ou texto.
- **Uso recomendado:** geração e edição multimodal (texto+imagem), composição com múltiplas imagens de entrada.

### Imagen 4
- **Variants:**
  - `imagen-4.0-generate-001` (Standard)
  - `imagen-4.0-ultra-generate-001` (Ultra – maior fidelidade, 1 imagem por chamada, suporta 2K)
  - `imagen-4.0-fast-generate-001` (Fast – latência menor)
- **Watermark:** todas as imagens possuem SynthID invisível.
- **Idioma:** prompts somente em inglês no momento.
- **Atualização:** Junho/2025.

### Imagen 3 (legado)
- **ID:** `imagen-3.0-generate-002` (qualidade inferior comparada ao Imagen 4).
- **Uso:** ainda suportado, útil para custos reduzidos.

## Endpoints e Métodos

| Modelo | Endpoint REST | Método | Notas |
| --- | --- | --- | --- |
| Gemini 2.5 Flash Image | `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent` | `generateContent` | Usar sempre `:generateContent`; `:predict` gera 404. |
| Imagen (3/4) | `POST https://generativelanguage.googleapis.com/v1beta/models/imagen-*. . . :predict` | `predict` | Requer payload no formato `instances`/`parameters`. |

> **Importante:** Recursos multimodais (entrada de imagem/saída de imagem) estão disponíveis apenas em `v1beta`. O endpoint `v1` estável atende principalmente texto.

## Estrutura de Payload

### Gemini (`generateContent`)

```json
{
  "contents": [
    {
      "parts": [
        { "text": "Descrição da imagem" },
        { "inline_data": { "mime_type": "image/png", "data": "<BASE64>" } },
        { "file_data": { "mime_type": "image/png", "file_uri": "generativelanguage.googleapis.com/v1beta/files/..." } }
      ]
    }
  ]
}
```

- **Obrigatórios:** campo `contents` com ao menos um `part` de texto.
- **Entradas de imagem:** via `inline_data` (Base64) ou `file_data` (URI obtida pelo Files API ou URL pública).
- **Saída:** partes contendo `inline_data.data` com a imagem em Base64.

### Imagen (`predict`)

```json
{
  "instances": [
    { "prompt": "Texto descrevendo a cena" }
  ],
  "parameters": {
    "sampleCount": 4,
    "imageSize": "1K",
    "aspectRatio": "1:1",
    "personGeneration": "allow_adult"
  }
}
```

- **Obrigatórios:** campo `instances` com ao menos um objeto contendo `prompt`.
- **Parâmetros opcionais:** `sampleCount` (até 4, exceto Ultra = 1), `imageSize` (`1K` ou `2K` para Standard/Ultra), `aspectRatio`, `personGeneration` (`dont_allow`, `allow_adult` padrão, `allow_all` fora de UE/UK/Suíça/MENA).
- **Saída:** imagens retornam em `predictions[].image[]` (Base64).

## Retorno de Imagens: Base64 vs. File URI

- **Default:** respostas trazem os bytes da imagem em Base64 inline.
- **Limite:** ~20 MB por requisição (soma de texto + dados Base64).
- **Files API:** para arquivos grandes ou reutilização, suba a imagem uma vez e use `fileUri` em prompts. As imagens geradas não são automaticamente salvas no Files API – faça upload manual se quiser armazená-las.

## Limitações, Quotas e Políticas

- **Rate limits (exemplos 2025):**
  - Free tier: ~10 RPM / 100 RPD para Gemini preview; Imagen Standard/Fast Tier 1 ~10 RPM; Ultra ~5 RPM. Tiers pagos aumentam limites (até ~20 RPM em Tier 3).
- **Custos aproximados:** Imagen 4 entre USD 0.02 e 0.12 por imagem; Gemini 2.5 Flash Image ~1290 tokens (~USD 0.03) por imagem 1024x1024.
- **Segurança:** filtros de conteúdo automático. Categorias (sexualidade, ódio, assédio, etc.) podem bloquear resultados (`finishReason: CONTENT_FILTERED`). Algumas políticas são obrigatórias (ex.: abuso infantil).
- **Geração de pessoas:** `allow_all` (permitindo crianças) indisponível em UE/UK/Suíça/MENA.
- **Disponibilidade regional:** modelos preview podem exigir faturamento em regiões sem free tier; erros 403/FAILED_PRECONDITION indicam necessidade de habilitar billing.
- **Resolução máx.:** Imagen 4 Standard/Fast 1K (opção 2K), Ultra 2K (1 imagem). Gemini 2.5 Flash Image suporta vários aspect ratios até ~1024x1024 / 1344x768.
- **Watermark:** todas as imagens têm SynthID invisível.

## Exemplos Práticos

### Texto → Imagem (Gemini 2.5)
```python
response = client.models.generate_content(
    model="gemini-2.5-flash-image",
    contents=["Crie uma imagem de um prato de nano-banana em um restaurante chique com tema de Gêmeos"],
)
for part in response.parts:
    if part.inline_data:
        image = part.as_image()
        image.save("saida.png")
```

### Edição Texto + Imagem (Gemini 2.5)
```bash
IMG_BASE64=$(base64 -w0 cat_image.png)
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent" \
  -H "x-goog-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "parts": [
        {"text": "Crie uma imagem do meu gato comendo uma nano-banana em um restaurante chique sob a constelação de Gêmeos."},
        {"inline_data": {"mime_type": "image/png", "data": "'$IMG_BASE64'"}}
      ]
    }]
  }'
```

### Texto → 4 imagens (Imagen 4 Standard)
```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict" \
  -H "x-goog-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "instances": [{"prompt": "Um robô segurando um skate vermelho"}],
    "parameters": {"sampleCount": 4}
  }'
```

### Texto → Imagem Ultra 2K (Imagen 4 Ultra)
```bash
curl -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-ultra-generate-001:predict" \
  -H "x-goog-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "instances": [{"prompt": "Retrato fotorealista de um tigre branco em uma selva nevoenta, iluminação dramática."}],
    "parameters": {"sampleCount": 1, "imageSize": "2K"}
  }'
```

## Erros Comuns e Correções

| Erro | Causa provável | Solução |
| --- | --- | --- |
| 404 NOT_FOUND | Uso de `:predict` em modelo Gemini ou ID de modelo obsoleto (`gemini-1.5-flash`). | Usar `:generateContent`; consultar `/models` para IDs atuais. |
| 405 METHOD_NOT_ALLOWED | Método HTTP incorreto (GET). | Usar POST. |
| 400 INVALID_ARGUMENT | JSON malformado, Base64 inválido, parâmetros não suportados, tamanho excessivo. | Validar campos, enviar Base64 puro, usar Files API para >20 MB, valores válidos para parâmetros. |
| 401/403 (UNAUTHENTICATED/PERMISSION_DENIED) | API key incorreta, billing faltando, recurso indisponível na região. | Conferir chave, habilitar faturamento, verificar disponibilidade. |
| Conteúdo filtrado | Prompt violou políticas (violência, nudez explícita, etc.). | Reformular prompt; filtros obrigatórios não podem ser desativados. |
| Resultados inconsistentes | Diferenças entre API e AI Studio ou modelo errado. | Garantir mesmo modelo/parâmetros; ajustar `response_modalities`. |

## Boas Práticas

1. **Verifique modelos disponíveis** periodicamente (`GET /v1beta/models`).
2. **Gerencie arquivos grandes** via Files API em vez de inline Base64.
3. **Trate erros e filtros** no código, exibindo mensagens amigáveis ao usuário final.
4. **Monitore custos e quotas**, especialmente em ambientes de produção.
5. **Respeite políticas de uso** (proibição de deepfakes, conteúdo nocivo, etc.).

---

> **Referências:** Documentação oficial do Google AI (Gemini API), guias de geração de imagens, troubleshooting e discussões em GitHub/Stack Overflow (consultadas até novembro de 2025).
