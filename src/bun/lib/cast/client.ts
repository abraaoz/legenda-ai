// Cliente do protocolo Google Cast (CASTV2) sobre TLS na porta 8009.
// Mensagens são o protobuf `CastMessage` (codificado à mão — 6 campos) com
// framing de 4 bytes big-endian. Usa Bun.connect (TLS self-signed do Chromecast).
//
// Fluxo: CONNECT → heartbeat (PING/PONG) → LAUNCH do Default Media Receiver
// (appId CC1AD845) → CONNECT no transportId da sessão → LOAD (com faixa de
// legenda VTT) → PLAY/PAUSE/SEEK/STOP.

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection'
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat'
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver'
const NS_MEDIA = 'urn:x-cast:com.google.cast.media'
export const DEFAULT_MEDIA_RECEIVER = 'CC1AD845'

// Firmware novo de Chromecast FECHA o canal virtual (envia CLOSE) se o CONNECT
// não identificar o sender direito. Payload nos moldes exatos do pychromecast.
const CONNECT_PAYLOAD = {
  type: 'CONNECT',
  origin: {},
  userAgent: 'LegendaAIpraMim',
  senderInfo: {
    sdkType: 2,
    version: '15.605.1.3',
    browserVersion: '44.0.2403.30',
    platform: 4,
    systemVersion: 'Macintosh; Intel Mac OS X10_10_3',
    connectionType: 1
  }
} as const

