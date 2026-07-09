import { useEffect, useRef, useState } from "react";
import { AppLogo } from "./AppLogo";
import { api, onLog, onTranslateProgress } from "./api";
import type {
  AppSettings,
  DependencyStatus,
  EmbeddedSubtitle,
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

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "pt-br", label: "Português (Brasil)" },
  { code: "pt-pt", label: "Português (Portugal)" },
  { code: "en", label: "Inglês" },
  { code: "es", label: "Espanhol" },
  { code: "fr", label: "Francês" },
  { code: "it", label: "Italiano" },
  { code: "de", label: "Alemão" },
  { code: "ja", label: "Japonês" },
];

type VideoStatus = "analyzing" | "ready" | "error";

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
  translatingIndex?: number;
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

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: "",
    language: "pt-br",
    translationProvider: "ollama",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    azureKey: "",
    azureRegion: "",
    azureEndpoint: "https://api.cognitive.microsofttranslator.com",
  });
  const [showSettings, setShowSettings] = useState(false);
  const [videos, setVideos] = useState<VideoState[]>([]);
  const [picking, setPicking] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logBodyRef = useRef<HTMLDivElement>(null);

  const targetLabel =
    LANGUAGES.find((l) => l.code === settings.language)?.label ??
    settings.language;
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
      await addPaths(await api.selectFolder());
    } finally {
      setPickingFolder(false);
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
        message:
          results.length === 0
            ? "Nenhuma legenda com hash idêntico (o rip do seu arquivo é diferente)."
            : undefined,
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
    } catch (err) {
      patch(video.id, {
        extractingIndex: undefined,
        message: (err as Error).message,
      });
    }
  }

  async function aiTranslate(
    video: VideoState,
    sub: EmbeddedSubtitle,
  ): Promise<void> {
    if (!video.info) return;
    if (!sub.isText && !video.info.ocrAvailable) return;
    const info = video.info;
    patch(video.id, {
      translatingIndex: sub.index,
      translateDone: 0,
      translateTotal: 0,
      translatePhase: sub.isText ? "translate" : "ocr",
      message: undefined,
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
          v.id === video.id
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
    } catch (err) {
      patch(video.id, {
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
          v.id === video.id
            ? {
                ...v,
                translations: { ...(v.translations ?? {}), [sub.index]: st },
              }
            : v,
        ),
      );
    }
  }

  async function cancelTranslate(video: VideoState): Promise<void> {
    if (!video.info) return;
    await api.cancelTranslate(video.info.path);
  }

  async function removeVideo(video: VideoState): Promise<void> {
    // Se houver tradução em andamento, cancela no backend antes de remover.
    if (video.translatingIndex !== undefined && video.info) {
      await api.cancelTranslate(video.info.path);
    }
    setVideos((prev) => prev.filter((v) => v.id !== video.id));
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
              <p>Baixe ou traduza legendas sincronizadas para seus vídeos</p>
            </div>
          </div>
          <button
            className="ghost electrobun-webkit-app-region-no-drag"
            onClick={() => setShowSettings(true)}
          >
            ⚙️ Configurações
          </button>
        </header>

        <main className="content">
          <section className="dropzone">
            <p className="dz-title">Adicione seus vídeos</p>
            <div className="dz-actions">
              <button
                className="primary"
                onClick={pickVideos}
                disabled={picking}
              >
                {picking ? "Abrindo…" : "Selecionar vídeos"}
              </button>
              <button
                className="ghost"
                onClick={pickFolder}
                disabled={pickingFolder}
              >
                {pickingFolder ? "Varrendo pasta…" : "📁 Selecionar pasta"}
              </button>
            </div>
            {!settings.apiKey && (
              <p className="warn">
                ⚠️ Configure sua chave da API do OpenSubtitles nas
                configurações.
              </p>
            )}
          </section>

          {videos.length > 0 && (
            <p className="list-count">
              {videos.length} vídeo{videos.length > 1 ? "s" : ""} na lista
            </p>
          )}

          <section className="list">
            {videos.map((video) => (
              <article className="card" key={video.id}>
                <div className="card-head">
                  <div className="card-meta">
                    <strong title={video.path}>{video.name}</strong>
                    <span className="muted">
                      {video.status === "analyzing" && "Calculando hash…"}
                      {video.status === "error" && `Erro: ${video.error}`}
                      {video.info &&
                        `${formatSize(video.info.size)} · hash ${video.info.hash}`}
                    </span>
                  </div>
                  <div className="card-head-actions">
                    <button
                      className="primary sm"
                      disabled={video.status !== "ready" || video.searching}
                      onClick={() => search(video)}
                    >
                      {video.searching
                        ? "Buscando…"
                        : "Buscar no OpenSubtitles"}
                    </button>
                    <button
                      className="ghost sm remove-btn"
                      title="Remover da lista"
                      onClick={() => removeVideo(video)}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {video.info && video.info.embedded.length > 0 && (
                  <div className="embedded">
                    <p className="section-label">
                      🎞️ Legendas embutidas no arquivo (já sincronizadas)
                    </p>
                    <ul className="results">
                      {video.info.embedded.map((sub) => {
                        const st = video.translations?.[sub.index];
                        const translating =
                          video.translatingIndex === sub.index;
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
                                  <span className="badge">padrão</span>
                                )}
                                {sub.isForced && (
                                  <span className="badge">forced</span>
                                )}
                                {image && (
                                  <span className="badge badge-img">
                                    imagem
                                  </span>
                                )}
                                {sub.title || `Faixa ${sub.index}`} ·{" "}
                                {sub.language}
                              </span>
                              <span className="muted">
                                {sub.codec}
                                {canOcr &&
                                  " · imagem — será convertida por OCR"}
                                {blockedImage &&
                                  " · imagem — OCR indisponível (instale o Tesseract)"}
                              </span>
                            </div>
                            <div className="btn-group">
                              <button
                                className="ghost sm"
                                title={
                                  image
                                    ? "Extrair a legenda em imagem (.sup)"
                                    : undefined
                                }
                                disabled={video.extractingIndex === sub.index}
                                onClick={() => extractEmbedded(video, sub)}
                              >
                                {video.extractingIndex === sub.index
                                  ? "Extraindo…"
                                  : image
                                    ? "Extrair .sup"
                                    : "Extrair .srt"}
                              </button>
                              <button
                                className={`sm ${partial ? "continue" : "primary"}`}
                                title={
                                  blockedImage
                                    ? "Legenda em imagem: OCR indisponível (instale o Tesseract)"
                                    : aiReady
                                      ? `Traduzir para ${targetLabel} (${settings.translationProvider})${image ? " — via OCR" : ""}`
                                      : "Configure o motor de tradução (Ollama, Azure ou Apple) nas configurações"
                                }
                                disabled={
                                  blockedImage ||
                                  !aiReady ||
                                  complete ||
                                  (video.translatingIndex !== undefined &&
                                    !translating)
                                }
                                onClick={() => aiTranslate(video, sub)}
                              >
                                {blockedImage
                                  ? "Requer OCR"
                                  : translating
                                    ? "Processando…"
                                    : complete
                                      ? "✔ Traduzido"
                                      : partial
                                        ? `Continuar ${st!.done}/${st!.total}`
                                        : `${image ? "OCR + Traduzir" : "Traduzir"} → ${settings.language.toUpperCase()}`}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {video.translatingIndex !== undefined && (
                  <div className="progress">
                    <div className="progress-head">
                      <span className="muted">
                        {video.translatePhase === "ocr"
                          ? "Reconhecendo texto (OCR)… "
                          : settings.translationProvider === "azure"
                            ? "Traduzindo (Azure)… "
                            : settings.translationProvider === "apple"
                              ? "Traduzindo (Apple)… "
                              : "Traduzindo com IA (Ollama)… "}
                        <strong>
                          {video.translateDone ?? 0}/{video.translateTotal ?? 0}
                        </strong>{" "}
                        falas
                      </span>
                      <button
                        className="ghost sm"
                        onClick={() => cancelTranslate(video)}
                      >
                        Cancelar
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
                  <p className="muted embedded-hint">
                    Instale o ffmpeg para detectar e extrair legendas já
                    embutidas no vídeo.
                  </p>
                )}

                {video.savedPath && (
                  <p className="ok">✅ Legenda salva em {video.savedPath}</p>
                )}
                {video.message && <p className="warn">{video.message}</p>}

                {video.results && video.results.length > 0 && (
                  <ul className="results">
                    {video.results.map((r) => (
                      <li key={r.fileId}>
                        <div className="result-info">
                          <span className="result-title">
                            {r.fromHashMatch && (
                              <span className="badge">sync</span>
                            )}
                            {r.release || r.fileName}
                          </span>
                          <span className="muted">
                            {r.language} ·{" "}
                            {r.downloadCount.toLocaleString("pt-BR")} downloads
                            {r.ratings ? ` · ⭐ ${r.ratings}` : ""}
                          </span>
                        </div>
                        <button
                          className="ghost sm"
                          disabled={video.downloadingId === r.fileId}
                          onClick={() => download(video, r)}
                        >
                          {video.downloadingId === r.fileId
                            ? "Baixando…"
                            : "Baixar"}
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
          <span className="section-label">Log do backend</span>
          <button
            className="ghost sm electrobun-webkit-app-region-no-drag"
            onClick={() => setLogs([])}
          >
            Limpar
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
            <div className="log-empty">Sem eventos ainda…</div>
          )}
        </div>
      </aside>

      {showSettings && (
        <SettingsModal
          settings={settings}
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
  onClose,
  onSave,
  onImported,
}: {
  settings: AppSettings;
  onClose: () => void;
  onSave: (s: AppSettings) => void;
  onImported: (s: AppSettings) => void;
}) {
  const [tab, setTab] = useState<"checklist" | "download" | "translate">(
    "checklist",
  );
  const [ioMsg, setIoMsg] = useState("");
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [language, setLanguage] = useState(settings.language);
  const [provider, setProvider] = useState(settings.translationProvider);
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl);
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel);
  const [azureKey, setAzureKey] = useState(settings.azureKey);
  const [azureRegion, setAzureRegion] = useState(settings.azureRegion);
  const [azureEndpoint, setAzureEndpoint] = useState(settings.azureEndpoint);
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
    setProvider(s.translationProvider);
    setOllamaUrl(s.ollamaUrl);
    setOllamaModel(s.ollamaModel);
    setAzureKey(s.azureKey);
    setAzureRegion(s.azureRegion);
    setAzureEndpoint(s.azureEndpoint);
  }

  async function doExport(): Promise<void> {
    const { savedPath } = await api.exportSettings();
    setIoMsg(savedPath ? `Exportado para ${savedPath}` : "");
  }

  async function doImport(): Promise<void> {
    try {
      const s = await api.importSettings();
      applySettings(s);
      onImported(s); // já foi salvo no disco pelo backend; reflete no app também
      setIoMsg("Configurações importadas ✅");
    } catch (e) {
      setIoMsg("Falha ao importar: " + (e as Error).message);
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
          <h2>Configurações</h2>
          <div className="tabs">
            <button
              className={`tab ${tab === "checklist" ? "active" : ""}`}
              onClick={() => setTab("checklist")}
            >
              Checklist
            </button>
            <button
              className={`tab ${tab === "download" ? "active" : ""}`}
              onClick={() => setTab("download")}
            >
              Legendas por Download
            </button>
            <button
              className={`tab ${tab === "translate" ? "active" : ""}`}
              onClick={() => setTab("translate")}
            >
              Legendas por Tradução
            </button>
          </div>
        </div>

        <div className="modal-body">
          {tab === "checklist" && (
            <div className="deps">
              <div className="deps-head">
                <span className="section-label">Dependências externas</span>
                <button
                  className="ghost sm"
                  onClick={checkDeps}
                  disabled={checkingDeps}
                >
                  {checkingDeps ? "Verificando…" : "Reverificar"}
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
                {deps === null && <li className="muted">Verificando…</li>}
              </ul>
            </div>
          )}

          {tab === "download" && (
            <>
              <label>
                Chave da API do OpenSubtitles
                <div className="key-row">
                  <input
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={apiKey}
                    placeholder="cole sua Api-Key aqui"
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
                    Colar
                  </button>
                  <button
                    className="ghost sm"
                    onClick={validate}
                    disabled={validating || !apiKey.trim()}
                  >
                    {validating ? "Validando…" : "Validar"}
                  </button>
                </div>
              </label>
              {validation && (
                <p className={validation.valid ? "ok" : "warn"}>
                  {validation.message}
                </p>
              )}
              <p className="hint">
                Não tem uma chave (ou quer gerenciar as suas)?{" "}
                <a
                  href="https://www.opensubtitles.com/en/consumers"
                  onClick={(e) => {
                    e.preventDefault();
                    api.openExternal(
                      "https://www.opensubtitles.com/en/consumers",
                    );
                  }}
                >
                  Abrir a página de consumers ↗
                </a>
              </p>

              <label>
                Idioma das legendas a baixar
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {tab === "translate" && (
            <div className="ai-section">
              <label>
                Idioma alvo (destino da tradução)
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Provedor
                <select
                  value={provider}
                  onChange={(e) =>
                    setProvider(e.target.value as typeof provider)
                  }
                >
                  <option value="apple">
                    Apple — tradução on-device (macOS 15+)
                  </option>
                  <option value="ollama">Ollama (local, offline)</option>
                  <option value="azure">Azure AI Translator (nuvem)</option>
                </select>
              </label>

              {provider === "apple" && (
                <p className="hint">
                  Tradução on-device do macOS: offline, gratuita e sem limite de
                  taxa — sem chave nem modelo para configurar. Na primeira
                  tradução, o macOS pode baixar o par de idiomas automaticamente.
                  Requer macOS 15 (Sequoia) ou superior.
                </p>
              )}

              {provider === "ollama" && (
                <>
                  <label>
                    URL do Ollama
                    <input
                      value={ollamaUrl}
                      onChange={(e) => setOllamaUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Modelo
                    <div className="key-row">
                      <select
                        value={ollamaModel}
                        onChange={(e) => setOllamaModel(e.target.value)}
                      >
                        <option value="">— selecione —</option>
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
                        {loadingModels ? "…" : "Recarregar"}
                      </button>
                    </div>
                  </label>
                  {aiStatus && !aiStatus.available && (
                    <p className="warn">
                      Ollama não encontrado.{" "}
                      <a
                        href="https://ollama.com"
                        onClick={(e) => {
                          e.preventDefault();
                          api.openExternal("https://ollama.com");
                        }}
                      >
                        Baixar o Ollama ↗
                      </a>
                    </p>
                  )}
                  {aiStatus?.available && aiStatus.models.length === 0 && (
                    <p className="hint">
                      Nenhum modelo instalado. Rode, por exemplo,{" "}
                      <code>ollama pull llama3.1</code>.
                    </p>
                  )}
                </>
              )}

              {provider === "azure" && (
                <>
                  <label>
                    Chave do Azure Translator
                    <div className="key-row">
                      <input
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        value={azureKey}
                        placeholder="cole a chave (Ocp-Apim-Subscription-Key)"
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
                        Colar
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
                        {azureValidating ? "Validando…" : "Validar"}
                      </button>
                    </div>
                  </label>
                  <label>
                    Região
                    <input
                      value={azureRegion}
                      placeholder="ex.: brazilsouth"
                      onChange={(e) => {
                        setAzureRegion(e.target.value);
                        setAzureValidation(null);
                      }}
                    />
                  </label>
                  <label>
                    Endpoint
                    <div className="key-row">
                      <input
                        value={azureEndpoint}
                        onChange={(e) => setAzureEndpoint(e.target.value)}
                      />
                      <button
                        className="ghost sm"
                        onClick={() => pasteInto(setAzureEndpoint)}
                      >
                        Colar
                      </button>
                    </div>
                  </label>
                  {azureValidation && (
                    <p className={azureValidation.valid ? "ok" : "warn"}>
                      {azureValidation.message}
                    </p>
                  )}
                  <p className="hint">
                    As credenciais ficam na página <em>Keys and Endpoint</em> do
                    recurso no portal Azure.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {ioMsg && <p className="io-msg muted">{ioMsg}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={doExport}>
            Exportar…
          </button>
          <button className="ghost" onClick={doImport}>
            Importar…
          </button>
          <span className="actions-spacer" />
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary"
            onClick={() =>
              onSave({
                apiKey: apiKey.trim(),
                language,
                translationProvider: provider,
                ollamaUrl: ollamaUrl.trim(),
                ollamaModel,
                azureKey: azureKey.trim(),
                azureRegion: azureRegion.trim(),
                azureEndpoint: azureEndpoint.trim(),
              })
            }
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
