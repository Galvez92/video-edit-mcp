# video-edit-mcp

[English](README.md) · MIT

Servidor [Model Context Protocol](https://modelcontextprotocol.io) de código abierto para que cualquier asistente edite video localmente con ffmpeg.

> Estado: inicial. `main` incluye `health` y `probe`; `trim`, `cut` y `concat` llegan desde `feat/core-ffmpeg`.

## Inicio rápido
Requisitos: Node 22+, ffmpeg y ffprobe en el `PATH`.

```bash
npm ci && npm run build
node dist/index.js                     # stdio
node dist/index.js --http --port 3333  # Streamable HTTP en http://127.0.0.1:3333/mcp
```

Configuración de cliente MCP (stdio):
```json
{ "mcpServers": { "video-edit": { "command": "node", "args": ["/ruta/a/video-edit-mcp/dist/index.js"] } } }
```

## Herramientas
| Tool | Descripción |
|---|---|
| `health` | Disponibilidad y versión de ffmpeg / ffprobe |
| `probe` | Contenedor, duración y streams de un archivo local |
| `trim` | Conserva un rango de un archivo; copia de flujo si el inicio cae en keyframe, si no re-encode |
| `cut` | Conserva varios rangos de un archivo y los une en orden |
| `concat` | Une archivos en uno, normalizando resolución/fps/audio |

## Hoja de ruta
1. Cortar / recortar / concatenar / ensamblar timeline
2. Transcripción local (Whisper) · subtítulos animados renderizados con HyperFrames (exporta SRT/ASS + respaldo ffmpeg) · reencuadre 9:16/1:1/16:9 · mezcla de audio, ducking, loudnorm −16 LUFS
3. Composición HyperFrames (overlays, títulos) + presets de render ffmpeg + exportación ZIP (video + SRT + spec.json)
4. Importación EDL / OTIO

## Desarrollo
```bash
npm test        # las pruebas con ffmpeg se omiten si no está instalado
npm run lint && npm run typecheck
```
Convenciones en [AGENTS.md](AGENTS.md).

## Terceros
- [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) — dependencia peer opcional, motor de composición/subtítulos.
- ffmpeg — se invoca como binario externo.
