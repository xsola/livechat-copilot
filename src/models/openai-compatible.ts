import { z } from 'zod';
import { parseEndpoint, type ModelConfig } from '../platform/config';
import { readJson } from '../platform/json';

const units = z.number().int().min(0).max(10_000_000);
const completion = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullish(),
    message: z.object({ content: z.string().nullish() }),
  })).min(1),
  usage: z.object({ prompt_tokens: units.optional(), completion_tokens: units.optional() }).nullish(),
});

interface RequestOptions {
  system: string;
  data: object;
  image?: string;
  maxTokens: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export class ModelError extends Error {
  constructor(message: string, readonly retryEmpty = false, readonly usage?: ModelUsage) {
    super(message);
  }
}

export class ImageInputUnsupportedError extends ModelError {
  constructor() {
    super('当前模型接口不支持图片输入，已禁用自动图像复核。');
  }
}

export async function complete(config: ModelConfig, options: RequestOptions, request = fetch) {
  const url = parseEndpoint(config.endpoint);
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  const text = JSON.stringify(options.data);
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: options.system },
      {
        role: 'user',
        content: options.image ? [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: options.image } },
        ] : text,
      },
    ],
    max_tokens: options.maxTokens,
    ...(config.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(url.origin === 'https://api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
  };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (config.apiKey) headers.set('Authorization', 'Bearer ' + config.apiKey);
  let response: Response;
  try {
    response = await request(url.href, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(7_500),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  } catch {
    throw new ModelError('Model endpoint could not be reached within the request deadline.');
  }
  if (!response.ok) {
    if (options.image && [400, 415, 422].includes(response.status)) {
      const detail = z.object({ error: z.object({
        code: z.string().nullish(),
        message: z.string().nullish(),
      }) }).safeParse(await readJson(response, 16_000).catch(() => undefined));
      if (detail.success) {
        const { code, message } = detail.data.error;
        const unsupportedCode = /^(?:image_input_unsupported|unsupported_image_input|vision_not_supported|text_only_model)$/i;
        const unsupportedMessage = /(?:does not support|cannot accept) (?:image|vision)|(?:image input|vision).{0,35}(?:unsupported by|not supported by) .{0,20}model|only (?:supports? )?text|text.only model|不支持.{0,20}(?:图片|图像)输入/i;
        if ((code && unsupportedCode.test(code)) || (message && unsupportedMessage.test(message))) {
          throw new ImageInputUnsupportedError();
        }
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
    throw new ModelError('Model endpoint returned HTTP ' + response.status + '.');
  }
  const result = completion.safeParse(await readJson(response, 512_000).catch(() => undefined));
  if (!result.success) throw new ModelError('Model returned an invalid API response.');
  const usage = {
    inputTokens: result.data.usage?.prompt_tokens ?? 0,
    outputTokens: result.data.usage?.completion_tokens ?? 0,
  };
  const answer = result.data.choices[0]?.message.content?.trim();
  if (!answer) throw new ModelError('Model returned an empty answer.', true, usage);
  try {
    const json: unknown = JSON.parse(answer.replace(/^\x60{3}(?:json)?\s*/i, '').replace(/\s*\x60{3}$/, ''));
    return { json, usage };
  } catch {
    throw new ModelError('Model response is not valid JSON.', false, usage);
  }
}
