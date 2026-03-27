## Multi-stage Dockerfile for production-ready Express + TypeScript app
FROM node:18-alpine AS builder
WORKDIR /app

# Install app dependencies
COPY package.json package-lock.json* ./
RUN npm install --silent

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

## Production image
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm install --production --silent --omit=dev

# Copy built artifacts
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
