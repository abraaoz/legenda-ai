<img src="assets/icon-1024.png" width="110" align="right" alt="">

# Legenda AI pra mim

**Português** · [English](README.md)

App de computador (Mac, Windows e Linux) para **baixar, traduzir e assistir**
legendas dos seus vídeos — direto na sua TV, se quiser. Simples, offline quando
dá, e sem enviar seus arquivos pra lugar nenhum.

## O que ele faz

- 🔎 **Baixa a legenda certa** — acha no OpenSubtitles pela "impressão digital" do
  vídeo, então vem **100% sincronizada** (nada de legenda adiantada/atrasada).
- 🌎 **Traduz legendas** para o seu idioma, **mantendo a sincronia**. Funciona com
  legenda embutida no vídeo (MKV) ou com um arquivo `.srt` que você já tem. Três
  opções de tradução:
  - **Apple** — no próprio Mac, offline e grátis (macOS 15+);
  - **Ollama** — offline no seu computador (grátis, precisa instalar);
  - **Azure** — na nuvem (precisa de uma conta Microsoft).
- 👁️ **Lê legendas "em imagem"** de Blu-ray (aquelas que não são texto) e vira
  texto pra poder traduzir.
- 📺 **Toca na TV** — manda o vídeo **com a legenda** pra sua TV, seja
  **Chromecast/Google TV** ou **Samsung Smart TV** (e outras TVs com DLNA), com
  play/pause e a barra de tempo funcionando (pular pra frente/trás). Converte o
  vídeo quando a TV não aceita o formato.
- 🌐 **App em vários idiomas** — a interface está disponível em inglês, português,
  espanhol, francês, italiano, alemão e japonês (**⚙️ Settings → Languages**).

## Baixar e instalar

Pegue a versão mais recente na página de **[Releases](https://github.com/abraaoz/legenda-ai/releases/latest)**:

- **Mac (Apple Silicon)** → baixe o `.dmg`, abra e arraste pra Aplicativos.
- **Windows** → baixe o `.zip`, extraia e rode.
- **Linux** → baixe o `.tar.gz`.

> ⚠️ O app ainda **não é assinado**, então na primeira vez o sistema pode avisar
> que é de "desenvolvedor não identificado".
>
> **No Mac**, depois de arrastar pra Aplicativos, rode uma vez no Terminal para
> liberar a abertura:
>
> ```sh
> sudo xattr -d com.apple.quarantine /Applications/Legenda\ AI\ pra\ mim.app
> ```
>
> **No Windows**: **Mais informações → Executar assim mesmo**.

Depois de instalado, o app se **atualiza sozinho** (menu **Legenda AI pra mim →
Buscar atualizações…**).

## O que você precisa ter

- **ffmpeg** (para ler legendas embutidas e converter vídeo pra TV):
  no Mac, `brew install ffmpeg`. O app avisa se estiver faltando.
- **Chave do OpenSubtitles** (só para baixar legendas): crie grátis em
  [opensubtitles.com](https://www.opensubtitles.com) → *Consumers* → gere uma
  *API Key* e cole em **⚙️ Settings**.
- Para **traduzir**: no Mac não precisa de nada (usa o tradutor da Apple). Fora do
  Mac, instale o [Ollama](https://ollama.com) ou use uma chave do Azure.

## Como usar

1. **Escolha os idiomas** — em **⚙️ Settings → Languages**, defina o idioma do app
   e o idioma das legendas (baixar e traduzir).
2. **Adicione vídeos** — botão *Select videos* (ou uma pasta inteira).
3. **Baixar legenda** — *Search on OpenSubtitles* → *Download* na que tiver o selo
   de sincronizada.
4. **Traduzir** — clique em *Translate* numa faixa embutida ou numa legenda `.srt`
   que não esteja no seu idioma. A legenda traduzida é salva **ao lado do vídeo**
   (ex.: `Filme.pt-BR.srt`), pronta pra qualquer player.
5. **Assistir na TV** — *📺 Play on TV*, escolha a TV e a legenda, e dê play. Use a
   barrinha de tempo para pular.

Tudo o que o app faz aparece em tempo real na **coluna de log** à direita.

## Privacidade

Seus vídeos **nunca saem do seu computador**. A tradução pela Apple/Ollama é 100%
local. Só o texto da legenda é enviado se você escolher o Azure (nuvem).

---

Feito com [Bun](https://bun.sh) + [Electrobun](https://electrobun.dev) (sem
Node/Electron). Quer contribuir ou entender por dentro? Veja o [DEV.md](DEV.md).
Licença MIT.
