# Notes for Claude

## Token budget (graphify)
- Before exploring code, build the code graph (AST only, no LLM, a few seconds):
  `pip install -q graphifyy 2>/dev/null || pip install -q --break-system-packages graphifyy; graphify update .`
- Navigate with the graph instead of grep or reading whole files: `graphify query "<question>"` (capped at ~2000
  tokens), `graphify explain "<symbol>"`, `graphify affected "<symbol>"` before changing it, `graphify path "A" "B"`.
  Read `graphify-out/GRAPH_REPORT.md` only when an architecture overview is needed.
- Then open only the files and line ranges the graph points to (Read with offset/limit). Never read `vendor/`,
  `fonts/`, `icons/`, images, data/JSON dumps or minified bundles unless the task is about them.
- After editing code run `graphify update .` again. `graphify-out/` is gitignored; never commit it.
