// Настройки расширения: дефолты + чтение/запись через chrome.storage.local.
// Модуль со своими настройками держит их в том же storage под своими ключами (с префиксом
// модуля) и проверяет через clampNumbers и normalizeUrl отсюда. resetSettings стирает и их.

import { isKnownLanguage } from "./languages.js";

export const DEFAULTS = Object.freeze({
  llamaUrl: "http://127.0.0.1:9931", // Llama app в Windows; не localhost, который может быть ::1
  llamaApiKey: "",
  model: "",
  targetLang: "ru", // код из languages.js
  batchMaxItems: 12,
  batchMaxChars: 2500,
  concurrency: 1, // модель не влезает в VRAM целиком — параллельность только мешает
  temperature: 0.1,
  systemPrompt: "", // пусто — встроенный промпт из prompt.js
});

// Диапазоны числовых настроек: для полей на странице настроек и от мусора в storage.
export const LIMITS = Object.freeze({
  batchMaxItems: { min: 1, max: 50, step: 1 },
  batchMaxChars: { min: 200, max: 8000, step: 100 },
  concurrency: { min: 1, max: 4, step: 1 },
  temperature: { min: 0, max: 1, step: 0.05 },
});

// Адреса llama.cpp, доступные расширению без дополнительного запроса прав.
export const BUILTIN_HOSTS = Object.freeze(["localhost:9931", "127.0.0.1:9931"]);

export function normalizeUrl(url) {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function normalizeLlamaUrl(url) {
  return normalizeUrl(url).replace(/\/v1$/i, "");
}

function clamp(value, { min, max, step }, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return Number.isInteger(step) ? Math.round(clamped) : clamped;
}

// Числовые поля values — в диапазоны limits, не число — значение из defaults. Отсутствующих в
// values ключей не добавляет.
export function clampNumbers(values, defaults, limits) {
  const next = { ...values };
  for (const key of Object.keys(limits)) {
    if (key in next) next[key] = clamp(next[key], limits[key], defaults[key]);
  }
  return next;
}

function sanitize(values) {
  const next = clampNumbers(values, DEFAULTS, LIMITS);
  if ("llamaUrl" in next) next.llamaUrl = normalizeLlamaUrl(next.llamaUrl) || DEFAULTS.llamaUrl;
  if ("llamaApiKey" in next) next.llamaApiKey = typeof next.llamaApiKey === "string" ? next.llamaApiKey.trim() : "";
  if ("targetLang" in next && !isKnownLanguage(next.targetLang)) next.targetLang = DEFAULTS.targetLang;
  return next;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  if (!("llamaUrl" in stored)) {
    // Имена моделей и адрес Ollama несовместимы с Llama app. Меняем только подключение,
    // сохраняя язык, промпты, интерфейс, SearXNG и Silero. Новый ключ — маркер миграции.
    const connection = { llamaUrl: DEFAULTS.llamaUrl, model: "" };
    await chrome.storage.local.set(connection);
    Object.assign(stored, connection);
  }
  return sanitize({ ...DEFAULTS, ...stored });
}

export async function setSettings(patch) {
  await chrome.storage.local.set(sanitize(patch));
}

export async function resetSettings() {
  await chrome.storage.local.clear();
}
