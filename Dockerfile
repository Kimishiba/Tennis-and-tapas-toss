# Use a lightweight Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only to keep image small)
RUN npm ci --only=production

# Copy server code and public assets
COPY server.js ./
# We will copy public assets if/when the UI is added

# Expose the API port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Use a volume for persistent database storage
VOLUME ["/app/data"]

# Overwrite database path in container to use the volume
ENV DATABASE_PATH=/app/data/database.db

# Run the server
CMD ["node", "server.js"]
