// Контекст выбирает llama.cpp. В session храним только его измерение и токены последнего
// завершённого запроса, отдельно для каждой пары сервер/модель. Popup читает их и после закрытия.
import { abortedError, getModelProperties } from "./llama.js";

export function contextKeys(baseUrl, model) {
  const key = `${baseUrl}|${model}`;
  return { capacity: `contextCapacity:${key}`, usage: `contextUsage:${key}` };
}

export async function loadModelContext(baseUrl, model, opts = {}) {
  // /props сообщает выделенное окно одного слота, а не обучающий максимум модели.
  const props = await getModelProperties(baseUrl, model, opts);
  const length = props.default_generation_settings?.n_ctx;
  const total = Number.isSafeInteger(length) && length > 0 ? length : null;
  if (opts.signal?.aborted) throw abortedError();
  const { capacity } = contextKeys(baseUrl, model);
  await chrome.storage.session.set({ [capacity]: total }).catch(() => {});
  return total;
}

export async function readContextState(baseUrl, model) {
  const keys = contextKeys(baseUrl, model);
  const stored = await chrome.storage.session.get(Object.values(keys));
  const total = stored[keys.capacity] ?? null;
  const usage = stored[keys.usage];
  return { total, usage: usage?.total === total ? usage : null };
}

export async function recordContextUsage(ctx, result) {
  const { promptEvalCount: input, evalCount: output } = result;
  const total = ctx.numCtx;
  const usage = Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
    ? { input, output, used: input + output, total }
    : null;
  const keys = contextKeys(ctx.baseUrl, ctx.model);
  // Телеметрия не должна превращать уже готовый ответ в ошибку.
  if (!ctx.signal?.aborted) {
    await chrome.storage.session.set({ [keys.capacity]: total, [keys.usage]: usage }).catch(() => {});
  }
  return { total, usage };
}

export async function clearContextState(baseUrl, model) {
  await chrome.storage.session.remove(Object.values(contextKeys(baseUrl, model)));
}
