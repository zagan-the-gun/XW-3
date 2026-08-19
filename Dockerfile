FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

ENV DATA_DIR=/data
ENV PORT=8720
EXPOSE 8720
VOLUME /data

CMD ["node", "server.js"]
