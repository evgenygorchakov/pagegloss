// llama.cpp / Llama app HTTP API. Только fetch, без chrome.*.

export const ErrorCode = Object.freeze({
  LLAMA_DOWN: "LLAMA_DOWN",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  BAD_RESPONSE: "BAD_RESPONSE",
  ABORTED: "ABORTED",
  TEXT_TOO_LONG: "TEXT_TOO_LONG",
});

export class LlamaError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "LlamaError";
    this.code = code;
    this.status = status;
  }
}

export function abortedError() {
  return new LlamaError(ErrorCode.ABORTED, "Request cancelled");
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toNetworkError(err, baseUrl) {
  if (err?.name === "TimeoutError") {
    return new LlamaError(ErrorCode.LLAMA_DOWN, `llama.cpp didn't respond in time (${baseUrl})`);
  }
  if (err?.name === "AbortError") return abortedError();
  return new LlamaError(ErrorCode.LLAMA_DOWN, `Can't connect to llama.cpp (${baseUrl})`);
}

function errorMessage(error) {
  return typeof error === "string" ? error : error?.message || "Unknown server error";
}

async function toHttpError(res) {
  const text = await res.text().catch(() => "");
  let message = text.trim();
  try {
    const data = JSON.parse(text);
    message = data.error ? errorMessage(data.error) : data.message || message;
  } catch {
    // Тело не JSON — оставляем как есть.
  }
  const status = res.status;
  if (status === 403) {
    return new LlamaError(ErrorCode.FORBIDDEN_ORIGIN,
      `llama.cpp rejected the extension's request (403): ${message || "check --cors-origins"}`,
      { status });
  }
  if (status === 401) {
    return new LlamaError(ErrorCode.BAD_RESPONSE,
      "llama.cpp requires an API key. Use a local server started without --api-key.", { status });
  }
  // Router может вернуть 400 вместо 404 для неизвестной модели.
  if ((status === 400 || status === 404) && /model.*not found|unknown model/i.test(message)) {
    return new LlamaError(ErrorCode.MODEL_NOT_FOUND, message, { status });
  }
  return new LlamaError(ErrorCode.BAD_RESPONSE, `HTTP ${status}: ${message || res.statusText}`, { status });
}

async function request(baseUrl, path, { method = "GET", body, signal } = {}) {
  let res;
  try {
    // Принимаем и адрес сервера, и привычный OpenAI base URL с /v1.
    const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    res = await fetch(root + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw toNetworkError(signal?.aborted ? signal.reason : err, baseUrl);
  }
  if (!res.ok) throw await toHttpError(res);
  return res;
}

async function requestJson(baseUrl, path, { timeoutMs = 5000, signal, ...opts } = {}) {
  const timedSignal = withTimeout(signal, timeoutMs);
  try {
    const res = await request(baseUrl, path, { ...opts, signal: timedSignal });
    return await res.json();
  } catch (err) {
    if (timedSignal?.aborted) throw toNetworkError(timedSignal.reason, baseUrl);
    if (err instanceof LlamaError) throw err;
    if (err instanceof SyntaxError) {
      throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp returned something other than JSON");
    }
    throw toNetworkError(err, baseUrl);
  }
}

export async function getVersion(baseUrl, opts = {}) {
  const data = await requestJson(baseUrl, "/props", opts);
  return typeof data.build_info === "string" ? data.build_info : "";
}

export async function listModels(baseUrl, opts = {}) {
  const data = await requestJson(baseUrl, "/v1/models", opts);
  if (!Array.isArray(data.data) || data.data.some((m) => typeof m?.id !== "string" || !m.id)) {
    throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp returned an invalid model list");
  }
  return data.data.map((m) => ({
    name: m.id,
    size: m.meta?.size,
    parameterSize: m.meta?.n_params ? `${(m.meta.n_params / 1e9).toFixed(1)}B` : "",
    quantization: "",
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// В router mode /props?model=... загружает выбранную модель и ждёт её готовности.
// У standalone server это свойства единственной модели. Никакой генерации для прогрева.
export async function getModelProperties(baseUrl, model, { signal } = {}) {
  return watched(baseUrl, signal, (combined) => requestJson(baseUrl,
    `/props?model=${encodeURIComponent(model)}&autoload=true`, { signal: combined, timeoutMs: 0 }));
}

// Выгрузка поддерживается router mode. Standalone server нужно остановить в приложении:
// false сообщает вызывающему, что запросы отменены, но память всё ещё занята моделью.
export async function unloadModel(baseUrl, model, opts = {}) {
  const props = await requestJson(baseUrl, "/props", opts);
  if (props.role !== "router") return false;
  const result = await requestJson(baseUrl, "/models/unload", {
    timeoutMs: 10000,
    ...opts,
    method: "POST",
    body: { model },
  });
  if (result.success !== true) {
    throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp did not confirm model unloading");
  }
  return true;
}

const MODEL_PROBE_MS = 30_000;
const MODEL_PROBE_TIMEOUT_MS = 10_000;
const CHAT_IDLE_MS = 180_000;

// До генерации очередь и загрузка могут занять минуты. /health с 503 означает, что
// сервер жив и грузит модель. После первого куска следим за простоем потока.
function watchStall(baseUrl, onStall) {
  const probing = new AbortController();
  let timer = null;
  const probe = async () => {
    try {
      await requestJson(baseUrl, "/health", {
        signal: probing.signal, timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      });
    } catch (err) {
      if (err.code === ErrorCode.LLAMA_DOWN && !probing.signal.aborted) {
        onStall(`llama.cpp isn't responding (${baseUrl})`);
        return;
      }
    }
    if (!probing.signal.aborted) timer = setTimeout(probe, MODEL_PROBE_MS);
  };
  timer = setTimeout(probe, MODEL_PROBE_MS);
  const stop = () => {
    probing.abort();
    clearTimeout(timer);
  };
  return {
    stop,
    chunk() {
      stop();
      timer = setTimeout(
        () => onStall(`llama.cpp has been silent for over ${CHAT_IDLE_MS / 1000} s (${baseUrl})`),
        CHAT_IDLE_MS,
      );
    },
  };
}

async function watched(baseUrl, signal, fn) {
  const stall = new AbortController();
  let stallError = null;
  const watch = watchStall(baseUrl, (message) => {
    stallError = new LlamaError(ErrorCode.LLAMA_DOWN, message);
    stall.abort();
  });
  const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  try {
    return await fn(combined, watch);
  } catch (err) {
    if (signal?.aborted) throw abortedError();
    if (stallError) throw stallError;
    if (err instanceof LlamaError) throw err;
    throw toNetworkError(err, baseUrl);
  } finally {
    watch.stop();
  }
}

const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// OpenAI SSE: data: {...}\n\n, финальное data: [DONE]. JSON и UTF-8 могут быть разбиты
// между любыми сетевыми кусками. onContent/onThinking получают весь накопленный текст.
export async function chat(baseUrl, body, opts = {}) {
  return watched(baseUrl, opts.signal, async (signal, watch) => {
    let reader;
    let buffer = "";
    let eventData = [];
    let content = "";
    let thinking = "";
    const calls = new Map();
    let doneReason = "";
    let ended = false;
    let usage = null;
    let timings = null;

    const handleEvent = () => {
      if (!eventData.length || ended) return;
      const data = eventData.join("\n").trim();
      eventData = [];
      if (data === "[DONE]") {
        ended = true;
        return;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new LlamaError(ErrorCode.BAD_RESPONSE, "Couldn't parse an event of the llama.cpp stream");
      }
      if (chunk.error) throw new LlamaError(ErrorCode.BAD_RESPONSE, errorMessage(chunk.error));
      if (chunk.usage) usage = chunk.usage;
      if (chunk.timings) timings = chunk.timings;
      const choice = chunk.choices?.find((c) => c.index === 0) ?? chunk.choices?.[0];
      if (!choice) return; // Отдельный завершающий пакет с usage имеет choices: [].
      const delta = choice.delta ?? {};
      const thought = delta.reasoning_content ?? delta.reasoning ?? "";
      if (thought) {
        thinking += thought;
        opts.onThinking?.(thinking);
      }
      if (delta.content) {
        content += delta.content;
        opts.onContent?.(content);
      }
      for (const part of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0) {
          throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp returned a tool call without an index");
        }
        const call = calls.get(part.index) ?? {
          id: "", type: "function", function: { name: "", arguments: "" },
        };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
      if (choice.finish_reason) doneReason = choice.finish_reason;
    };

    const handleLine = (raw) => {
      const line = raw.replace(/\r$/, "");
      if (!line) handleEvent();
      else if (line.startsWith("data:")) eventData.push(line.slice(5).replace(/^ /, ""));
      // Комментарии-пинги и поля event/id/retry не являются JSON.
    };

    try {
      const res = await request(baseUrl, "/v1/chat/completions", {
        signal, method: "POST",
        body: { ...body, stream: true, stream_options: { include_usage: true } },
      });
      if (!res.body) throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp returned an empty stream");
      reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      while (!ended) {
        const { value, done } = await reader.read();
        if (done) break;
        watch.chunk();
        buffer += value;
        let nl;
        while (!ended && (nl = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      if (!ended) {
        handleLine(buffer);
        handleEvent();
      }
    } finally {
      // Отмена чтения закрывает HTTP-запрос, освобождая серверный слот.
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    if (!ended || !doneReason) {
      throw new LlamaError(ErrorCode.BAD_RESPONSE, "The llama.cpp stream ended before the response was complete");
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some((call) => !call.id || !call.function.name)) {
      throw new LlamaError(ErrorCode.BAD_RESPONSE, "llama.cpp returned an incomplete tool call");
    }
    return {
      content,
      thinking,
      toolCalls,
      message: {
        role: "assistant",
        content,
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      promptEvalCount: tokenCount(usage?.prompt_tokens),
      evalCount: tokenCount(usage?.completion_tokens),
      evalDuration: Number.isFinite(timings?.predicted_ms) ? timings.predicted_ms * 1e6 : 0,
      doneReason,
    };
  });
}
