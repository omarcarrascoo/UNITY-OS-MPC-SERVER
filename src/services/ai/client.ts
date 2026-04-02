import OpenAI from 'openai';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_NETWORK_RETRIES = 3;

export function createDeepseekClient(): OpenAI {
  return new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: any): string {
  return String(error?.code || error?.cause?.code || '').trim().toUpperCase();
}

function isRetryableNetworkError(error: any): boolean {
  const code = getErrorCode(error);
  const message = String(error?.message || '').toLowerCase();
  const causeMessage = String(error?.cause?.message || '').toLowerCase();
  const status = Number(error?.status || error?.cause?.status || 0);

  if ([408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  if (message.includes('terminated') || message.includes('timeout') || message.includes('network')) {
    return true;
  }

  if (causeMessage.includes('reset') || causeMessage.includes('timeout') || causeMessage.includes('terminated')) {
    return true;
  }

  return false;
}

export async function createDeepseekChatCompletion(
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options?: Parameters<OpenAI['chat']['completions']['create']>[1],
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const client = createDeepseekClient();

  for (let attempt = 1; attempt <= DEFAULT_MAX_NETWORK_RETRIES; attempt += 1) {
    try {
      return await client.chat.completions.create(request, options);
    } catch (error: any) {
      const aborted = options?.signal?.aborted;
      const shouldRetry = !aborted && isRetryableNetworkError(error) && attempt < DEFAULT_MAX_NETWORK_RETRIES;

      if (!shouldRetry) {
        throw error;
      }

      const waitMs = 750 * attempt;
      console.warn(
        `Transient DeepSeek error on attempt ${attempt}/${DEFAULT_MAX_NETWORK_RETRIES}. Retrying in ${waitMs}ms...`,
        error?.message || String(error),
      );
      await sleep(waitMs);
    }
  }

  throw new Error('DeepSeek request retry loop exited unexpectedly.');
}
