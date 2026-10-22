FROM node:24.22.1-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
ENV PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
