# The server, as Pier builds and runs it (pier deploy, from this folder).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN chmod 644 package.json package-lock.json && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
