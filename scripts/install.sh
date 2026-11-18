#!/bin/sh
set -eu

RELEASE="https://github.com/praxgroup/installer/releases/latest/download"
PRAX_HOME="${PRAX_HOME:-$HOME/.local/share/prax}"

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) ASSET="prax-linux-x64" ;;
    Darwin-*)
        echo "FXServer n'existe pas pour macOS : installe la base avec l'image Docker (voir la documentation)." >&2
        exit 1
        ;;
    *)
        echo "Système non pris en charge : $(uname -s) $(uname -m). Il faut Linux x64." >&2
        exit 1
        ;;
esac

mkdir -p "$PRAX_HOME"
echo "Téléchargement du programme Prax..."
curl -fsSL "$RELEASE/$ASSET" -o "$PRAX_HOME/prax.part"
curl -fsSL "$RELEASE/$ASSET.sha256" -o "$PRAX_HOME/prax.sha256"

EXPECTED="$(cut -d ' ' -f 1 "$PRAX_HOME/prax.sha256")"
ACTUAL="$(sha256sum "$PRAX_HOME/prax.part" | cut -d ' ' -f 1)"
if [ "$EXPECTED" != "$ACTUAL" ]; then
    rm -f "$PRAX_HOME/prax.part"
    echo "Empreinte différente : le téléchargement est abîmé ou modifié. Rien n'a été lancé." >&2
    exit 1
fi

mv "$PRAX_HOME/prax.part" "$PRAX_HOME/prax"
rm -f "$PRAX_HOME/prax.sha256"
chmod +x "$PRAX_HOME/prax"

if [ -r /dev/tty ]; then
    exec "$PRAX_HOME/prax" install "$@" < /dev/tty
fi
exec "$PRAX_HOME/prax" install "$@"
