# chore/github-hardening
**Status:** in review · **Order:** anytime

## Goal
Endurecer el repo con funciones gratuitas de GitHub.

## Cambios
- `.github/dependabot.yml` (npm + github-actions, semanal, agrupado; `@hyperframes/producer` solo patch automático).
- `ci.yml`: `permissions: contents: read`, `pull_request` a main.
- Plantilla de PR, CODEOWNERS, SECURITY.md.
- Ajustes del repo (fuera del código): borrar ramas al fusionar, auto-merge, alertas y fixes de Dependabot, CodeQL default, reporte privado de vulnerabilidades, ruleset en main (check `test`, sin borrado ni force-push, PR obligatorio).
