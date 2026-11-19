#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Первый запуск: устанавливаю зависимости, это займёт минуту..."
  python3 -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt
fi
exec .venv/bin/python laptop/server.py "$@"