// ---------- protobuf CastMessage (encode/decode manual) ----------
function writeVarint(arr: number[], value: number): void {
  let v = value >>> 0
  while (v > 0x7f) {
    arr.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  arr.push(v)
}
function writeString(arr: number[], field: number, str: string): void {
  const bytes = new TextEncoder().encode(str)
  arr.push((field << 3) | 2)
  writeVarint(arr, bytes.length)
  for (const b of bytes) arr.push(b)
}
function writeVarintField(arr: number[], field: number, value: number): void {
  arr.push((field << 3) | 0)
  writeVarint(arr, value)
}
function encodeCastMessage(source: string, dest: string, namespace: string, payload: string): Uint8Array {
  const arr: number[] = []
  writeVarintField(arr, 1, 0) // protocol_version = CASTV2_1_0
  writeString(arr, 2, source)
  writeString(arr, 3, dest)
  writeString(arr, 4, namespace)
  writeVarintField(arr, 5, 0) // payload_type = STRING
  writeString(arr, 6, payload)
  return new Uint8Array(arr)
}
function readVarint(buf: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let o = offset
  while (o < buf.length) {
    const b = buf[o++]
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return { value: value >>> 0, next: o }
}
interface DecodedMessage {
  source: string
  namespace: string
  payload: string
}
function decodeCastMessage(buf: Uint8Array): DecodedMessage {
  let o = 0
  const out: DecodedMessage = { source: '', namespace: '', payload: '' }
  while (o < buf.length) {
    const tag = readVarint(buf, o)
    o = tag.next
    const field = tag.value >>> 3
    const wire = tag.value & 7
    if (wire === 0) {
      o = readVarint(buf, o).next
    } else if (wire === 2) {
      const len = readVarint(buf, o)
      o = len.next
      const bytes = buf.subarray(o, o + len.value)
      o += len.value
      if (field === 2) out.source = new TextDecoder().decode(bytes)
      else if (field === 4) out.namespace = new TextDecoder().decode(bytes)
      else if (field === 6) out.payload = new TextDecoder().decode(bytes)
    } else {
      break // wire types 1/5 não ocorrem nas nossas mensagens
    }
  }
  return out
}

// ---------- Mídia ----------
export interface CastMedia {
  /** URL do vídeo (servida pelo app na LAN). */
  contentUrl: string
  /** MIME do vídeo, ex.: "video/mp4", "video/x-matroska". */
  contentType: string
  title?: string
  /** Duração total em segundos (ajuda a barra na TV, útil no modo transcode). */
  durationSec?: number
  /** URL da legenda em VTT (opcional). */
  subtitleUrl?: string
  subtitleLang?: string
  subtitleLabel?: string
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }

/** Uma conexão CASTV2 com um dispositivo. */
export class CastConnection {
  private socket: import('bun').Socket<undefined> | null = null
  private buf = new Uint8Array(0)
  private outbox = new Uint8Array(0)
  private reqId = 1
  private pending = new Map<number, Pending>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private transportId = ''
  private mediaSessionId: number | null = null
  // Source id único por conexão — evita o receiver fechar como duplicata de
  // "sender-0" de uma conexão anterior não encerrada limpo.
  private source = `sender-${Math.floor(Math.random() * 1e9).toString(36)}`
  /** Chamado a cada MEDIA_STATUS (playerState, currentTime…). */
  onStatus: ((status: Record<string, unknown>) => void) | null = null
  onClose: (() => void) | null = null

  async open(host: string, port = 8009): Promise<void> {
    this.socket = (await Bun.connect({
      hostname: host,
      port,
      tls: { rejectUnauthorized: false },
      socket: {
        data: (_s, chunk) => this.onData(chunk as Uint8Array),
        drain: () => this.flush(),
        close: () => this.cleanup(),
        error: () => this.cleanup()
      }
    })) as unknown as import('bun').Socket<undefined>
    // canal virtual sender-0 → receiver-0 e heartbeat
    this.write(NS_CONNECTION, CONNECT_PAYLOAD, 'receiver-0')
    this.heartbeat = setInterval(() => this.write(NS_HEARTBEAT, { type: 'PING' }, 'receiver-0'), 5000)
  }

  private write(namespace: string, payloadObj: Record<string, unknown>, dest: string, source = this.source): void {
    const msg = encodeCastMessage(source, dest, namespace, JSON.stringify(payloadObj))
    const frame = new Uint8Array(4 + msg.length)
    new DataView(frame.buffer).setUint32(0, msg.length, false)
    frame.set(msg, 4)
    // Enfileira — o Bun.write NÃO bufferiza: pode escrever parcial (backpressure).
    const merged = new Uint8Array(this.outbox.length + frame.length)
    merged.set(this.outbox)
    merged.set(frame, this.outbox.length)
    this.outbox = merged
    this.flush()
  }

  /** Escoa a fila de saída; o que não couber sai no próximo evento `drain`. */
  private flush(): void {
    if (!this.socket || this.outbox.length === 0) return
    const n = this.socket.write(this.outbox)
    if (n > 0) this.outbox = this.outbox.slice(n)
  }

  private onData(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged
    while (this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, false)
      if (this.buf.length < 4 + len) break
      const msgBytes = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.slice(4 + len)
      this.handle(decodeCastMessage(msgBytes))
    }
  }

  private handle(msg: DecodedMessage): void {
    if (!msg.payload) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(msg.payload)
    } catch {
      return
    }
    if (msg.namespace === NS_HEARTBEAT && payload.type === 'PING') {
      this.write(NS_HEARTBEAT, { type: 'PONG' }, msg.source || 'receiver-0')
      return
    }
    const rid = payload.requestId
    if (typeof rid === 'number' && this.pending.has(rid)) {
      this.pending.get(rid)!.resolve(payload)
      this.pending.delete(rid)
    }
    if (payload.type === 'MEDIA_STATUS') {
      const st = (payload.status as Array<Record<string, unknown>> | undefined)?.[0]
      if (st?.mediaSessionId) this.mediaSessionId = st.mediaSessionId as number
      if (st) this.onStatus?.(st)
    }
  }

  private request(namespace: string, payloadObj: Record<string, unknown>, dest: string): Promise<Record<string, unknown>> {
    const requestId = this.reqId++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('Cast: tempo esgotado esperando resposta'))
      }, 10000)
      this.write(namespace, { ...payloadObj, requestId }, dest)
    })
  }

  /** Lança um app receiver e retorna o transportId da sessão. */
  async launch(appId = DEFAULT_MEDIA_RECEIVER): Promise<{ sessionId: string; transportId: string }> {
    const res = await this.request(NS_RECEIVER, { type: 'LAUNCH', appId }, 'receiver-0')
    const status = res.status as { applications?: Array<Record<string, string>> } | undefined
    const app =
      status?.applications?.find((a) => a.appId === appId) ?? status?.applications?.[0]
    if (!app?.transportId) throw new Error('Cast: o app não iniciou (sem transportId)')
    this.transportId = app.transportId
    // conecta ao canal virtual da sessão (obrigatório antes de mandar mídia)
    this.write(NS_CONNECTION, CONNECT_PAYLOAD, this.transportId)
    return { sessionId: app.sessionId ?? '', transportId: app.transportId }
  }

  /** Carrega e começa a tocar a mídia (com faixa de legenda VTT, se houver). */
  async load(media: CastMedia): Promise<void> {
    const info: Record<string, unknown> = {
      contentId: media.contentUrl,
      contentType: media.contentType,
      streamType: 'BUFFERED',
      metadata: { metadataType: 0, title: media.title ?? '' }
    }
    if (media.durationSec && media.durationSec > 0) info.duration = media.durationSec
    const req: Record<string, unknown> = { type: 'LOAD', media: info, autoplay: true, currentTime: 0 }
    if (media.subtitleUrl) {
      info.tracks = [
        {
          trackId: 1,
          type: 'TEXT',
          subtype: 'SUBTITLES',
          trackContentId: media.subtitleUrl,
          trackContentType: 'text/vtt',
          language: media.subtitleLang ?? 'pt-BR',
          name: media.subtitleLabel ?? 'Legenda'
        }
      ]
      info.textTrackStyle = {
        backgroundColor: '#00000000',
        foregroundColor: '#FFFFFFFF',
        edgeType: 'OUTLINE',
        edgeColor: '#000000FF'
      }
      req.activeTrackIds = [1]
    }
    const res = await this.request(NS_MEDIA, req, this.transportId)
    const st = (res.status as Array<Record<string, unknown>> | undefined)?.[0]
    if (st?.mediaSessionId) this.mediaSessionId = st.mediaSessionId as number
  }

  private media(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.mediaSessionId == null) throw new Error('Cast: nenhuma mídia carregada')
    return this.request(NS_MEDIA, { type, mediaSessionId: this.mediaSessionId, ...extra }, this.transportId)
  }
  play(): Promise<Record<string, unknown>> {
    return this.media('PLAY')
  }
  pause(): Promise<Record<string, unknown>> {
    return this.media('PAUSE')
  }
  stop(): Promise<Record<string, unknown>> {
    return this.media('STOP')
  }
  seek(seconds: number): Promise<Record<string, unknown>> {
    return this.media('SEEK', { currentTime: seconds })
  }

  close(): void {
    try {
      this.write(NS_CONNECTION, { type: 'CLOSE' }, 'receiver-0')
    } catch {
      // ignora
    }
    this.cleanup()
  }

  private cleanup(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const p of this.pending.values()) p.reject(new Error('Cast: conexão encerrada'))
    this.pending.clear()
    try {
      this.socket?.end()
    } catch {
      // ignora
    }
    this.socket = null
    this.onClose?.()
  }
}
