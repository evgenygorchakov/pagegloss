// «Стоп»: обрывает работу модели и выгружает её, если сервер работает в router mode.
// Модули подписываются через onStop и друг от друга не зависят. Работает в service worker.

import { getSettings } from "./settings.js";
import { ErrorCode, unloadModel } from "./llama.js";
import { busyCount } from "./slots.js";
import { clearContextState } from "./model-context.js";

// Модели, которые загружало расширение: "usedLlamaModel:<url>|<model>" → { url, model, apiKey }. Ключ на
// модель, а не общий список: параллельные операции друг друга не затрут.
const USED_PREFIX = "usedLlamaModel:";

const listeners = new Set();
const queues = new Set();
// модели, уже записанные в storage из этого контекста
const recorded = new Map();

// fn() обрывает запросы модуля синхронно; может вернуть промис, если ему нужно доделать
// что-то ещё (например, разослать вкладкам паузу).
export function onStop(fn) {
  listeners.add(fn);
}

// Модуль сообщает, сколько его текстов ждёт модели: fn() → число.
export function registerQueue(fn) {
  queues.add(fn);
}

// Для popup: работает ли модель. busy — занятые слоты (запросы к модели идут), queued — тексты,
// которые ждут в очередях модулей.
export function activity() {
  let queued = 0;
  for (const fn of queues) queued += fn();
  return { busy: busyCount(), queued };
}

// Бросает, если какую-то модель выгрузить не удалось. Запросы к этому моменту уже оборваны.
export async function stopAll() {
  const tasks = [...listeners].map((fn) => fn());
  try {
    return { retainedModels: await unloadUsed() };
  } finally {
    await Promise.allSettled(tasks);
  }
}

// Выгружает все модели, которые загружало расширение: модель в настройках могли сменить, пока
// работала прежняя. Текущую — тоже: её могли загрузить до перезапуска браузера, а storage.session
// он очищает.
async function unloadUsed() {
  const [{ llamaUrl, llamaApiKey, model }, stored] = await Promise.all([
    getSettings(),
    chrome.storage.session.get(null),
  ]);
  const used = new Map(); // ключ → { url, model, apiKey }
  if (model) used.set(usedKey(llamaUrl, model), { url: llamaUrl, model });
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(USED_PREFIX)) used.set(key, value);
  }
  // Забываем до выгрузки: модель, которую снова запустят, пока идёт выгрузка, запишется заново.
  recorded.clear();
  const forgotten = chrome.storage.session.remove([...used.keys()]).catch(() => {});
  const list = [...used];
  const results = await Promise.allSettled(list.map(([, m]) => unloadModel(m.url, m.model, {
    // Для текущего сервера берём актуальный ключ: пользователь мог исправить его в настройках.
    apiKey: m.url === llamaUrl ? llamaApiKey : m.apiKey,
  })));
  await Promise.allSettled(list.map(([, m], i) => {
    const result = results[i];
    if (result.status === "fulfilled" || result.reason?.code === ErrorCode.MODEL_NOT_FOUND) {
      return clearContextState(m.url, m.model);
    }
  }));
  await forgotten;
  // невыгруженные вернём — их выгрузит следующий «Стоп»; удалённую из llama.cpp выгружать незачем
  const failed = list.filter((_, i) => {
    const r = results[i];
    return r.status === "rejected" && r.reason?.code !== ErrorCode.MODEL_NOT_FOUND;
  });
  if (!failed.length) {
    return list.filter((_, i) => results[i].status === "fulfilled" && results[i].value === false)
      .map(([, m]) => m.model);
  }
  await chrome.storage.session.set(Object.fromEntries(failed)).catch(() => {});
  throw results[list.indexOf(failed[0])].reason;
}

function usedKey(url, model) {
  return `${USED_PREFIX}${url}|${model}`;
}

// Вызывать перед запросом к модели: запоминает модель, чтобы «Стоп» выгрузил её, даже если
// в настройках к тому времени выберут другую. Ключ остаётся в session для выгрузки прежнего сервера.
export function markModelUsed(url, model, apiKey = "") {
  const key = usedKey(url, model);
  if (model && recorded.get(key) !== apiKey) {
    recorded.set(key, apiKey);
    chrome.storage.session.set({ [key]: { url, model, apiKey } }).catch(() => recorded.delete(key));
  }
}
