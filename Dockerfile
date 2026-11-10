# zahialga• ERP V2 — production image
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

FROM node:20-alpine AS run
WORKDIR /app
RUN apk add --no-cache openssl tzdata && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Asia/Ulaanbaatar PORT=3000 HOSTNAME=0.0.0.0
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
RUN chmod +x ./entrypoint.sh && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["./entrypoint.sh"]
