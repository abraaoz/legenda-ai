// Cliente UPnP/DLNA (AVTransport) para TVs sem Chromecast (Samsung etc.).
// Espelha a interface do CastConnection (client.ts): open/load/play/pause/stop/
// seek + onStatus/onClose. O controle é SOAP sobre HTTP (fetch), e o tempo
// decorrido vem de um poll de GetPositionInfo (o renderer não empurra status).
//
// Legenda: usamos a extensão da Samsung `sec:CaptionInfoEx` no DIDL-Lite +
// um segundo <res> text/srt. A TV puxa o .srt do nosso servidor de mídia.

const SERVICE = 'urn:schemas-upnp-org:service:AVTransport:1'

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return m ? m[1].trim() : ''
}

/** Segundos → "H:MM:SS" (formato REL_TIME do UPnP). */
function hms(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** "H:MM:SS(.mmm)" → segundos. */
function parseHms(t: string): number {
  const parts = t.split(':').map((p) => Number(p))
  if (parts.some((n) => Number.isNaN(n))) return 0
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0]
  return h * 3600 + m * 60 + s
}

export interface DlnaMedia {
  contentUrl: string
  contentType: string
  /** true = stream transcodado (time-seek), false = arquivo cru (byte-seek). */
  transcode: boolean
  title: string
  durationSec: number
  subtitleUrl?: string
  subtitleLang?: string
}

/** protocolInfo do <res>. Sempre byte-seek (OP=01) — inclusive o transcode, que
 * é servido como arquivo crescente por range. CI=1 só marca "convertido". */
function protocolInfo(contentType: string, transcode: boolean): string {
  const flags = '01700000000000000000000000000000'
  const op = `DLNA.ORG_OP=01;DLNA.ORG_CI=${transcode ? 1 : 0}`
  return `http-get:*:${contentType}:${op};DLNA.ORG_FLAGS=${flags}`
}

/** Monta o DIDL-Lite (metadados) que acompanha o SetAVTransportURI. */
function buildDidl(media: DlnaMedia): string {
  const dur = media.durationSec > 0 ? ` duration="${hms(media.durationSec)}.000"` : ''
  let subRes = ''
  let caption = ''
  if (media.subtitleUrl) {
    const u = xmlEscape(media.subtitleUrl)
    subRes = `<res protocolInfo="http-get:*:text/srt:*">${u}</res>`
    caption =
      `<sec:CaptionInfoEx sec:type="srt">${u}</sec:CaptionInfoEx>` +
      `<sec:CaptionInfo sec:type="srt">${u}</sec:CaptionInfo>`
  }
  const didl =
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:sec="http://www.sec.co.kr/">` +
    `<item id="0" parentID="-1" restricted="1">` +
    `<dc:title>${xmlEscape(media.title)}</dc:title>` +
    `<upnp:class>object.item.videoItem</upnp:class>` +
    caption +
    `<res protocolInfo="${protocolInfo(media.contentType, media.transcode)}"${dur}>${xmlEscape(media.contentUrl)}</res>` +
    subRes +
    `</item></DIDL-Lite>`
  return didl
}

/** Uma "conexão" com um renderer DLNA (stateless via SOAP, + poll de status). */
export class DlnaConnection {
  private poll: ReturnType<typeof setInterval> | null = null
  private duration = 0
  private stopped = false
  onStatus: ((status: { playerState: string; currentTime: number; duration: number }) => void) | null =
    null
  onClose: (() => void) | null = null

  constructor(private controlUrl: string) {}

  /** Envia uma ação SOAP ao AVTransport e devolve o corpo da resposta. */
  private async soap(action: string, args: Record<string, string>): Promise<string> {
    const body =
      `<?xml version="1.0" encoding="utf-8"?>` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
      `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${SERVICE}">` +
      Object.entries(args)
        .map(([k, v]) => `<${k}>${v}</${k}>`)
        .join('') +
      `</u:${action}></s:Body></s:Envelope>`
    const res = await fetch(this.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${SERVICE}#${action}"`
      },
      body,
      signal: AbortSignal.timeout(10000)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`DLNA ${action} HTTP ${res.status}: ${text.slice(0, 160)}`)
    return text
  }

  // A "conexão" DLNA não tem handshake — só validamos que há URL de controle.
  async open(): Promise<void> {
    if (!this.controlUrl) throw new Error('DLNA: dispositivo sem URL de controle (AVTransport)')
  }

  // Compat com o fluxo do manager (Chromecast tem launch()); no DLNA é no-op.
  async launch(): Promise<void> {}

  async load(media: DlnaMedia): Promise<void> {
    this.duration = media.durationSec
    const didl = buildDidl(media)
    await this.soap('SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: xmlEscape(media.contentUrl),
      CurrentURIMetaData: xmlEscape(didl)
    })
    await this.soap('Play', { InstanceID: '0', Speed: '1' })
    this.startPoll()
  }

  async play(): Promise<void> {
    await this.soap('Play', { InstanceID: '0', Speed: '1' })
  }

  async pause(): Promise<void> {
    await this.soap('Pause', { InstanceID: '0' })
  }

  async stop(): Promise<void> {
    try {
      await this.soap('Stop', { InstanceID: '0' })
    } catch {
      // pode não haver mídia — ignora
    }
  }

  async seek(seconds: number): Promise<void> {
    await this.soap('Seek', { InstanceID: '0', Unit: 'REL_TIME', Target: hms(seconds) })
  }

  /** Pergunta posição/estado a cada 1s e empurra pro onStatus (barra da UI). */
  private startPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = setInterval(() => void this.tick(), 1000)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const pos = await this.soap('GetPositionInfo', { InstanceID: '0' })
      const rel = parseHms(xmlTag(pos, 'RelTime'))
      const trackDur = parseHms(xmlTag(pos, 'TrackDuration'))
      if (trackDur > 0 && this.duration === 0) this.duration = trackDur
      let state = 'PLAYING'
      try {
        const info = await this.soap('GetTransportInfo', { InstanceID: '0' })
        state = xmlTag(info, 'CurrentTransportState') || 'PLAYING'
      } catch {
        // alguns renderers não respondem GetTransportInfo — assume PLAYING
      }
      // Fechou enquanto o SOAP estava em voo? Não empurra status "fantasma"
      // (senão o card de reprodução reaparece logo depois do Stop).
      if (this.stopped) return
      this.onStatus?.({
        playerState: mapState(state),
        currentTime: rel,
        duration: this.duration
      })
    } catch {
      // falha transitória de SOAP — ignora esta amostra
    }
  }

  close(): void {
    this.stopped = true
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.onClose?.()
  }
}

/** Normaliza o estado UPnP para o vocabulário do app (igual ao Chromecast). */
function mapState(s: string): string {
  switch (s.toUpperCase()) {
    case 'PLAYING':
      return 'PLAYING'
    case 'PAUSED_PLAYBACK':
    case 'PAUSED':
      return 'PAUSED'
    case 'TRANSITIONING':
      return 'BUFFERING'
    case 'STOPPED':
    case 'NO_MEDIA_PRESENT':
      return 'IDLE'
    default:
      return s.toUpperCase()
  }
}
