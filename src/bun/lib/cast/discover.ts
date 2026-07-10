// Descoberta de dispositivos Google Cast (Chromecast, Google TV, Nest Hub, etc.)
// via mDNS — consulta PTR por "_googlecast._tcp.local" no grupo multicast
// 224.0.0.251:5353. Usa Bun.udpSocket (sem node:dgram).
//
// Truque de macOS: o mDNSResponder do sistema ocupa a porta 5353, então NÃO
// bindamos nela. Em vez disso a query pede resposta UNICAST (bit QU no QCLASS),
// e os dispositivos respondem direto na nossa porta efêmera.

import type { CastDevice } from '../../../shared/types'
export type { CastDevice }

const MDNS_ADDR = '224.0.0.251'
const MDNS_PORT = 5353
const SERVICE = '_googlecast._tcp.local'

// --- Codificação da query DNS ---
function encodeName(name: string): number[] {
  const out: number[] = []
  for (const label of name.split('.').filter(Boolean)) {
    out.push(label.length)
    for (let i = 0; i < label.length; i++) out.push(label.charCodeAt(i))
  }
  out.push(0)
  return out
}

function buildQuery(): Uint8Array {
  const name = encodeName(SERVICE)
  const buf = new Uint8Array(12 + name.length + 4)
  const dv = new DataView(buf.buffer)
  dv.setUint16(0, 0) // transaction id
  dv.setUint16(2, 0) // flags: standard query
  dv.setUint16(4, 1) // qdcount = 1
  buf.set(name, 12)
  const o = 12 + name.length
  dv.setUint16(o, 12) // QTYPE = PTR
  dv.setUint16(o + 2, 0x8001) // QCLASS = IN + bit QU (resposta unicast)
  return buf
}

// --- Parsing das respostas (com compressão de nomes) ---
function readName(buf: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let o = offset
  let next = -1
  let hops = 0
  while (hops++ < 128) {
    const len = buf[o]
    if (len === undefined) break
    if (len === 0) {
      o += 1
      if (next < 0) next = o
      break
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[o + 1]
      if (next < 0) next = o + 2
      o = ptr
      continue
    }
    o += 1
    let s = ''
    for (let i = 0; i < len; i++) s += String.fromCharCode(buf[o + i])
    labels.push(s)
    o += len
  }
  return { name: labels.join('.'), next: next < 0 ? o : next }
}

interface Tables {
  srv: Map<string, { port: number; target: string }> // instance → {port,target}
  a: Map<string, string> // hostname → ip
  txt: Map<string, Record<string, string>> // instance → {fn,id,md,...}
}

/** Faz o merge dos registros de UM datagrama nas tabelas acumuladas. */
function parsePacket(buf: Uint8Array, t: Tables): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const qd = dv.getUint16(4)
  const total = dv.getUint16(6) + dv.getUint16(8) + dv.getUint16(10) // an+ns+ar
  let o = 12
  // pula as perguntas
  for (let i = 0; i < qd; i++) {
    o = readName(buf, o).next
    o += 4 // qtype + qclass
  }
  for (let i = 0; i < total; i++) {
    const rn = readName(buf, o)
    o = rn.next
    const type = dv.getUint16(o)
    const rdlen = dv.getUint16(o + 8)
    const rdata = o + 10
    o = rdata + rdlen
    if (type === 33) {
      // SRV: priority(2) weight(2) port(2) target(name)
      const port = dv.getUint16(rdata + 4)
      const target = readName(buf, rdata + 6).name
      t.srv.set(rn.name, { port, target })
    } else if (type === 1) {
      // A: 4 bytes IPv4
      t.a.set(rn.name, `${buf[rdata]}.${buf[rdata + 1]}.${buf[rdata + 2]}.${buf[rdata + 3]}`)
    } else if (type === 16) {
      // TXT: sequência de strings "chave=valor" com prefixo de tamanho
      const kv: Record<string, string> = {}
      let p = rdata
      while (p < rdata + rdlen) {
        const l = buf[p]
        p += 1
        let s = ''
        for (let i = 0; i < l; i++) s += String.fromCharCode(buf[p + i])
        p += l
        const eq = s.indexOf('=')
        if (eq > 0) kv[s.slice(0, eq)] = s.slice(eq + 1)
      }
      t.txt.set(rn.name, kv)
    }
  }
}

