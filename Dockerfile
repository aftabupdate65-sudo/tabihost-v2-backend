FROM node:20-slim

# Install Docker CLI so the backend can build/run user containers
RUN apt-get update && apt-get install -y \
    docker.io \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/workspaces /app/uploads

EXPOSE 3000
ENV PORT=3000

CMD ["node", "server.mjs"]
