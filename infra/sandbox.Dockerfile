# The per-session sandbox image: everything an agent might reach for,
# nothing it can hurt. One Fly Machine per settlement, destroyed on TTL.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git bash ca-certificates \
    python3 python3-pip python3-venv \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY packages/sandboxd/sandboxd.mjs ./sandboxd.mjs
# Sample worlds are baked in so `sample:<id>` needs no network.
COPY tasks/repos /samples

ENV WORK_DIR=/work \
    SAMPLES_DIR=/samples \
    PORT=9800
EXPOSE 9800

CMD ["node", "sandboxd.mjs"]
