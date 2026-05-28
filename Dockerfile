FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Update OS and install FFmpeg & Python (required for yt-dlp)
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip python-is-python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Dummy port for Render Web Service (so it doesn't fail the port binding check)
EXPOSE 3000

# Run the bot
CMD ["npm", "start"]
