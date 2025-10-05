FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Healthcheck requiere wget
RUN apk add --no-cache wget

# Usuario no root
RUN addgroup -S nodegrp && adduser -S nodeuser -G nodegrp

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY . .
USER nodeuser

EXPOSE 8085
CMD ["node","server.js"]
