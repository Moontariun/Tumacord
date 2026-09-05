#!/usr/bin/env bash
set -euo pipefail

# Nome antigo mantido por compatibilidade; o desinstalador é o mesmo em
# qualquer distribuição.
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/uninstall-linux.sh" "$@"
