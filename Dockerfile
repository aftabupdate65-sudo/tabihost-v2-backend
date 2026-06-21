FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/tmp_uploads
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.mjs"]
