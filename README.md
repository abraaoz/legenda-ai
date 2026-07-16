<img src="assets/icon-1024.png" width="110" align="right" alt="">

# Legenda AI pra mim

**English** · [Português](README.pt-BR.md)

A desktop app (Mac, Windows, and Linux) to **download, translate, and watch**
subtitles for your videos — straight on your TV, if you like. Simple, offline
when it can be, and it never sends your files anywhere.

## What it does

- 🔎 **Downloads the right subtitle** — finds it on OpenSubtitles by your video's
  "fingerprint", so it comes **perfectly in sync** (no early/late subtitles).
- 🌎 **Translates subtitles** into your language while **keeping the timing**.
  Works with subtitles embedded in the video (MKV) or with a `.srt` file you
  already have. Three translation options:
  - **Apple** — right on your Mac, offline and free (macOS 15+);
  - **Ollama** — offline on your computer (free, needs installing);
  - **Azure** — in the cloud (needs a Microsoft account).
- 👁️ **Reads "image" subtitles** from Blu-rays (the ones that aren't text) and
  turns them into text so they can be translated.
- 📺 **Plays on your TV** — sends the video **with the subtitle** to your TV,
  whether **Chromecast/Google TV** or a **Samsung Smart TV** (and other DLNA
  TVs), with play/pause and a working time bar (skip forward/back). It converts
  the video when the TV can't handle the format.
- 🌐 **Multi-language app** — the interface is available in English, Portuguese,
  Spanish, French, Italian, German, and Japanese (**⚙️ Settings → Languages**).

## Download and install

Grab the latest version from the **[Releases](https://github.com/abraaoz/legenda-ai/releases/latest)** page:

- **Mac (Apple Silicon)** → download the `.dmg`, open it, and drag to Applications.
- **Windows** → download the `.zip`, extract, and run.
- **Linux** → download the `.tar.gz`.

> ⚠️ The app is **not signed yet**, so the first time your system may warn that
> it's from an "unidentified developer".
>
> **On Mac**, after dragging it to Applications, run this once in Terminal to
> allow it to open:
>
> ```sh
> sudo xattr -d com.apple.quarantine /Applications/Legenda\ AI\ pra\ mim.app
> ```
>
> **On Windows**: **More info → Run anyway**.

Once installed, the app **updates itself** (menu **Legenda AI pra mim → Check for
updates…**).

## What you need

- **ffmpeg** (to read embedded subtitles and convert video for the TV): on Mac,
  `brew install ffmpeg`. The app tells you if it's missing.
- **OpenSubtitles key** (only to download subtitles): create one for free at
  [opensubtitles.com](https://www.opensubtitles.com) → *Consumers* → generate an
  *API Key* and paste it into **⚙️ Settings**.
- To **translate**: on Mac you need nothing (it uses Apple's translator). Off Mac,
  install [Ollama](https://ollama.com) or use an Azure key.

## How to use

1. **Pick your languages** — in **⚙️ Settings → Languages**, set the app language
   and the subtitle language (used for both downloading and translating).
2. **Add videos** — the *Select videos* button (or a whole folder).
3. **Download a subtitle** — *Search on OpenSubtitles* → *Download* on the one
   with the "sync" badge.
4. **Translate** — click *Translate* on an embedded track or on a `.srt` subtitle
   that isn't in your language. The translated subtitle is saved **next to the
   video** (e.g., `Movie.pt-BR.srt`), ready for any player.
5. **Watch on the TV** — *📺 Play on TV*, pick the TV and the subtitle, and hit
   play. Use the time bar to skip.

Everything the app does shows up in real time in the **log column** on the right.

## Privacy

Your videos **never leave your computer**. Translation via Apple/Ollama is 100%
local. Only the subtitle text is sent if you choose Azure (cloud).

---

Built with [Bun](https://bun.sh) + [Electrobun](https://electrobun.dev) (no
Node/Electron). Want to contribute or look under the hood? See [DEV.md](DEV.md).
MIT License.
