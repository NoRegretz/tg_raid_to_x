FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/doctor.js scripts/x-account.js ./scripts/
USER node
CMD ["node", "src/main.js"]
