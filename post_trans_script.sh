#!/bin/bash

cd gnome-tweaks
cp -r ".config/ ~/"
cp -r ".local/ ~/"
gsettings set org.gnome.desktop.background picture-uri "$HOME/.local/share/backgrounds/2026-06-04-10-13-41-background"
gsettings set org.gnome.desktop.background picture-uri-dark "$HOME/.local/share/backgrounds/2026-06-04-10-13-41-background"

