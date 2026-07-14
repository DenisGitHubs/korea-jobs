# korea-jobs collector — long-running reader worker (Railway/Fly/Render).
# Holds only the TG session + ingest secret (007: secret isolation by host).
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=optional

COPY tsconfig.json ./
COPY src ./src

# TG_SESSION, INGEST_URL, INGEST_SECRET, TG_API_ID/HASH come from the host's
# secret store at runtime — never baked into the image.
CMD ["npm", "start"]
