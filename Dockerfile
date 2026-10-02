FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js roster.js ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm","start"]
