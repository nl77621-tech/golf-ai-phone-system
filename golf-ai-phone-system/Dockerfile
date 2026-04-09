FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY server/ ./server/
COPY command-center/ ./command-center/

# Build the Command Center UI (static files served by Express)
# For now, we serve the source directly (no build step needed — uses ES modules via CDN)
RUN mkdir -p server/public && cp -r command-center/* server/public/

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server/index.js"]
