# zahialga• ERP V2 — production image
# Alpine-д libssl3 аль хэдийн бий. Нэмэлт OS багц татахгүй (илүү найдвартай, хурдан).
# Prisma OpenSSL-ийн хувилбарыг автоматаар буруу таньдаг тул engine-ийг шууд зааж өгнө.
FROM node:20-alpine AS deps
WORKDIR /app
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x
RUN npx prisma generate && npx next build

FROM node:20-alpine AS run
WORKDIR /app
# Тогтмол UID 1001 — зургийн volume-ийн эрхийг docker-compose дээр найдвартай тохируулахын тулд
RUN addgroup -S -g 1001 app && adduser -S -u 1001 app -G app && mkdir -p /app/data/uploads && chown -R app:app /app/data
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Asia/Ulaanbaatar PORT=3000 HOSTNAME=0.0.0.0 UPLOAD_DIR=/app/data/uploads \
    PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node \
    PRISMA_SCHEMA_ENGINE_BINARY=/app/node_modules/@prisma/engines/schema-engine-linux-musl-openssl-3.0.x
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts/create-super-admin.mjs ./scripts/create-super-admin.mjs
# migrate deploy-д хэрэгтэй Prisma CLI
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY docker/entrypoint.sh ./entrypoint.sh
COPY docker/healthcheck.mjs ./healthcheck.mjs
RUN chmod +x ./entrypoint.sh && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["node", "healthcheck.mjs"]
ENTRYPOINT ["./entrypoint.sh"]
