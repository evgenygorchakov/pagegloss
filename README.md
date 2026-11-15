# PageGloss

Translate web pages, summarize articles and ask questions about what you read without
leaving your browser. PageGloss is a Chrome and Firefox extension for working with web
content using models you run on your own computer. It currently connects through
[llama.cpp / Llama app](https://llama.app), so you can work with text locally and choose your model.

- **Translate in place.** Read pages in any of 14 target languages, hover to see the original,
  or translate just the text you select. Russian is the default.
- **Ask questions.** Get a page summary, ask about its contents, or open a conversation
  beside a selected passage with the experimental Text workspace.
- **Search when needed.** Connect SearXNG to let the model find current information and
  include source links in its answers.
- **Listen in Russian.** Dub YouTube videos from their captions with a local Silero speech
  server.
- **Load from source.** The extension needs no build step or npm dependencies.

For example, translating a selection into Russian looks like this. The wording depends on
your model:

```text
Selected text:  "The meeting starts at noon."
Action:         Right-click → Translate selection
Language:       Russian (default)
Example result: "Встреча начинается в полдень."
```

[Get started](#get-started) · [Everyday use](#everyday-use) ·
[Optional features](#optional-features) · [Troubleshooting](#troubleshooting) ·
[Detailed guide](docs/usage.md) · [Development](#development)

---

## Get started

You need **Chrome 127+ or Firefox 140+**, [Llama app](https://llama.app/docs/installation),
and a downloaded model. On Windows 11, run both the app and the browser in Windows.

### 1. Download the extension

With [Git](https://git-scm.com/downloads) installed, run:

```sh
git clone https://github.com/evgenygorchakov/pagegloss.git
cd pagegloss
```

Alternatively, choose **Code → Download ZIP** on the
[repository page](https://github.com/evgenygorchakov/pagegloss) and extract it.
Keep this folder: the browser loads the extension directly from it.

### 2. Prepare Llama app

Install and start [Llama app](https://llama.app/docs/installation) in Windows 11. Open its
system tray menu, download a model, choose its context window and start **Chat with the
model**. See the [app quickstart](https://llama.app/docs/quickstart).

The default server address is `http://127.0.0.1:9931`. When the browser and app run in
Windows, this address points directly to the Windows server, even if you edit the extension
in WSL. No WSL IP address or port forwarding is needed.

If you prefer a terminal, Llama app also installs the `llama` command. Start a server with
a local model in PowerShell (replace the path with your GGUF file):

```powershell
llama serve -m "C:\Models\model.gguf" --port 9931 -c 8192
```

Keep that terminal open. On Linux, use the same command with your model's Linux path.
A server started without `-m` runs in router mode and can load cached models on demand.
PageGloss supports both modes through the [llama.cpp API](https://llama.app/docs/api).
The local server should run without `--api-key`; PageGloss does not send an API key.

### 3. Load the extension and translate a page

| Browser | Installation |
| --- | --- |
| Chrome | Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`. |
| Firefox | Open `about:debugging`, choose **This Firefox → Load Temporary Add-on**, and select `manifest.json`. Load it again after restarting Firefox. |

1. Open an ordinary web page, such as an article, and click the extension icon.
2. Wait for the llama.cpp status to show **OK**, then select your model. On first connection,
   the popup selects the first available model alphabetically; changing it saves immediately.
3. Open **Settings**. Choose your **Translation language** if you want something other than
   Russian, then press **Save**. Web search is off by default, so SearXNG is not needed
   for translation or conversations using the page text and the model's knowledge.
4. Return to the article, open the extension popup and click **Translate page**. Text is
   translated as you scroll. Click **Show original** to restore it.

The default llama.cpp address is `http://127.0.0.1:9931`. If your server is elsewhere, change
**llama.cpp address** in Settings, press **Check**, then **Save**, and grant access when asked.
The address must be reachable from the machine running the browser. A trailing `/v1` is
accepted and normalized automatically.

Upgrading from the Ollama version resets only the server address and selected model.
Your language, prompts, appearance, Silero and SearXNG settings stay saved. Reload the
extension and open its popup to select a model from Llama app.

---

## Everyday use

| You want to… | Do this |
| --- | --- |
| Translate a page | Click **Translate page**, or press **Alt+Shift+T** to toggle translation. Hover over translated text to see the original. |
| Translate a passage | Select text, right-click and choose **Translate selection**. |
| Get the main points | Click **Summary** in the popup. |
| Ask about an article | Click **Ask**, then use **Ask about the page…**. This mode uses only the source text. |
| Ask a broader question | Use **Ask freely…**. It can use the model's knowledge and, when configured, web search. |
| Start fresh | Use **Reset** in a panel, or **Reset context** in the popup to clear conversations across open panels. |
| Stop model work | Click **Stop** in the popup or press **Alt+Shift+S** to cancel model requests and unload the model in router mode. |

The two question fields keep separate histories and use your selected model and response
language. See the [detailed guide](docs/usage.md) for conversation controls, limits and
context usage. A standalone server keeps its model loaded after Stop; stop it in Llama app
or close its server process to free memory.

## Optional features

### Text workspace: work with a passage

Enable **Text workspace** in Settings and allow website access. Select text and hover over
**✦ Ask** to open a conversation beside it. Ask your own question, or click **Translate**,
**Explain** or **Summarize**. Answers stream into the panel; you can stop or copy them.

This experimental mode is off by default. Selecting text or hovering does not send a
request. Each selection has its own conversation, which is discarded when you close the
panel. [Controls, appearance and limits →](docs/usage.md#text-workspace)

### Web search: add current information

Connect a [SearXNG](https://docs.searxng.org/) server with its JSON API enabled, choose a
model with tool support, and set at least **8192 context tokens** in llama.cpp. In Settings,
enter the SearXNG address, enable automatic search, press **Save** and grant access.
The extension checks SearXNG before saving; if the check fails, the previous settings stay
in effect. **Check** lets you test the server without enabling search.

Search is off by default. Previously saved choices are preserved; turn it off in Settings
if you no longer run SearXNG.

Search is available in **Ask freely** and **Text workspace**. The model decides when to
search and includes numbered sources. Queries go to SearXNG and its search engines;
answers use your selected llama.cpp model. [SearXNG configuration →](docs/usage.md#web-search)

### YouTube dubbing: listen in Russian

Run a Silero server at `http://127.0.0.1:5011`; the
[Silero guide](tools/silero/README.md#windows) includes Windows installation and startup
commands. Open a YouTube video with captions and click **Translate** in the player.
Choose the voice in extension Settings; adjust original volume, speech speed-up and
Russian subtitles in the menu beside the player's Translate button.

**Dubbing is always in Russian**, regardless of your translation language.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| llama.cpp is unavailable | Start the model’s chat/server in Llama app, check the address in Settings, then press **⟳**. With both app and browser in Windows, use `http://127.0.0.1:9931`. |
| llama.cpp rejects extension requests (HTTP 403) | Settings shows this extension’s exact origin. Allow it with the server’s `--cors-origins` option and restart the server. See [server configuration](https://github.com/ggml-org/llama.cpp/tree/master/tools/server#readme). |
| No models, or the saved model is missing | Download and serve a model in Llama app, then select an available model in the popup. A saved llama.cpp choice is not silently replaced. |
| Ask freely or Text workspace reports a search error | Disable automatic search if you do not use SearXNG; otherwise check its JSON API, browser permission, tool support and context size. |
| A passage does not fit, or an answer is cut off | Select less text, reset the conversation, or increase context length in llama.cpp. [Context and limits →](docs/usage.md#context-length-and-usage) |
| Nothing opens on a browser settings page or PDF | Browser internal pages, extension stores and the built-in PDF viewer do not allow the injected panels. Try an ordinary web page. |
| YouTube dubbing cannot start | Check that the video has captions and Silero is running. Use **Check** next to the Silero address in Settings. |

## Development

Edit the JavaScript, HTML or CSS directly, reload the extension on the browser's extensions
page, then reload the web pages you are testing. No package installation or build is needed.

- [src/page](src/page) and [src/selection](src/selection): page and selection translation.
- [src/summary](src/summary): summaries and page conversations.
- [src/text-workspace](src/text-workspace): conversations about selected text.
- [src/dub](src/dub): YouTube dubbing.
- [src/lib](src/lib) and [src/shared](src/shared): shared logic and interface components.
- [tools/silero](tools/silero): the speech server.
