#!/bin/sh
set -e
echo "[entrypoint] database migration шалгаж байна..."
node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
echo "[entrypoint] апп эхэлж байна..."
exec node server.js
