# video-edit-mcp

[English](README.md) · MIT

Servidor [Model Context Protocol](https://modelcontextprotocol.io) de código abierto para que cualquier asistente edite video localmente con ffmpeg.

> Estado: inicial. `main` incluye `health` y `probe`; las herramientas de edición están en la hoja de ruta.

## Inicio rápido
Requisitos: Node 20+, ffmpeg y ffprobe en el `PATH`.

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

## Hoja de ruta
1. Cortar / recortar / concatenar / ensamblar timeline
2. Transcripción local (Whisper) · subtítulos animados (SRT/ASS + quemado) · reencuadre 9:16/1:1/16:9 · mezcla de audio, ducking, loudnorm −16 LUFS
3. Presets de render + exportación ZIP (video + SRT + spec.json)
4. Importación EDL / OTIO

## Desarrollo
```bash
npm test        # las pruebas con ffmpeg se omiten si no está instalado
npm run lint && npm run typecheck
```
Convenciones en [AGENTS.md](AGENTS.md).
