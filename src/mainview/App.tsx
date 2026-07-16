import { useEffect, useRef, useState } from "react";
import { AppLogo } from "./AppLogo";
import { api, onCastStatus, onLog, onTranslateProgress } from "./api";
import { UI_LANG_CODES, langLabel, translate, type TKey } from "./i18n";
import type {
  AppSettings,
  CastDevice,
  CastPlaybackStatus,
  DependencyStatus,
  EmbeddedSubtitle,
  ExternalSubtitle,
  LogEntry,
  OllamaStatus,
  SubtitleResult,
  TranslationStatus,
  VideoInfo,
} from "../shared/types";

function formatLogTime(ms: number): string {
  const d = new Date(ms);
  return (
    d.toTimeString().slice(0, 8) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

// Idiomas oferecidos como ALVO das legendas (o rótulo vem do i18n, no idioma
// da UI). Os mesmos códigos são oferecidos como idioma da interface.
const LANGUAGE_CODES = ["pt-BR", "pt-PT", "en", "es", "fr", "it", "de", "ja"];

type VideoStatus = "analyzing" | "ready" | "error";

// Fila de tradução: no máximo 2 rodando ao mesmo tempo, o resto aguarda.
// (Ollama serializa num único modelo; Azure tem rate limit; OCR disputa CPU —
// então limitar a concorrência evita thrashing/429 e mantém previsível.)
const MAX_CONCURRENT = 2;
let qActive = 0;
let qPending: Array<{ key: string; start: () => void }> = [];
function qPump(): void {
  while (qActive < MAX_CONCURRENT && qPending.length > 0) {
    qActive++;
    qPending.shift()!.start();
  }
}
function qEnqueue(key: string, task: () => Promise<void>): void {
  qPending.push({
    key,
    start: () => {
      void task().finally(() => {
        qActive--;
        qPump();
      });
    },
  });
  qPump();
}
/** Remove da fila os itens ainda não iniciados; devolve as chaves removidas. */
function qClearPending(): string[] {
  const keys = qPending.map((p) => p.key);
  qPending = [];
  return keys;
}
/** Remove um item específico da fila (se ainda não iniciou). */
function qCancelPending(key: string): void {
  const i = qPending.findIndex((p) => p.key === key);
  if (i >= 0) qPending.splice(i, 1);
}

interface VideoState {
  id: string;
  path: string;
  name: string;
  info?: VideoInfo;
  status: VideoStatus;
  error?: string;
  searching: boolean;
  results?: SubtitleResult[];
  savedPath?: string;
  downloadingId?: number;
  extractingIndex?: number;
  /** Faixa aguardando na fila de tradução (ainda não começou). */
  queuedIndex?: number;
  translatingIndex?: number;
  /** Caminho da legenda .srt externa sendo traduzida (ou aguardando na fila). */
  translatingSrt?: string;
  queuedSrt?: string;
  translateDone?: number;
  translateTotal?: number;
  translatePhase?: "ocr" | "translate";
  /** Estado de tradução por índice de faixa (para Continuar/✔). */
  translations?: Record<number, TranslationStatus>;
  message?: string;
}

function formatSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Tamanho legível para arquivos pequenos (legendas): B / KB / MB. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

/** Pasta que contém o arquivo (sem depender de node:path). */
function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : path;
}

/** URL file:// para abrir um caminho local no gerenciador de arquivos. */
function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Normaliza um código/token de idioma para uma chave comparável
 * (pt-br/pt-pt/por → pt; en/eng → en; …). '' fica '' (idioma desconhecido). */
function langKey(code: string): string {
  const c = (code || "").toLowerCase();
  const map: Record<string, string> = {
    "pt-br": "pt", "pt-pt": "pt", pt: "pt", por: "pt",
    en: "en", eng: "en",
    es: "es", spa: "es",
    fr: "fr", fra: "fr", fre: "fr",
    it: "it", ita: "it",
    de: "de", deu: "de", ger: "de",
    ja: "ja", jpn: "ja",
  };
  return map[c] ?? c;
}

/** Segundos → mm:ss. */
function fmtTime(sec: number): string {
  if (!sec || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: "",
    language: "pt-BR",
    uiLanguage: "en",
    translationProvider: "ollama",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    azureKey: "",
    azureRegion: "",
    azureEndpoint: "https://api.cognitive.microsofttranslator.com",
    castRamGb: 0.5,
  });
  const [showSettings, setShowSettings] = useState(false);
  const [videos, setVideos] = useState<VideoState[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBodyRef = useRef<HTMLDivElement>(null);

  // Pastas selecionadas (re-varridas no refresh, ao focar a janela / botão).
  const [roots, setRoots] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // Espelhos em ref: o listener de foco lê o estado atual sem closure velha.
  const videosRef = useRef(videos);
  const rootsRef = useRef(roots);
  const refreshingRef = useRef(false);
  useEffect(() => {
    videosRef.current = videos;
  }, [videos]);
  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  // Cast (Tocar na TV)
  const [castStatus, setCastStatus] = useState<CastPlaybackStatus | null>(null);
  const [castPickerFor, setCastPickerFor] = useState<string | null>(null);
  const [castDevices, setCastDevices] = useState<CastDevice[]>([]);
  const [castDiscovering, setCastDiscovering] = useState(false);
  const [pickDevice, setPickDevice] = useState("");
  const [pickSub, setPickSub] = useState("");

  // Tradutor de strings da UI, no idioma escolhido nas Configurações.
  const t = (key: TKey, params?: Record<string, string | number>): string =>
    translate(settings.uiLanguage, key, params);
  const targetLabel = langLabel(settings.uiLanguage, settings.language);
  const aiReady =
    settings.translationProvider === "apple"
      ? true // on-device; sem credencial nem modelo a configurar
      : settings.translationProvider === "azure"
        ? Boolean(settings.azureKey)
        : Boolean(settings.ollamaModel);

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      if (!s.apiKey) setShowSettings(true);
    });
  }, []);

  // Re-varre o disco quando a janela volta ao foco (arquivos podem ter sido
  // adicionados/removidos/renomeados por fora). Debounce pra não repetir.
  useEffect(() => {
    let last = 0;
    const trigger = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      void refresh();
    };
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      window.removeEventListener("focus", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
    // refresh usa refs internamente — seguro registrar só uma vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Estado de reprodução na TV (Chromecast) em tempo real.
  useEffect(
    () =>
      onCastStatus((s) =>
        setCastStatus(s.playerState === "STOPPED" ? null : s),
      ),
    [],
  );

  // Log do backend: pega o histórico e assina as novas linhas em tempo real.
  useEffect(() => {
    api.getLogBuffer().then(setLogs);
    return onLog((entry) =>
      setLogs((prev) => {
        const trimmed =
          prev.length > 1500 ? prev.slice(prev.length - 1200) : prev;
        return [...trimmed, entry];
      }),
    );
  }, []);

  // Auto-scroll da coluna de log para o fim.
  useEffect(() => {
    const el = logBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  // Recebe o progresso da tradução vindo do processo Bun e atualiza o card.
  useEffect(
    () =>
      onTranslateProgress((p) => {
        setVideos((prev) =>
          prev.map((v) =>
            v.info?.path === p.path
              ? {
                  ...v,
                  translateDone: p.done,
                  translateTotal: p.total,
                  translatePhase: p.phase,
                }
              : v,
          ),
        );
      }),
    [],
  );

  function patch(id: string, next: Partial<VideoState>): void {
    setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, ...next } : v)));
  }

  // Re-detecta as legendas .srt do disco (após baixar/extrair/traduzir, um novo
  // arquivo pode ter surgido) e atualiza o card.
  async function refreshExternal(id: string, path: string): Promise<void> {
    try {
      const external = await api.listExternalSubtitles(path);
      setVideos((prev) =>
        prev.map((v) =>
          v.id === id && v.info ? { ...v, info: { ...v.info, external } } : v,
        ),
      );
    } catch {
      // silencioso — a lista externa é apenas informativa
    }
  }

  async function addPaths(paths: string[]): Promise<void> {
    const known = new Set(videos.map((v) => v.path));
    const fresh = paths.filter((p) => !known.has(p));
    if (fresh.length === 0) return;

    const additions: VideoState[] = fresh.map((path, i) => ({
      id: `${Date.now()}-${i}-${baseName(path)}`,
      path,
      name: baseName(path),
      status: "analyzing",
      searching: false,
    }));
    setVideos((prev) => [...prev, ...additions]);

    for (const item of additions) {
      try {
        const info = await api.analyzeVideo(item.path);
        patch(item.id, { info, status: "ready" });
        void fetchTranslations(item.id, info);
      } catch (err) {
        patch(item.id, { status: "error", error: (err as Error).message });
      }
    }
  }

  /** Busca o estado de tradução (Continuar/✔) de cada faixa embutida. */
  async function fetchTranslations(id: string, info: VideoInfo): Promise<void> {
    if (info.embedded.length === 0) return;
    const map: Record<number, TranslationStatus> = {};
    for (const sub of info.embedded) {
      map[sub.index] = await api.translationStatus({
        path: info.path,
        index: sub.index,
        sourceLanguage: sub.language,
        isText: sub.isText,
      });
    }
    patch(id, { translations: map });
  }

  async function pickVideos(): Promise<void> {
    setPicking(true);
    try {
      await addPaths(await api.selectVideos());
    } finally {
      setPicking(false);
    }
  }

  async function pickFolder(): Promise<void> {
    setPickingFolder(true);
    try {
      const { dir, videos: found } = await api.selectFolder();
      if (dir) setRoots((r) => (r.includes(dir) ? r : [...r, dir]));
      await addPaths(found);
    } finally {
      setPickingFolder(false);
    }
  }

  /**
   * Reconcilia a lista com o disco: re-varre as pastas escolhidas (adiciona
   * novos, remove os que sumiram/renomearam) e atualiza legendas+status dos
   * sobreviventes. Pasta inacessível (drive ejetado) é IGNORADA — não some com
   * a lista. Não mexe em vídeos com tradução em andamento.
   */
  async function refresh(): Promise<void> {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const cur = videosRef.current;
      // 1. re-varre as raízes; pula as inacessíveis (não zera a lista)
      const scanned = new Set<string>();
      const reachable: string[] = [];
      for (const dir of rootsRef.current) {
        try {
          const res = await api.listVideosInFolder(dir);
          if (!res.ok) continue;
          reachable.push(dir);
          for (const p of res.videos) scanned.add(p);
        } catch {
          // inacessível — ignora esta raiz
        }
      }
      const underReachable = (p: string) =>
        reachable.some((r) => p === r || p.startsWith(r.replace(/\/?$/, "/")));

      // 2. remove os que sumiram de uma raiz alcançável (deletados/renomeados)
      const removed = new Set(
        cur.filter((v) => underReachable(v.path) && !scanned.has(v.path)).map((v) => v.path),
      );
      // 3. arquivos AVULSOS (fora de qualquer raiz): confere existência 1 a 1
      for (const v of cur) {
        if (removed.has(v.path) || underReachable(v.path)) continue;
        if (!(await api.pathExists(v.path))) removed.add(v.path);
      }
      if (removed.size)
        setVideos((prev) => prev.filter((v) => !removed.has(v.path)));

      // 4. adiciona os vídeos novos que apareceram nas pastas
      const curPaths = new Set(cur.map((v) => v.path));
      const toAdd = [...scanned].filter((p) => !curPaths.has(p));
      if (toAdd.length) await addPaths(toAdd);

      // 5. sobreviventes: refresca legendas externas + status (barato), exceto
      //    os que estão traduzindo (não atropela o progresso ao vivo)
      for (const v of cur) {
        if (removed.has(v.path) || !v.info) continue;
        const busy =
          v.translatingIndex != null ||
          v.translatingSrt != null ||
          v.queuedIndex != null ||
          v.queuedSrt != null;
        if (busy) continue;
        await refreshExternal(v.id, v.path);
        void fetchTranslations(v.id, v.info);
      }
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  async function search(video: VideoState): Promise<void> {
    if (!video.info) return;
    patch(video.id, {
      searching: true,
      message: undefined,
      results: undefined,
    });
    try {
      const results = await api.searchSubtitles({
        video: video.info,
        language: settings.language,
      });
      patch(video.id, {
        searching: false,
        results,
        message: results.length === 0 ? t("noSyncSubtitle") : undefined,
      });
    } catch (err) {
      patch(video.id, { searching: false, message: (err as Error).message });
    }
  }

  async function download(
    video: VideoState,
    result: SubtitleResult,
  ): Promise<void> {
    if (!video.info) return;
    patch(video.id, { downloadingId: result.fileId, message: undefined });
    try {
      const { savedPath } = await api.downloadSubtitle({
        video: video.info,
        result,
      });
      patch(video.id, { downloadingId: undefined, savedPath });
      void refreshExternal(video.id, video.info.path);
    } catch (err) {
      patch(video.id, {
        downloadingId: undefined,
        message: (err as Error).message,
      });
    }
  }

  async function extractEmbedded(
    video: VideoState,
    sub: EmbeddedSubtitle,
  ): Promise<void> {
    if (!video.info) return;
    patch(video.id, { extractingIndex: sub.index, message: undefined });
    try {
      const { savedPath } = await api.extractEmbedded({
        path: video.info.path,
        index: sub.index,
        language: sub.language,
        isText: sub.isText,
      });
      patch(video.id, { extractingIndex: undefined, savedPath });
      void refreshExternal(video.id, video.info.path);
    } catch (err) {
      patch(video.id, {
        extractingIndex: undefined,
        message: (err as Error).message,
      });
    }
  }

  // Enfileira uma tradução (marca "na fila" na hora; a fila roda no máx. 2).
  function aiTranslate(video: VideoState, sub: EmbeddedSubtitle): void {
    if (!video.info) return;
    if (!sub.isText && !video.info.ocrAvailable) return;
    const info = video.info;
    patch(video.id, { queuedIndex: sub.index, message: undefined });
    qEnqueue(`${video.id}:${sub.index}`, () => runTranslate(video.id, info, sub));
  }

  // Executa de fato a tradução (chamado pela fila quando há vaga).
  async function runTranslate(
    videoId: string,
    info: VideoInfo,
    sub: EmbeddedSubtitle,
  ): Promise<void> {
    patch(videoId, {
      queuedIndex: undefined,
      translatingIndex: sub.index,
      translateDone: 0,
      translateTotal: 0,
      translatePhase: sub.isText ? "translate" : "ocr",
    });
    try {
      const res = await api.aiTranslateEmbedded({
        path: info.path,
        index: sub.index,
        sourceLanguage: sub.language,
        isText: sub.isText,
      });
      setVideos((prev) =>
        prev.map((v) =>
          v.id === videoId
            ? {
                ...v,
                translatingIndex: undefined,
                savedPath: res.savedPath,
                translations: {
                  ...(v.translations ?? {}),
                  [sub.index]: { done: res.done, total: res.total },
                },
              }
            : v,
        ),
      );
      void refreshExternal(videoId, info.path);
    } catch (err) {
      patch(videoId, {
        translatingIndex: undefined,
        message: (err as Error).message,
      });
      // pode ter salvo um parcial antes do erro — reflete o status atualizado
      const st = await api.translationStatus({
        path: info.path,
        index: sub.index,
        sourceLanguage: sub.language,
        isText: sub.isText,
      });
      setVideos((prev) =>
        prev.map((v) =>
          v.id === videoId
            ? {
                ...v,
                translations: { ...(v.translations ?? {}), [sub.index]: st },
              }
            : v,
        ),
      );
    }
  }

  // Enfileira a tradução de uma legenda .srt EXTERNA (mesma fila de máx. 2).
  function aiTranslateSrt(video: VideoState, srt: ExternalSubtitle): void {
    if (!video.info) return;
    const videoPath = video.info.path;
    patch(video.id, { queuedSrt: srt.path, message: undefined });
    qEnqueue(`${video.id}:srt:${srt.path}`, () =>
      runTranslateSrt(video.id, videoPath, srt),
    );
  }

  async function runTranslateSrt(
    videoId: string,
    videoPath: string,
    srt: ExternalSubtitle,
  ): Promise<void> {
    patch(videoId, {
      queuedSrt: undefined,
      translatingSrt: srt.path,
      translateDone: 0,
      translateTotal: 0,
      translatePhase: "translate",
    });
    try {
      await api.aiTranslateSrt(videoPath, srt.path, srt.language);
      patch(videoId, { translatingSrt: undefined });
      void refreshExternal(videoId, videoPath);
    } catch (err) {
      patch(videoId, {
        translatingSrt: undefined,
        message: t("translateSubtitleFailed", { msg: (err as Error).message }),
      });
    }
  }

  // Enfileira UMA faixa por vídeo (a 1ª traduzível e ainda não concluída).
  function translateAll(): void {
    for (const video of videos) {
      if (!video.info) continue;
      if (video.translatingIndex !== undefined || video.queuedIndex !== undefined)
        continue;
      const sub = video.info.embedded.find((s) => {
        const st = video.translations?.[s.index];
        const complete = !!st && st.total > 0 && st.done >= st.total;
        return (s.isText || video.info!.ocrAvailable) && !complete;
      });
      if (sub) aiTranslate(video, sub);
    }
  }

  // Esvazia a fila (reseta "na fila") e aborta as traduções em andamento.
  async function cancelAll(): Promise<void> {
    qClearPending();
    setVideos((prev) =>
      prev.map((v) =>
        v.queuedIndex !== undefined || v.queuedSrt !== undefined
          ? { ...v, queuedIndex: undefined, queuedSrt: undefined }
          : v,
      ),
    );
    const active = videos.filter(
      (v) =>
        (v.translatingIndex !== undefined || v.translatingSrt !== undefined) &&
        v.info,
    );
    await Promise.all(active.map((v) => api.cancelTranslate(v.info!.path)));
  }

  async function cancelTranslate(video: VideoState): Promise<void> {
    if (!video.info) return;
    await api.cancelTranslate(video.info.path);
  }

  async function removeVideo(video: VideoState): Promise<void> {
    // Tira da fila (se aguardando) e cancela no backend (se em andamento).
    if (video.queuedIndex !== undefined) {
      qCancelPending(`${video.id}:${video.queuedIndex}`);
    }
    if (video.queuedSrt !== undefined) {
      qCancelPending(`${video.id}:srt:${video.queuedSrt}`);
    }
    if (
      (video.translatingIndex !== undefined ||
        video.translatingSrt !== undefined) &&
      video.info
    ) {
      await api.cancelTranslate(video.info.path);
    }
    setVideos((prev) => prev.filter((v) => v.id !== video.id));
  }

  // --- Tocar na TV (Chromecast) ---
  async function openCastPicker(video: VideoState): Promise<void> {
    if (!video.info) return;
    setCastPickerFor(video.id);
    setCastDevices([]);
    setPickDevice("");
    // Default: a legenda no idioma alvo (ex.: a traduzida "Filme.pt-br.srt");
    // se não houver, a primeira disponível.
    const target = settings.language.toLowerCase();
    const preferred =
      video.info.external.find((s) => s.language.toLowerCase() === target) ??
      video.info.external[0];
    setPickSub(preferred?.path ?? "");
    setCastDiscovering(true);
    try {
      const devs = await api.castDiscover();
      setCastDevices(devs);
      setPickDevice(devs[0]?.id ?? "");
    } finally {
      setCastDiscovering(false);
    }
  }

  async function startCast(video: VideoState): Promise<void> {
    if (!video.info || !pickDevice) return;
    const dev = castDevices.find((d) => d.id === pickDevice);
    if (!dev) return;
    const sub = video.info.external.find((s) => s.path === pickSub);
    setCastPickerFor(null);
    try {
      await api.castStart({
        deviceHost: dev.host,
        deviceName: dev.name,
        protocol: dev.protocol,
        controlUrl: dev.controlUrl,
        videoPath: video.info.path,
        subtitlePath: sub?.path,
        subtitleLang: sub?.language || undefined,
        subtitleLabel: sub
          ? sub.language.toUpperCase() || t("subtitle")
          : undefined,
        title: video.name,
        ramGb: settings.castRamGb,
      });
    } catch (err) {
      patch(video.id, {
        message: t("castFailed", { msg: (err as Error).message }),
      });
    }
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    const saved = await api.saveSettings(next);
    setSettings(saved);
    setShowSettings(false);
    // idioma alvo pode ter mudado → recomputa Continuar/✔ de cada vídeo
    for (const v of videos) if (v.info) void fetchTranslations(v.id, v.info);
  }

  return (
    <div className="shell">
      <div className="main-area">
        <header className="titlebar electrobun-webkit-app-region-drag">
          <div className="brand">
            <span className="logo">
              <AppLogo size={36} />
            </span>
            <div>
              <h1>Legenda AI pra mim</h1>
              <p>{t("appTagline")}</p>
            </div>
          </div>
          <button
            className="ghost electrobun-webkit-app-region-no-drag"
            onClick={() => setShowSettings(true)}
          >
            ⚙️ {t("settings")}
          </button>
        </header>

        <main className="content">
          {castStatus && (
            <div className="cast-bar">
              <span className="cast-dev">📺 {castStatus.device}</span>
              <button
                className="ghost sm"
                title={castStatus.playerState === "PLAYING" ? t("pause") : t("play")}
                onClick={() =>
                  api.castControl(
                    castStatus.playerState === "PLAYING" ? "pause" : "play",
                  )
                }
              >
                {castStatus.playerState === "PLAYING" ? "⏸" : "▶"}
              </button>
              <button
                className="ghost sm"
                title={t("stop")}
                onClick={() => api.castControl("stop")}
              >
                ⏹
              </button>
              <span className="muted cast-time">
                {fmtTime(castStatus.currentTime)}
                {castStatus.duration > 0 && ` / ${fmtTime(castStatus.duration)}`}
              </span>
              <div
                className="cast-track cast-seekable"
                title={t("seekHint")}
                onClick={(e) => {
                  if (!castStatus.duration) return;
                  const r = e.currentTarget.getBoundingClientRect();
                  const frac = Math.min(
                    1,
                    Math.max(0, (e.clientX - r.left) / r.width),
                  );
                  void api.castControl("seek", frac * castStatus.duration);
                }}
              >
                <div
                  className="cast-fill"
                  style={{
                    width: castStatus.duration
                      ? `${Math.min(100, (castStatus.currentTime / castStatus.duration) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
              <span className="muted cast-state">
                {castStatus.playerState === "BUFFERING"
                  ? t("loadingShort")
                  : castStatus.playerState.toLowerCase()}
              </span>
            </div>
          )}

          <section className="dropzone">
            <p className="dz-title">{t("addYourVideos")}</p>
            <div className="dz-actions">
              <button
                className="primary"
                onClick={pickVideos}
                disabled={picking}
              >
                {picking ? t("opening") : t("selectVideos")}
              </button>
              <button
                className="ghost"
                onClick={pickFolder}
                disabled={pickingFolder}
              >
                {pickingFolder ? t("scanningFolder") : `📁 ${t("selectFolder")}`}
              </button>
            </div>
            {!settings.apiKey && <p className="warn">{t("apiKeyWarning")}</p>}
          </section>

          {videos.length > 0 &&
            (() => {
              const anyBusy = videos.some(
                (v) =>
                  v.translatingIndex !== undefined ||
                  v.queuedIndex !== undefined ||
                  v.translatingSrt !== undefined ||
                  v.queuedSrt !== undefined,
              );
              const canTranslateAny = videos.some(
                (v) =>
                  v.info &&
                  v.translatingIndex === undefined &&
                  v.queuedIndex === undefined &&
                  v.info.embedded.some((s) => {
                    const st = v.translations?.[s.index];
                    const complete = !!st && st.total > 0 && st.done >= st.total;
                    return (s.isText || v.info!.ocrAvailable) && !complete;
                  }),
              );
              return (
                <div className="list-toolbar">
                  <p className="list-count">
                    {t(
                      videos.length === 1
                        ? "videosInList_one"
                        : "videosInList_other",
                      { count: videos.length },
                    )}
                  </p>
                  <span className="toolbar-spacer" />
                  <span className="muted">
                    {t("queueInfo", { n: MAX_CONCURRENT })}
                  </span>
                  <button
                    className="ghost sm"
                    onClick={() => void refresh()}
                    disabled={refreshing}
                    title={t("refreshTitle")}
                  >
                    {refreshing ? t("updating") : `🔄 ${t("refresh")}`}
                  </button>
                  {anyBusy && (
                    <button className="ghost sm" onClick={cancelAll}>
                      {t("cancelAll")}
                    </button>
                  )}
                  <button
                    className="primary sm"
                    disabled={!aiReady || !canTranslateAny}
                    title={
                      aiReady
                        ? t("translateAllTitle", {
                            lang: targetLabel,
                            n: MAX_CONCURRENT,
                          })
                        : t("translateEngineHint")
                    }
                    onClick={translateAll}
                  >
                    {t("translateAll", {
                      code: settings.language.toUpperCase(),
                    })}
                  </button>
                </div>
              );
            })()}

          <section className="list">
            {videos.map((video) => (
              <article className="card" key={video.id}>
                <div className="card-head">
                  <div className="card-meta">
                    <strong title={video.path}>{video.name}</strong>
                    <span className="muted">
                      {video.status === "analyzing" && t("computingHash")}
                      {video.status === "error" &&
                        t("errorPrefix", { msg: video.error ?? "" })}
                      {video.info &&
                        `${formatSize(video.info.size)} · hash ${video.info.hash}`}
                    </span>
                  </div>
                  <div className="card-head-actions">
                    <button
                      className="ghost sm"
                      disabled={!video.info || castPickerFor === video.id}
                      title={t("playOnTvTitle")}
                      onClick={() => openCastPicker(video)}
                    >
                      📺 {t("playOnTv")}
                    </button>
                    <button
                      className="primary sm"
                      disabled={video.status !== "ready" || video.searching}
                      onClick={() => search(video)}
                    >
                      {video.searching ? t("searching") : t("searchOpenSubtitles")}
                    </button>
                    <button
                      className="ghost sm remove-btn"
                      title={t("removeFromList")}
                      onClick={() => removeVideo(video)}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {castPickerFor === video.id && video.info && (
                  <div className="cast-picker">
                    <span className="section-label">📺 {t("playOnTv")}</span>
                    {castDiscovering ? (
                      <span className="muted">{t("searchingDevices")}</span>
                    ) : castDevices.length === 0 ? (
                      <span className="muted">{t("noTvFound")}</span>
                    ) : (
                      <div className="cast-picker-row">
                        <label>
                          {t("device")}
                          <select
                            value={pickDevice}
                            onChange={(e) => setPickDevice(e.target.value)}
                          >
                            {castDevices.map((d) => (
                              <option key={`${d.protocol}:${d.id}`} value={d.id}>
                                {d.protocol === "dlna" ? "📡" : "📺"} {d.name}
                                {d.model ? ` (${d.model})` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("subtitle")}
                          <select
                            value={pickSub}
                            onChange={(e) => setPickSub(e.target.value)}
                          >
                            <option value="">{t("noSubtitle")}</option>
                            {video.info.external.map((s: ExternalSubtitle) => (
                              <option key={s.path} value={s.path}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="primary sm"
                          disabled={!pickDevice}
                          onClick={() => startCast(video)}
                        >
                          ▶ {t("play")}
                        </button>
                      </div>
                    )}
                    <button
                      className="ghost sm"
                      onClick={() => setCastPickerFor(null)}
                    >
                      {t("close")}
                    </button>
                  </div>
                )}

                {video.info && video.info.embedded.length > 0 && (
                  <div className="embedded">
                    <p className="section-label">{t("embeddedTitle")}</p>
                    <ul className="results">
                      {video.info.embedded.map((sub) => {
                        const st = video.translations?.[sub.index];
                        const translating =
                          video.translatingIndex === sub.index;
                        const queued = video.queuedIndex === sub.index;
                        const busy =
                          video.translatingIndex !== undefined ||
                          video.queuedIndex !== undefined ||
                          video.translatingSrt !== undefined ||
                          video.queuedSrt !== undefined;
                        const complete =
                          !!st && st.total > 0 && st.done >= st.total;
                        const partial =
                          !!st &&
                          st.total > 0 &&
                          st.done > 0 &&
                          st.done < st.total;
                        const image = !sub.isText;
                        const canOcr = image && video.info!.ocrAvailable;
                        const blockedImage = image && !video.info!.ocrAvailable;
                        return (
                          <li key={sub.index}>
                            <div className="result-info">
                              <span className="result-title">
                                {sub.isDefault && (
                                  <span className="badge">
                                    {t("badgeDefault")}
                                  </span>
                                )}
                                {sub.isForced && (
                                  <span className="badge">
                                    {t("badgeForced")}
                                  </span>
                                )}
                                {image && (
                                  <span className="badge badge-img">
                                    {t("badgeImage")}
                                  </span>
                                )}
                                {sub.title || t("trackN", { index: sub.index })} ·{" "}
                                {sub.language}
                              </span>
                              <span className="muted">
                                {sub.codec}
                                {canOcr && t("imageWillOcr")}
                                {blockedImage && t("imageOcrUnavailable")}
                              </span>
                            </div>
                            <div className="btn-group">
                              <button
                                className="ghost sm"
                                title={image ? t("extractImageTitle") : undefined}
                                disabled={video.extractingIndex === sub.index}
                                onClick={() => extractEmbedded(video, sub)}
                              >
                                {video.extractingIndex === sub.index
                                  ? t("extracting")
                                  : image
                                    ? t("extractSup")
                                    : t("extractSrt")}
                              </button>
                              <button
                                className={`sm ${partial ? "continue" : "primary"}`}
                                title={
                                  blockedImage
                                    ? t("translateImageBlockedTitle")
                                    : aiReady
                                      ? t("translateTrackTitle", {
                                          lang: targetLabel,
                                          provider: settings.translationProvider,
                                          ocr: image ? t("viaOcrSuffix") : "",
                                        })
                                      : t("translateEngineTitle")
                                }
                                disabled={
                                  blockedImage || !aiReady || complete || busy
                                }
                                onClick={() => aiTranslate(video, sub)}
                              >
                                {blockedImage
                                  ? t("requiresOcr")
                                  : queued
                                    ? t("inQueue")
                                    : translating
                                      ? t("processing")
                                      : complete
                                        ? t("translated")
                                        : partial
                                          ? t("continueProgress", {
                                              done: st!.done,
                                              total: st!.total,
                                            })
                                          : t("translateArrow", {
                                              prefix: image
                                                ? t("ocrAndTranslate")
                                                : t("translate"),
                                              code: settings.language.toUpperCase(),
                                            })}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {video.info &&
                  video.info.external.length > 0 &&
                  (() => {
                    const targetKey = langKey(settings.language);
                    // Já existe alguma .srt no idioma alvo? (então nada a traduzir)
                    const hasTargetSrt = video.info.external.some(
                      (s) => s.language && langKey(s.language) === targetKey,
                    );
                    const videoBusy =
                      video.translatingIndex !== undefined ||
                      video.queuedIndex !== undefined ||
                      video.translatingSrt !== undefined ||
                      video.queuedSrt !== undefined;
                    return (
                      <div className="embedded">
                        <p className="section-label">{t("externalTitle")}</p>
                        <ul className="results">
                          {video.info.external.map((srt) => {
                            const isTarget =
                              !!srt.language &&
                              langKey(srt.language) === targetKey;
                            const translatingThis =
                              video.translatingSrt === srt.path;
                            const queuedThis = video.queuedSrt === srt.path;
                            return (
                              <li key={srt.path}>
                                <div className="result-info">
                                  <span className="result-title">
                                    {srt.language && (
                                      <span className="badge">
                                        {srt.language.toUpperCase()}
                                      </span>
                                    )}
                                    {srt.name}
                                  </span>
                                  <span className="muted">
                                    {fileSize(srt.size)}
                                  </span>
                                </div>
                                <div className="btn-group">
                                  {!isTarget && (
                                    <button
                                      className="primary sm"
                                      disabled={
                                        hasTargetSrt || !aiReady || videoBusy
                                      }
                                      title={
                                        hasTargetSrt
                                          ? t("hasTargetTitle", {
                                              lang: targetLabel,
                                            })
                                          : aiReady
                                            ? t("translateThisTitle", {
                                                lang: targetLabel,
                                              })
                                            : t("translateEngineHint")
                                      }
                                      onClick={() => aiTranslateSrt(video, srt)}
                                    >
                                      {queuedThis
                                        ? t("inQueue")
                                        : translatingThis
                                          ? t("translating")
                                          : t("translateShortArrow", {
                                              code: settings.language.toUpperCase(),
                                            })}
                                    </button>
                                  )}
                                  <button
                                    className="ghost sm"
                                    title={t("openFolderTitle")}
                                    onClick={() =>
                                      api.openExternal(fileUrl(folderOf(srt.path)))
                                    }
                                  >
                                    {t("openFolder")}
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })()}

                {(video.translatingIndex !== undefined ||
                  video.translatingSrt !== undefined) && (
                  <div className="progress">
                    <div className="progress-head">
                      <span className="muted">
                        {video.translatePhase === "ocr"
                          ? t("ocrPhase")
                          : settings.translationProvider === "azure"
                            ? t("translatingAzure")
                            : settings.translationProvider === "apple"
                              ? t("translatingApple")
                              : t("translatingOllama")}
                        <strong>
                          {video.translateDone ?? 0}/{video.translateTotal ?? 0}
                        </strong>{" "}
                        {t("linesWord")}
                      </span>
                      <button
                        className="ghost sm"
                        onClick={() => cancelTranslate(video)}
                      >
                        {t("cancel")}
                      </button>
                    </div>
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{
                          width: video.translateTotal
                            ? `${Math.round(((video.translateDone ?? 0) / video.translateTotal) * 100)}%`
                            : "0%",
                        }}
                      />
                    </div>
                  </div>
                )}

                {video.info && !video.info.ffmpegAvailable && (
                  <p className="muted embedded-hint">{t("ffmpegHint")}</p>
                )}

                {video.savedPath && (
                  <p className="ok">
                    {t("savedTo", { path: video.savedPath })}
                  </p>
                )}
                {video.message && <p className="warn">{video.message}</p>}

                {video.results && video.results.length > 0 && (
                  <ul className="results">
                    {video.results.map((r) => (
                      <li key={r.fileId}>
                        <div className="result-info">
                          <span className="result-title">
                            {r.fromHashMatch && (
                              <span className="badge">{t("badgeSync")}</span>
                            )}
                            {r.release || r.fileName}
                          </span>
                          <span className="muted">
                            {t("downloadsCount", {
                              lang: r.language,
                              n: r.downloadCount.toLocaleString(
                                settings.uiLanguage,
                              ),
                            })}
                            {r.ratings ? ` · ⭐ ${r.ratings}` : ""}
                          </span>
                        </div>
                        <button
                          className="ghost sm"
                          disabled={video.downloadingId === r.fileId}
                          onClick={() => download(video, r)}
                        >
                          {video.downloadingId === r.fileId
                            ? t("downloading")
                            : t("download")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>
        </main>
      </div>

      <aside className="log-panel">
        <div className="log-head electrobun-webkit-app-region-drag">
          <span className="section-label">{t("backendLog")}</span>
          <button
            className="ghost sm electrobun-webkit-app-region-no-drag"
            onClick={() => setLogs([])}
          >
            {t("clear")}
          </button>
        </div>
        <div className="log-body" ref={logBodyRef}>
          {logs.map((l, i) => (
            <div key={i} className={`log-line log-${l.level}`}>
              <span className="log-time">{formatLogTime(l.time)}</span>
              <span className="log-msg">{l.message}</span>
            </div>
          ))}
          {logs.length === 0 && (
            <div className="log-empty">{t("noEventsYet")}</div>
          )}
        </div>
      </aside>

      {showSettings && (
        <SettingsModal
          settings={settings}
          t={t}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          onImported={setSettings}
        />
      )}
    </div>
  );
}

function SettingsModal({
  settings,
  t,
  onClose,
  onSave,
  onImported,
}: {
  settings: AppSettings;
  t: (key: TKey, params?: Record<string, string | number>) => string;
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  onImported: (s: AppSettings) => void;
}) {
  const [tab, setTab] = useState<
    "languages" | "checklist" | "download" | "translate" | "playback"
  >("languages");
  const [ioMsg, setIoMsg] = useState("");
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [language, setLanguage] = useState(settings.language);
  const [uiLanguage, setUiLanguage] = useState(settings.uiLanguage);
  const [provider, setProvider] = useState(settings.translationProvider);
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl);
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel);
  const [azureKey, setAzureKey] = useState(settings.azureKey);
  const [azureRegion, setAzureRegion] = useState(settings.azureRegion);
  const [azureEndpoint, setAzureEndpoint] = useState(settings.azureEndpoint);
  const [castRamGb, setCastRamGb] = useState(settings.castRamGb);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  const [aiStatus, setAiStatus] = useState<OllamaStatus | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [deps, setDeps] = useState<DependencyStatus[] | null>(null);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [azureValidating, setAzureValidating] = useState(false);
  const [azureValidation, setAzureValidation] = useState<{
    valid: boolean;
    message: string;
  } | null>(null);
  // Só fecha se o clique começou E terminou no backdrop (não em seleção de texto).
  const pressedOnBackdrop = useRef(false);

  async function loadModels(): Promise<void> {
    setLoadingModels(true);
    try {
      const status = await api.listAiModels();
      setAiStatus(status);
      if (status.models.length && !status.models.includes(ollamaModel)) {
        setOllamaModel(status.models[0]);
      }
    } finally {
      setLoadingModels(false);
    }
  }

  async function checkDeps(): Promise<void> {
    setCheckingDeps(true);
    try {
      setDeps(await api.checkDependencies());
    } finally {
      setCheckingDeps(false);
    }
  }

  useEffect(() => {
    loadModels();
    checkDeps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function validate(): Promise<void> {
    setValidating(true);
    setValidation(null);
    try {
      setValidation(await api.validateApiKey(apiKey.trim()));
    } finally {
      setValidating(false);
    }
  }

  async function pasteInto(setter: (v: string) => void): Promise<void> {
    const text = await api.readClipboard();
    if (text) setter(text.trim());
  }

  function applySettings(s: AppSettings): void {
    setApiKey(s.apiKey);
    setLanguage(s.language);
    setUiLanguage(s.uiLanguage);
    setProvider(s.translationProvider);
    setOllamaUrl(s.ollamaUrl);
    setOllamaModel(s.ollamaModel);
    setAzureKey(s.azureKey);
    setAzureRegion(s.azureRegion);
    setAzureEndpoint(s.azureEndpoint);
    setCastRamGb(s.castRamGb);
  }

  async function doExport(): Promise<void> {
    const { savedPath } = await api.exportSettings();
    setIoMsg(savedPath ? t("exportedTo", { path: savedPath }) : "");
  }

  async function doImport(): Promise<void> {
    try {
      const s = await api.importSettings();
      applySettings(s);
      onImported(s); // já foi salvo no disco pelo backend; reflete no app também
      setIoMsg(t("settingsImported"));
    } catch (e) {
      setIoMsg(t("importFailed", { msg: (e as Error).message }));
    }
  }

  // Azure valida no backend com as credenciais salvas — então salva antes.
  async function validateAzureCreds(): Promise<void> {
    setAzureValidating(true);
    setAzureValidation(null);
    try {
      await api.saveSettings({
        ...settings,
        translationProvider: provider,
        azureKey: azureKey.trim(),
        azureRegion: azureRegion.trim(),
        azureEndpoint: azureEndpoint.trim(),
      });
      setAzureValidation(await api.validateAzure());
    } finally {
      setAzureValidating(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnBackdrop.current)
          onClose();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h2>{t("settings")}</h2>
          <div className="tabs">
            <button
              className={`tab ${tab === "languages" ? "active" : ""}`}
              onClick={() => setTab("languages")}
            >
              {t("tabLanguages")}
            </button>
            <button
              className={`tab ${tab === "checklist" ? "active" : ""}`}
              onClick={() => setTab("checklist")}
            >
              {t("tabChecklist")}
            </button>
            <button
              className={`tab ${tab === "download" ? "active" : ""}`}
              onClick={() => setTab("download")}
            >
              {t("tabDownload")}
            </button>
            <button
              className={`tab ${tab === "translate" ? "active" : ""}`}
              onClick={() => setTab("translate")}
            >
              {t("tabTranslate")}
            </button>
            <button
              className={`tab ${tab === "playback" ? "active" : ""}`}
              onClick={() => setTab("playback")}
            >
              {t("tabPlayback")}
            </button>
          </div>
        </div>

        <div className="modal-body">
          {tab === "languages" && (
            <div className="ai-section">
              <label>
                {t("uiLanguageLabel")}
                <select
                  value={uiLanguage}
                  onChange={(e) => setUiLanguage(e.target.value)}
                >
                  {UI_LANG_CODES.map((code) => (
                    <option key={code} value={code}>
                      {langLabel(code, code)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("subtitleLangLabel")}
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  {LANGUAGE_CODES.map((code) => (
                    <option key={code} value={code}>
                      {langLabel(settings.uiLanguage, code)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {tab === "checklist" && (
            <div className="deps">
              <div className="deps-head">
                <span className="section-label">{t("externalDeps")}</span>
                <button
                  className="ghost sm"
                  onClick={checkDeps}
                  disabled={checkingDeps}
                >
                  {checkingDeps ? t("checking") : t("recheck")}
                </button>
              </div>
              <ul className="dep-list">
                {(deps ?? []).map((dep) => (
                  <li
                    key={dep.name}
                    className={dep.found ? "dep-ok" : "dep-missing"}
                  >
                    <span className="dep-icon">{dep.found ? "✅" : "❌"}</span>
                    <div className="dep-info">
                      <span className="dep-name">
                        {dep.name}{" "}
                        <span className="muted">— {dep.purpose}</span>
                      </span>
                      <span className="dep-detail">{dep.detail}</span>
                    </div>
                  </li>
                ))}
                {deps === null && <li className="muted">{t("checking")}</li>}
              </ul>
            </div>
          )}

          {tab === "download" && (
            <>
              <label>
                {t("osApiKeyLabel")}
                <div className="key-row">
                  <input
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={apiKey}
                    placeholder={t("pasteApiKeyPlaceholder")}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setValidation(null);
                    }}
                  />
                  <button
                    className="ghost sm"
                    onClick={() =>
                      pasteInto((v) => {
                        setApiKey(v);
                        setValidation(null);
                      })
                    }
                  >
                    {t("paste")}
                  </button>
                  <button
                    className="ghost sm"
                    onClick={validate}
                    disabled={validating || !apiKey.trim()}
                  >
                    {validating ? t("validating") : t("validate")}
                  </button>
                </div>
              </label>
              {validation && (
                <p className={validation.valid ? "ok" : "warn"}>
                  {validation.message}
                </p>
              )}
              <p className="hint">
                {t("noApiKeyQuestion")}
                <a
                  href="https://www.opensubtitles.com/en/consumers"
                  onClick={(e) => {
                    e.preventDefault();
                    api.openExternal(
                      "https://www.opensubtitles.com/en/consumers",
                    );
                  }}
                >
                  {t("openConsumers")}
                </a>
              </p>
            </>
          )}

          {tab === "translate" && (
            <div className="ai-section">
              <label>
                {t("providerLabel")}
                <select
                  value={provider}
                  onChange={(e) =>
                    setProvider(e.target.value as typeof provider)
                  }
                >
                  <option value="apple">{t("providerApple")}</option>
                  <option value="ollama">{t("providerOllama")}</option>
                  <option value="azure">{t("providerAzure")}</option>
                </select>
              </label>

              {provider === "apple" && (
                <p className="hint">{t("appleHint")}</p>
              )}

              {provider === "ollama" && (
                <>
                  <label>
                    {t("ollamaUrlLabel")}
                    <input
                      value={ollamaUrl}
                      onChange={(e) => setOllamaUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("modelLabel")}
                    <div className="key-row">
                      <select
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                      >
                        <option value="">{t("selectPlaceholder")}</option>
                        {aiStatus?.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      <button
                        className="ghost sm"
                        onClick={loadModels}
                        disabled={loadingModels}
                      >
                        {loadingModels ? "…" : t("reload")}
                      </button>
                    </div>
                  </label>
                  {aiStatus && !aiStatus.available && (
                    <p className="warn">
                      {t("ollamaNotFound")}
                      <a
                        href="https://ollama.com"
                        onClick={(e) => {
                          e.preventDefault();
                          api.openExternal("https://ollama.com");
                        }}
                      >
                        {t("downloadOllama")}
                      </a>
                    </p>
                  )}
                  {aiStatus?.available && aiStatus.models.length === 0 && (
                    <p className="hint">
                      {t("noModelInstalled")}
                      <code>ollama pull llama3.1</code>.
                    </p>
                  )}
                </>
              )}

              {provider === "azure" && (
                <>
                  <label>
                    {t("azureKeyLabel")}
                    <div className="key-row">
                      <input
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        value={azureKey}
                        placeholder={t("azureKeyPlaceholder")}
                        onChange={(e) => {
                          setAzureKey(e.target.value);
                          setAzureValidation(null);
                        }}
                      />
                      <button
                        className="ghost sm"
                        onClick={() =>
                          pasteInto((v) => {
                            setAzureKey(v);
                            setAzureValidation(null);
                          })
                        }
                      >
                        {t("paste")}
                      </button>
                      <button
                        className="ghost sm"
                        onClick={validateAzureCreds}
                        disabled={
                          azureValidating ||
                          !azureKey.trim() ||
                          !azureRegion.trim()
                        }
                      >
                        {azureValidating ? t("validating") : t("validate")}
                      </button>
                    </div>
                  </label>
                  <label>
                    {t("regionLabel")}
                    <input
                      value={azureRegion}
                      placeholder={t("regionPlaceholder")}
                      onChange={(e) => {
                        setAzureRegion(e.target.value);
                        setAzureValidation(null);
                      }}
                    />
                  </label>
                  <label>
                    {t("endpointLabel")}
                    <div className="key-row">
                      <input
                        value={azureEndpoint}
                        onChange={(e) => setAzureEndpoint(e.target.value)}
                      />
                      <button
                        className="ghost sm"
                        onClick={() => pasteInto(setAzureEndpoint)}
                      >
                        {t("paste")}
                      </button>
                    </div>
                  </label>
                  {azureValidation && (
                    <p className={azureValidation.valid ? "ok" : "warn"}>
                      {azureValidation.message}
                    </p>
                  )}
                  <p className="hint">
                    {t("azureHintPre")}
                    <em>Keys and Endpoint</em>
                    {t("azureHintPost")}
                  </p>
                </>
              )}
            </div>
          )}

          {tab === "playback" && (
            <div>
              <span className="section-label">{t("playbackCastLabel")}</span>
              <label>
                {t("ramForStreaming")}
                <select
                  value={String(castRamGb)}
                  onChange={(e) => setCastRamGb(Number(e.target.value))}
                >
                  <option value="0.25">{t("ram025")}</option>
                  <option value="0.5">{t("ram05")}</option>
                  <option value="1">{t("ram1")}</option>
                  <option value="2">{t("ram2")}</option>
                  <option value="4">{t("ram4")}</option>
                </select>
              </label>
              <p className="hint">
                {t("ramHintPre")}
                <strong>{t("instantSeek")}</strong>
                {t("ramHintPost")}
              </p>
            </div>
          )}
        </div>

        {ioMsg && <p className="io-msg muted">{ioMsg}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={doExport}>
            {t("export")}
          </button>
          <button className="ghost" onClick={doImport}>
            {t("import")}
          </button>
          <span className="actions-spacer" />
          <button className="ghost" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="primary"
            onClick={() =>
              onSave({
                apiKey: apiKey.trim(),
                language,
                uiLanguage,
                translationProvider: provider,
                ollamaUrl: ollamaUrl.trim(),
                ollamaModel,
                azureKey: azureKey.trim(),
                azureRegion: azureRegion.trim(),
                azureEndpoint: azureEndpoint.trim(),
                castRamGb,
              })
            }
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
