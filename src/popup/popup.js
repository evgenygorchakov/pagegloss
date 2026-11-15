import { getSettings, setSettings } from "../lib/settings.js";
import { ErrorCode, getVersion, listModels } from "../lib/llama.js";
import { modelOptions } from "../lib/model-options.js";
import { getPageState } from "../lib/tabs.js";
import { isStopped, markModelUsed } from "../lib/stop.js";
import { contextKeys, loadModelContext, readContextState } from "../lib/model-context.js";
import "../shared/context-usage.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("status-text"),
  hint: $("hint"),
  hintText: $("hint-text"),
  hintCode: $("hint-code"),
  model: $("model"),
  refresh: $("refresh"),
  options: $("options"),
  stop: $("stop"),
  resetContext: $("reset-context"),
  translate: $("translate"),
  original: $("original"),
  progress: $("progress"),
  note: $("note"),
};

const POLL_MS = 500;
const IDLE = { busy: 0, queued: 0 };

let settings;
let version = "";
let models = [];
let tabId = null;
let pageState = null; // ответ content script'а; null — ещё не внедрён или страница недоступна
let activity = IDLE; // работа модели на всех вкладках и над выделенным, из background
let acting = false; // идёт переключение, «Продолжить» или «Стоп»: кнопки не нажимаются
let warming = null;

async function renderContext() {
  const { llamaUrl, model } = settings;
  $("context").hidden = true;
  if (!model) return;
  const state = await readContextState(llamaUrl, model);
  if (settings.llamaUrl !== llamaUrl || settings.model !== model) return;
  const { text, title, ratio } = globalThis.__ollamaTranslator.contextUsage(state);
  $("context").hidden = !text;
  $("context-text").textContent = text;
  $("context").title = title;
  $("context-meter").hidden = ratio === null;
  $("context-meter").value = ratio ?? 0;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !settings) return;
  if (changes.modelStopped?.newValue) warming?.abort();
  const keys = Object.values(contextKeys(settings.llamaUrl, settings.model));
  if (keys.some((key) => key in changes)) renderContext().catch(console.warn);
});

const HINTS = {
  [ErrorCode.LLAMA_DOWN]: {
    text: "Start Llama app in Windows, download a model and start its chat/server, then press ⟳. The default address is http://127.0.0.1:9931.",
  },
  [ErrorCode.FORBIDDEN_ORIGIN]: {
    text: "llama.cpp rejects this extension's origin. Allow it in the server's CORS configuration and restart the server:",
    code: `--cors-origins ${chrome.runtime.getURL("").replace(/\/$/, "")}`,
  },
  [ErrorCode.BAD_RESPONSE]: {
    text: "Unexpected response from llama.cpp. See the popup console for details.",
  },
};

function setStatus(kind, text, hint) {
  els.status.dataset.kind = kind;
  els.statusText.textContent = text;
  els.hint.hidden = !hint;
  els.hintText.textContent = hint?.text ?? "";
  els.hintCode.textContent = hint?.code ?? "";
  els.hintCode.hidden = !hint?.code;
  updateButtons();
}

// Перевод выключен — «Перевести страницу»; включён — «Показать оригинал»; на паузе ещё и
// «▶ Продолжить». «■ Стоп» — пока модель работает, на этой вкладке или на любой другой.
function updateButtons() {
  const active = Boolean(pageState?.active);
  const paused = active && Boolean(pageState.paused);
  els.translate.hidden = active && !paused;
  els.translate.textContent = paused ? "▶ Resume" : "Translate page";
  // вернуть оригинал можно всегда, переводить — только когда llama.cpp и модель в порядке
  els.translate.disabled = acting || els.status.dataset.kind !== "ok";
  els.original.hidden = !active;
  els.original.disabled = acting;
  els.stop.hidden = !activity.busy && !activity.queued;
  els.stop.disabled = acting;
  els.resetContext.disabled = acting;
}

function renderProgress() {
  const s = pageState;
  els.progress.hidden = !s?.active;
  if (!s?.active) return;
  // на паузе ожидавшие перевода фрагменты снова ждут прокрутки — считаем от всех на странице
  const parts = s.paused
    ? [`Stopped · translated ${s.done} of ${s.total}`]
    : [`Translated ${s.done} of ${s.requested}`];
  if (s.errors) parts.push(`errors: ${s.errors}`);
  if (!s.paused) parts.push(`on the page: ${s.total}`);
  els.progress.textContent = parts.join(" · ");
}

async function getActivity() {
  try {
    return (await chrome.runtime.sendMessage({ type: "getActivity" })) ?? IDLE;
  } catch {
    return IDLE; // service worker не ответил: расширение перезагружается
  }
}

async function refresh() {
  [pageState, activity] = await Promise.all([getPageState(tabId), getActivity()]);
  renderProgress();
  updateButtons();
}

// Прогресс перевода (остальное подтянется при прокрутке страницы) и работа модели — пока
// popup открыт.
async function poll() {
  await refresh();
  setTimeout(poll, POLL_MS);
}

function showNote(text) {
  els.note.hidden = !text;
  els.note.textContent = text ?? "";
}

