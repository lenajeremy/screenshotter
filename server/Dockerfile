# The server, as Pier builds and runs it (pier deploy, from this folder).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
