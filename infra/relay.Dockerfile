# The public app: relay (rooms, sandbox manager, theme cache) + built frontend.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/relay/package.json apps/relay/
COPY packages/protocol/package.json packages/protocol/
COPY packages/runtime/package.json packages/runtime/
COPY packages/sandboxd/package.json packages/sandboxd/
COPY tasks/package.json tasks/
RUN npm ci
COPY . .
RUN npm run build --workspace apps/web

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/apps/relay apps/relay
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/protocol packages/protocol
COPY --from=build /app/packages/sandboxd packages/sandboxd
COPY --from=build /app/tasks/repos tasks/repos
COPY --from=build /app/node_modules node_modules

ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "apps/relay/src/server.ts"]
