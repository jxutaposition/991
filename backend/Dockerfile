FROM rust:1-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY agents ./agents
COPY tools ./tools
COPY migrations ./migrations

RUN cargo build --release --bin lele2-backend --bin migrate

FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/lele2-backend /app/lele2-backend
COPY --from=builder /app/target/release/migrate /app/migrate
COPY --from=builder /app/agents /app/agents
COPY --from=builder /app/tools /app/tools
COPY --from=builder /app/migrations /app/migrations

ENV APP_ENV=production
ENV AGENTS_DIR=/app/agents
ENV TOOLS_DIR=/app/tools

EXPOSE 3001
CMD ["/bin/sh", "-ec", "/app/migrate && exec /app/lele2-backend"]
