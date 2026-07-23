#!/bin/bash
# Parche rápido en el VPS para el typo de gamification (si aún no subiste el archivo nuevo)
# Uso: bash fix-gamification-syntax.sh
set -e
FILE="/var/www/jnsix-endurance-backend/src/services/gamification.service.js"

if [ ! -f "$FILE" ]; then
  echo "No se encontró $FILE"
  exit 1
fi

# Corrige: falta un ) al cerrar new Set(...)
sed -i "s/split('T')\[0\])\];/split('T')[0]))];/g" "$FILE"

echo "Verificando sintaxis..."
node --check "$FILE"
echo "OK. Reiniciando PM2..."
pm2 restart endurance-back
pm2 logs endurance-back --lines 15 --nostream
