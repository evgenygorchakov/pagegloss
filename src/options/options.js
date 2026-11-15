import {
  BUILTIN_HOSTS,
  DEFAULTS,
  LIMITS,
  getSettings,
  normalizeLlamaUrl,
  resetSettings,
  setSettings,
} from "../lib/settings.js";
import { LANGUAGES } from "../lib/languages.js";
import { DEFAULT_BATCH_PROMPT } from "../lib/prompt.js";
import { ErrorCode, getVersion, listModels } from "../lib/llama.js";
import { modelOptions } from "../lib/model-options.js";
import { ensureHostPermission, parseServerUrl } from "../lib/host-permission.js";

const $ = (id) => document.getElementById(id);
const NUMBER_KEYS = ["batchMaxItems", "batchMaxChars", "concurrency", "temperature"];

let settings;
let models = [];

// ---------- Форма ----------

function setupStatic() {
  for (const key of NUMBER_KEYS) {
    const { min, max, step } = LIMITS[key];
    Object.assign($(key), { min, max, step });
  }
  $("targetLang").replaceChildren(
    ...LANGUAGES.map((l) => new Option(`${l.name} (${l.label})`, l.code)),
  );
  $("systemPrompt").placeholder = DEFAULT_BATCH_PROMPT;
  $("llama-origin").textContent = chrome.runtime.getURL("").replace(/\/$/, "");
}

function renderModels(selected) {
  $("model").replaceChildren(...modelOptions(models, selected));
  $("model").value = selected;
}

function fill(s) {
  $("llamaUrl").value = s.llamaUrl;
  renderModels(s.model);
  $("targetLang").value = s.targetLang;
  for (const key of NUMBER_KEYS) $(key).value = s[key];
  $("systemPrompt").value = s.systemPrompt;
}

function readForm() {
  const values = {
    llamaUrl: normalizeLlamaUrl($("llamaUrl").value),
    model: $("model").value,
    targetLang: $("targetLang").value,
    systemPrompt: $("systemPrompt").value.trim(),
  };
  for (const key of NUMBER_KEYS) {
    const raw = $(key).value.trim();
    values[key] = raw === "" ? DEFAULTS[key] : Number(raw);
  }
  return values;
}

function setSaveStatus(text) {
  $("save-status").textContent = text;
}

// ---------- llama.cpp ----------

function setLlamaStatus(kind, text) {
  const el = $("llama-status");
  el.dataset.kind = kind;
  el.textContent = text;
}

// → URL, если адрес годится и разрешение есть; иначе пишет ошибку в статус и → null.
// Вызывать прямо из обработчика клика (см. ensureHostPermission).
async function prepareUrl() {
  const url = parseServerUrl($("llamaUrl").value);
  if (!url) {
    setLlamaStatus("error", "The address must look like http://127.0.0.1:9931");
    return null;
  }
  let granted = false;
  try {
    granted = await ensureHostPermission(url, BUILTIN_HOSTS);
  } catch (err) {
    console.error(err);
  }
  if (!granted) {
    setLlamaStatus("error", `No permission to access ${url.origin}`);
    return null;
  }
  return url;
}

async function checkLlama(baseUrl) {
  setLlamaStatus("checking", "Checking llama.cpp…");
  $("check").disabled = true;
  try {
    let version;
    [version, models] = await Promise.all([getVersion(baseUrl), listModels(baseUrl)]);
    renderModels($("model").value);
    if (models.length) setLlamaStatus("ok", `llama.cpp ${version} · models: ${models.length}`);
    else setLlamaStatus("warn", `llama.cpp ${version} is running, but has no models`);
  } catch (err) {
    console.error(err);
    models = [];
    renderModels($("model").value);
    const hint =
      err.code === ErrorCode.FORBIDDEN_ORIGIN
        ? ` — allow ${chrome.runtime.getURL("").replace(/\/$/, "")} with --cors-origins and restart the server`
        : "";
    setLlamaStatus("error", err.message + hint);
  } finally {
    $("check").disabled = false;
  }
}

// ---------- События ----------

$("check").addEventListener("click", async () => {
  const url = await prepareUrl();
  if (url) await checkLlama(normalizeLlamaUrl(url.href));
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = await prepareUrl();
  if (!url) {
    setSaveStatus("Not saved: check the llama.cpp address");
    return;
  }
  // Пишем только поля, изменённые здесь: остальные могли сменить в popup, пока страница открыта.
  const patch = Object.fromEntries(
    Object.entries(readForm()).filter(([key, value]) => value !== settings[key]),
  );
  const urlChanged = "llamaUrl" in patch;
  await setSettings(patch);
  settings = await getSettings();
  fill(settings); // показываем значения после проверки диапазонов
  setSaveStatus("Saved");
  if (urlChanged) await checkLlama(settings.llamaUrl);
});

// Модель меняют и в popup. Если здесь её не трогали, показываем новую. Если выбрали другую,
// она остаётся в форме и запишется при сохранении.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.model || !settings) return;
  const model = changes.model.newValue ?? DEFAULTS.model;
  if ($("model").value === settings.model) renderModels(model);
  settings.model = model;
});

$("form").addEventListener("input", () => {
  setSaveStatus("Unsaved changes");
});

$("reset").addEventListener("click", async () => {
  await resetSettings();
  settings = await getSettings();
  fill(settings);
  setSaveStatus("Settings reset");
  await checkLlama(settings.llamaUrl);
});

// ---------- Старт ----------

setupStatic();
settings = await getSettings();
fill(settings);
await checkLlama(settings.llamaUrl);
