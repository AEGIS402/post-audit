FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY hardhat.config.ts tsconfig.json ./
COPY contracts ./contracts
COPY src ./src
COPY scripts ./scripts
COPY test ./test
COPY fixtures ./fixtures
COPY escrow-hook/deployments ./escrow-hook/deployments

RUN npx hardhat compile

ENV HOST=0.0.0.0
ENV PORT=13000
EXPOSE 13000

CMD ["npm", "run", "api"]
