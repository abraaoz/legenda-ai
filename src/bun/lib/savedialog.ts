// Diálogo nativo de "Salvar como" via Bun.spawn (o Electrobun só expõe o de
// abrir). Mesmo padrão do open: osascript (macOS) / zenity (Linux) / PowerShell
// (Windows) — sem dependência nativa extra e sem depender do processo da GUI.

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  return code === 0 ? out.trim() : ''
}

/** Abre um "Salvar como" e retorna o caminho escolhido (ou '' se cancelado). */
export async function saveFileDialog(defaultName: string, title = 'Salvar'): Promise<string> {
  switch (process.platform) {
    case 'darwin':
      return run([
        'osascript',
        '-e',
        `POSIX path of (choose file name with prompt ${JSON.stringify(title)} default name ${JSON.stringify(defaultName)})`
      ])
    case 'linux':
      return run([
        'zenity',
        '--file-selection',
        '--save',
        '--confirm-overwrite',
        `--filename=${defaultName}`,
        `--title=${title}`
      ])
    case 'win32': {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.SaveFileDialog',
        `$d.FileName = '${defaultName.replace(/'/g, "''")}'`,
        "$d.Filter = 'JSON|*.json|Todos|*.*'",
        "if ($d.ShowDialog() -eq 'OK') { $d.FileName }"
      ].join('; ')
      return run(['powershell', '-NoProfile', '-Command', ps])
    }
    default:
      return ''
  }
}
