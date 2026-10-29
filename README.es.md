# video-edit-mcp

[English](README.md) · MIT

Servidor [Model Context Protocol](https://modelcontextprotocol.io) de código abierto: corta, recorta, une, reencuadra, subtitula, mezcla y renderiza video desde cualquier cliente MCP (Claude Desktop, Cursor, …). Todo corre en tu máquina: ffmpeg para cortar/mezclar/codificar, [HyperFrames](https://github.com/heygen-com/hyperframes) opcional para subtítulos animados y composición, y Whisper local opcional para transcribir. Sin llamadas a la nube ni API keys.

## Instalación
Requisitos: Node 22+, `ffmpeg` y `ffprobe` en el `PATH`.
Opcional: `@hyperframes/producer` + Chrome headless (subtítulos animados, `compose`, capas HTML; si no, respaldo ffmpeg) y un CLI de Whisper (`whisper.cpp` o `faster-whisper`/`whisper-ctranslate2`) para `transcribe`.

```bash
git clone https://github.com/Galvez92/video-edit-mcp.git
cd video-edit-mcp
npm ci && npm run build
node dist/index.js                     # stdio
node dist/index.js --http --port 3333  # Streamable HTTP en http://127.0.0.1:3333/mcp
```

## Configuración del cliente MCP
**Claude Desktop** (`claude_desktop_config.json`) y **Cursor** (`~/.cursor/mcp.json` o `.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "video-edit": {
      "command": "node",
      "args": ["/ruta/absoluta/a/video-edit-mcp/dist/index.js"]
    }
  }
}
```
Las rutas que reciben las tools son rutas locales de la máquina donde corre el servidor.

## Herramientas
| Tool | Qué hace |
|---|---|
| `health` | Disponibilidad y versión de ffmpeg / ffprobe / Whisper |
| `probe` | Contenedor, duración, tamaño y streams de un archivo |
| `trim` | Conserva un rango; copia de flujo si cae en keyframe, si no re-encode |
| `cut` | Conserva varios rangos de un archivo y los une en orden |
| `concat` | Une archivos normalizando resolución / fps / audio |
| `render` | Codifica un archivo o un timeline multipista con preset (`web-1080p`, `vertical-9x16`, `square`, `audio-only`); transiciones, imágenes fijas + Ken Burns, capas overlay/HTML, subtítulos quemados, normalización de loudness |
| `export.package` | ZIP de entrega: media, `captions.srt`, `spec.json` (specs medidas + loudness EBU R128) y `checksums.sha256` |
| `compose` | Renderiza una composición HTML de HyperFrames a video (peer opcional) |
| `transcribe` | Transcripción local con Whisper y tiempos por palabra |
| `captions.generate` | Transcripción/SRT → SRT, ASS o subtítulos animados HyperFrames (`plain`, `karaoke`, `pop`, `box`) |
| `captions.render` | Quema subtítulos en un video (HyperFrames o ffmpeg/libass) conservando el audio |
| `reframe` | Reencuadre a 9:16, 1:1, 16:9 o 4:5: recorte (punto de foco o seguimiento), relleno de color o fondo desenfocado |
| `audio.measure` | Loudness integrado (LUFS), true peak y LRA |
| `audio.loudnorm` | Normalización en dos pasadas (−14 LUFS por defecto) |
| `audio.mix` | Voz + música con ducking y fades; el video se copia |

## Ejemplo de punta a punta
1. `probe { "path": "charla.mp4" }`
2. `transcribe { "input": "charla.mp4", "wordTimestamps": true }`
3. `render` con preset `vertical-9x16`, un timeline de clips con transición `crossfade`, `captions: { "transcript": "charla.transcript.json", "style": "box" }` y `loudness: {}` (ver el JSON completo en el [README en inglés](README.md#end-to-end-example)).
4. `export.package { "video": "out/final.mp4", "output": "out/final.zip", "preset": "vertical-9x16" }`

Detalles de capas, subtítulos, imágenes fijas y loudness en el [README en inglés](README.md).

## Desarrollo
```bash
npm test        # las pruebas con ffmpeg se omiten si no está instalado
npm run lint && npm run typecheck
```
Convenciones en [AGENTS.md](AGENTS.md).

## Terceros
- [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) — dependencia peer opcional, motor de composición/subtítulos.
- ffmpeg — se invoca como binario externo.
