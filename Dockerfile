FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY src ./src
COPY opencode-provider-example.json ./

ENV PORT=15722
ENV HOST=0.0.0.0

EXPOSE 15722

CMD ["node", "src/index.js"]
