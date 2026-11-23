FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public
USER node
ENV NODE_OPTIONS="--max-old-space-size=64"
EXPOSE 3000
CMD ["node", "src/server.js"]