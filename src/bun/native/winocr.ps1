# OCR on-device do Windows (WinRT Windows.Media.Ocr), sem compilar nada.
# Uso: winocr.ps1 <lang-bcp47> <manifest>
#   <manifest> = arquivo texto com um caminho de BMP por linha.
# Saída (stdout, UTF-8): o texto de cada imagem, seguido de uma linha "@@ENDIMG@@".
param([string]$Lang, [string]$Manifest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# Helper para aguardar (síncrono) um IAsyncOperation<T> do WinRT.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

# Carrega as projeções WinRT (ContentType = WindowsRuntime).
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Storage.FileAccessMode, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# Cria o motor no idioma pedido; se o pacote não estiver instalado, cai para o
# idioma do perfil do usuário. Sem nenhum motor → erro claro.
$engine = $null
try {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
} catch {}
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) {
  [Console]::Error.WriteLine("no-ocr-language: nenhum pacote de OCR instalado para '$Lang'")
  exit 3
}

foreach ($path in [System.IO.File]::ReadAllLines($Manifest)) {
  if ([string]::IsNullOrWhiteSpace($path)) { continue }
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    # Preserva a ordem das linhas (topo→base), como o Vision.
    $text = ($result.Lines | ForEach-Object { $_.Text }) -join "`n"
    [Console]::Out.WriteLine($text)
    $stream.Dispose()
  } catch {
    [Console]::Out.WriteLine("")
  }
  [Console]::Out.WriteLine("@@ENDIMG@@")
}
