FROM node:18-slim

# Install FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy app source
COPY . .

# Create temp directory
RUN mkdir -p /tmp

# Railway uses dynamic ports, so don't expose specific port
# Railway will set PORT env variable automatically

# Start the application
CMD ["npm", "start"] 