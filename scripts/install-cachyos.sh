#!/usr/bin/env bash
set -euo pipefail

# Nome antigo, mantido porque circula em documentação e em clones já baixados.
# O instalador de verdade é `install-linux.sh`, que atende CachyOS/Arch,
# Fedora, Debian/Ubuntu e openSUSE com o mesmo comportamento.
exec "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/install-linux.sh" "$@"