function assemble(t: Tables): CastDevice[] {
  const devices: CastDevice[] = []
  for (const [instance, srv] of t.srv) {
    const host = t.a.get(srv.target)
    if (!host) continue
    const txt = t.txt.get(instance) ?? {}
    // Descarta aparelhos SÓ de áudio (speakers, Chromecast Audio, grupos). O
    // campo `ca` do mDNS é um bitmask de capacidades; o bit 0 (0x01) = saída de
    // vídeo (validado: Gordocast/vídeo tem, Mi Smart Speaker/áudio não). Se `ca`
    // não vier, mantém (não filtra sem certeza).
    if (txt.ca !== undefined && (Number(txt.ca) & 0x01) === 0) continue
    devices.push({
      name: txt.fn || instance.split('.')[0] || 'Chromecast',
      host,
      port: srv.port || 8009,
      id: txt.id || instance,
      model: txt.md || '',
      protocol: 'chromecast'
    })
  }
  // dedup por id
  const byId = new Map<string, CastDevice>()
  for (const d of devices) byId.set(d.id, d)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * IPv4 da interface local que alcança `target` — sem node:os. Um socket UDP
 * "conectado" ao alvo faz o SO escolher a interface de egresso, cujo endereço
 * local lemos (não envia pacote nenhum). **Passe o IP do dispositivo Cast**:
 * assim pegamos a interface da mesma LAN, e não uma VPN/rota default (CGNAT).
 */
export async function localIp(target = '8.8.8.8'): Promise<string> {
  const probe = await Bun.udpSocket({
    connect: { hostname: target, port: 8009 },
    socket: { data() {} }
  })
  const ip = (probe.address as { address?: string } | undefined)?.address ?? '0.0.0.0'
  probe.close()
  return ip
}

async function runFirst(cmds: string[][]): Promise<string> {
  for (const cmd of cmds) {
    try {
      const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(proc.stdout).text()
      if ((await proc.exited) === 0 && out.trim()) return out
    } catch {
      // comando não encontrado — tenta o próximo
    }
  }
  return ''
}

/** Lista os IPv4 locais — não há API nativa no Bun. Usa caminhos ABSOLUTOS
 * (um .app aberto pelo Finder tem PATH mínimo, sem /sbin). */
async function listLocalIPv4(): Promise<string[]> {
  const isWin = process.platform === 'win32'
  const out = isWin
    ? await runFirst([['ipconfig']]) // System32 sempre no PATH do Windows
    : await runFirst([
        ['/sbin/ifconfig'],
        ['/usr/sbin/ifconfig'],
        ['ifconfig'],
        ['/usr/sbin/ip', '-4', 'addr'],
        ['/sbin/ip', '-4', 'addr'],
        ['ip', '-4', 'addr']
      ])
  const ips = new Set<string>()
  const re = isWin ? /IPv4[^:]*:\s*([\d.]+)/g : /inet (?:addr:)?([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) ips.add(m[1])
  return [...ips]
}

/** Interfaces de LAN privada (192.168/10/172.16-31), excluindo loopback e CGNAT (100.64/10, usado por VPN/Tailscale). */
function lanCandidates(ips: string[]): string[] {
  return ips.filter(
    (ip) =>
      /^192\.168\./.test(ip) ||
      /^10\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

/**
 * Descobre Chromecasts na LAN. Envia a query mDNS em CADA interface de LAN
 * privada (ignora VPN/CGNAT, que não alcança o multicast local) e coleta as
 * respostas por `timeoutMs` (default 2500ms), mesclando os resultados.
 */
export async function discoverCastDevices(timeoutMs = 2500): Promise<CastDevice[]> {
  const tables: Tables = { srv: new Map(), a: new Map(), txt: new Map() }
  let ips = lanCandidates(await listLocalIPv4())
  if (ips.length === 0) ips = [await localIp()] // fallback: rota default
  const query = buildQuery()

  const sockets = []
  for (const ip of ips) {
    try {
      const s = await Bun.udpSocket({
        hostname: ip,
        port: 0,
        socket: {
          data(_s, data) {
            try {
              parsePacket(data as Uint8Array, tables)
            } catch {
              // datagrama malformado — ignora
            }
          }
        }
      })
      s.setMulticastInterface?.(ip)
      s.setMulticastTTL?.(4)
      s.send(query, MDNS_PORT, MDNS_ADDR)
      sockets.push(s)
    } catch {
      // interface que não aceita multicast — ignora
    }
  }
  const half = Math.min(600, timeoutMs / 2)
  await Bun.sleep(half)
  for (const s of sockets) {
    try {
      s.send(query, MDNS_PORT, MDNS_ADDR) // reenvia (respostas mDNS podem se perder)
    } catch {
      // ignora
    }
  }
  await Bun.sleep(timeoutMs - half)
  for (const s of sockets) s.close()
  return assemble(tables)
}

// ---------------------------------------------------------------------------
// Descoberta DLNA/UPnP (Samsung Smart TV etc.) via SSDP — M-SEARCH multicast
// para 239.255.255.250:1900 procurando MediaRenderer. As respostas trazem um
// header LOCATION (XML de descrição do device), do qual extraímos o nome e a
// URL de controle do serviço AVTransport (usada para LOAD/PLAY/SEEK).
// ---------------------------------------------------------------------------

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const SSDP_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1'

function ssdpQuery(): Uint8Array {
  const msg =
    'M-SEARCH * HTTP/1.1\r\n' +
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    `ST: ${SSDP_ST}\r\n` +
    '\r\n'
  return new TextEncoder().encode(msg)
}

/** Extrai o valor de um header HTTP (case-insensitive) da resposta SSDP. */
function header(text: string, name: string): string {
  const re = new RegExp(`^${name}:\\s*(.+)$`, 'im')
  const m = re.exec(text)
  return m ? m[1].trim() : ''
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

function xmlTag(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i').exec(xml)
  return m ? decodeEntities(m[1].trim()) : ''
}

/** Resolve uma URL (possivelmente relativa) contra a base do LOCATION. */
function resolveUrl(base: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  try {
    const b = new URL(base)
    const origin = `${b.protocol}//${b.host}`
    return url.startsWith('/') ? origin + url : `${origin}/${url}`
  } catch {
    return url
  }
}

/** Acha o controlURL de um serviço (por regex no serviceType) no XML do device. */
function serviceControlUrl(xml: string, location: string, match: RegExp): string {
  const re = /<service>([\s\S]*?)<\/service>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const block = m[1]
    if (match.test(xmlTag(block, 'serviceType'))) {
      const ctrl = xmlTag(block, 'controlURL')
      if (ctrl) return resolveUrl(location, ctrl)
    }
  }
  return ''
}

/** true se o renderer aceita vídeo (Sink do ConnectionManager tem `video/`).
 * Best-effort: em caso de dúvida (sem ConnectionManager/Sink/erro) devolve true
 * pra não filtrar demais. */
async function rendersVideo(cmControlUrl: string): Promise<boolean> {
  if (!cmControlUrl) return true
  const service = 'urn:schemas-upnp-org:service:ConnectionManager:1'
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:GetProtocolInfo xmlns:u="${service}"></u:GetProtocolInfo></s:Body></s:Envelope>`
  try {
    const res = await fetch(cmControlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service}#GetProtocolInfo"` },
      body,
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok) return true
    const sink = xmlTag(await res.text(), 'Sink')
    if (!sink) return true
    return /:(video|image)\//i.test(sink)
  } catch {
    return true
  }
}

/** Busca o XML de descrição e monta o CastDevice DLNA (ou null se não servir). */
async function fetchDlnaDevice(location: string): Promise<CastDevice | null> {
  try {
    const res = await fetch(location, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return null
    const xml = await res.text()
    const controlUrl = serviceControlUrl(xml, location, /AVTransport/i)
    if (!controlUrl) return null // sem AVTransport não dá pra controlar reprodução
    // Descarta renderers só de áudio (o Sink não anuncia nenhum `video/`).
    const cmControl = serviceControlUrl(xml, location, /ConnectionManager/i)
    if (!(await rendersVideo(cmControl))) return null
    const name = xmlTag(xml, 'friendlyName') || 'TV (DLNA)'
    const model = xmlTag(xml, 'modelName') || xmlTag(xml, 'manufacturer') || ''
    const udn = xmlTag(xml, 'UDN') || location
    const host = new URL(location).hostname
    return { name, host, port: Number(new URL(location).port) || 80, id: udn, model, protocol: 'dlna', controlUrl }
  } catch {
    return null
  }
}

/** Descobre dispositivos DLNA/UPnP (MediaRenderer) na LAN via SSDP. */
export async function discoverDlnaDevices(timeoutMs = 2500): Promise<CastDevice[]> {
  let ips = lanCandidates(await listLocalIPv4())
  if (ips.length === 0) ips = [await localIp()]
  const query = ssdpQuery()
  const locations = new Set<string>()

  const sockets = []
  for (const ip of ips) {
    try {
      const s = await Bun.udpSocket({
        hostname: ip,
        port: 0,
        socket: {
          data(_s, data) {
            const text = new TextDecoder().decode(data as Uint8Array)
            const loc = header(text, 'LOCATION')
            if (loc) locations.add(loc)
          }
        }
      })
      s.setMulticastInterface?.(ip)
      s.setMulticastTTL?.(4)
      s.send(query, SSDP_PORT, SSDP_ADDR)
      sockets.push(s)
    } catch {
      // interface sem multicast — ignora
    }
  }
  // Reenvia em rajadas ao longo da janela — dispositivos SSDP respondem de forma
  // intermitente (uma TV pode não responder à 1ª query), então insistimos.
  const bursts = Math.max(2, Math.floor(timeoutMs / 800))
  const step = timeoutMs / bursts
  for (let i = 1; i < bursts; i++) {
    await Bun.sleep(step)
    for (const s of sockets) {
      try {
        s.send(query, SSDP_PORT, SSDP_ADDR)
      } catch {
        // ignora
      }
    }
  }
  await Bun.sleep(step)
  for (const s of sockets) s.close()

  const devices = await Promise.all([...locations].map(fetchDlnaDevice))
  const out = devices.filter((d): d is CastDevice => d != null)
  const byId = new Map<string, CastDevice>()
  for (const d of out) byId.set(d.id, d)
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}
