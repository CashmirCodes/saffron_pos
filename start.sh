#!/usr/bin/env bash
# Double-click-friendly start script for Mac/Linux.
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi
npm start