function renderModels() {
  els.model.replaceChildren(...modelOptions(models, settings.model));
  els.model.value = settings.model;
  els.model.disabled = models.length === 0;
  renderContext().catch(console.warn);
}

function updateModelStatus() {
  if (models.length === 0) {
    setStatus("warn", `llama.cpp ${version} is running, but has no models`, {
      text: "Download a model in Llama app, start its chat/server, then press ⟳.",
    });
  } else if (!settings.model) {
    setStatus("warn", `llama.cpp ${version} · choose a model`);
  } else if (!models.some((m) => m.name === settings.model)) {
    setStatus("error", `Model ${settings.model} not found`, {
      text: "Choose an available model, or make this model available in Llama app and press ⟳.",
    });
  } else {
    setStatus("ok", `llama.cpp ${version} · OK`);
    warmUpUnlessStopped();
  }
}

// Грузим модель в память заранее, пока пользователь тянется к кнопке. После «Стоп» — нет:
// модель выгрузили намеренно, открытый popup не должен загружать её обратно.
async function warmUpUnlessStopped() {
  warming?.abort();
  const controller = new AbortController();
  warming = controller;
  const { llamaUrl, model } = settings;
  if (await isStopped() || controller.signal.aborted) return;
  markModelUsed(llamaUrl, model); // «Стоп» выгрузит её, даже если модель сменят
  try {
    await loadModelContext(llamaUrl, model, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) return;
    console.warn("warm-up:", err);
    if (settings.llamaUrl === llamaUrl && settings.model === model) {
      $("context").hidden = true;
      $("context-text").textContent = "";
      $("context").title = "";
      $("context-meter").hidden = true;
    }
  } finally {
    if (warming === controller) warming = null;
  }
}

async function check() {
  const baseUrl = settings.llamaUrl;
  els.refresh.disabled = true;
  els.model.disabled = true;
  setStatus("checking", "Checking llama.cpp…");
  try {
    [version, models] = await Promise.all([
      getVersion(baseUrl),
      listModels(baseUrl),
    ]);
    // Пока шли запросы, модель или сервер могли поменять на странице настроек.
    settings = await getSettings();
    if (settings.llamaUrl !== baseUrl) {
      await check();
      return;
    }
    // Первый запуск: сохраняем первую модель из отсортированного списка.
    // Сохранённую модель не заменяем, даже если её больше нет на сервере.
    if (!settings.model && models.length) {
      const model = models[0].name;
      await setSettings({ model });
      settings.model = model;
    }
    renderModels();
    updateModelStatus();
  } catch (err) {
    console.error(err);
    models = [];
    els.model.replaceChildren();
    setStatus("error", err.message, HINTS[err.code]);
    $("context").hidden = true;
    $("context-text").textContent = "";
    $("context").title = "";
    $("context-meter").hidden = true;
  } finally {
    els.refresh.disabled = false;
  }
}

els.model.addEventListener("change", async () => {
  settings.model = els.model.value;
  await setSettings({ model: settings.model });
  renderModels();
  updateModelStatus();
});

els.refresh.addEventListener("click", check);

// Пока действие идёт, кнопки выключены: иначе опрос включил бы их раньше времени, и второй
// клик переключил бы перевод обратно. failure — начало сообщения, если не получилось.
async function act(fn, failure) {
  acting = true;
  updateButtons();
  showNote("");
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showNote(`${failure}: ${err.message}`);
  } finally {
    acting = false;
    await refresh();
  }
}

// ответ background вида { error }: ошибка — исключением
async function askBackground(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res?.error) throw new Error(res.error);
  return res;
}

// Внедрение и переключение делает background — так же, как для хоткея и контекстного меню.
const togglePage = () =>
  act(() => askBackground({ type: "toggleTab", tabId }), "Couldn't translate this page");

// На паузе content script уже внедрён — просим его продолжить напрямую.
const resumePage = () =>
  act(() => chrome.tabs.sendMessage(tabId, { type: "resume" }), "Couldn't resume translation");

// Отмена доступна всегда, выгрузка — только на сервере в router mode.
const stopAll = () => act(async () => {
  const result = await askBackground({ type: "stopAll" });
  showNote(result.retainedModels?.length
    ? "Requests stopped. This server keeps its model loaded; stop it in Llama app to free memory."
    : "Requests stopped. Models unloaded.");
}, "Requests stopped, but model unloading failed");

const resetContext = () => act(async () => {
  await askBackground({ type: "resetContext" });
  await renderContext();
  showNote("Context reset. Conversations cleared in all tabs.");
}, "Couldn't reset context");

els.translate.addEventListener("click", () => (pageState?.paused ? resumePage() : togglePage()));
els.original.addEventListener("click", togglePage);
els.stop.addEventListener("click", stopAll);
els.resetContext.addEventListener("click", resetContext);
els.options.addEventListener("click", () => chrome.runtime.openOptionsPage());

settings = await getSettings();
[{ id: tabId }] = await chrome.tabs.query({ active: true, currentWindow: true });
poll();
await check();
