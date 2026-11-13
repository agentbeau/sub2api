FROM golang:1.26-bookworm AS builder
# Keep the deployed, checked provider version unless an upgrade is explicitly selected.
# Passing CPA_VERSION=latest still opts into testing the newest upstream release.
ARG CPA_VERSION=v8.0.67
ENV GOTOOLCHAIN=auto
WORKDIR /src
RUN set -eu; repo=https://github.com/router-for-me/CLIProxyAPI.git; tag="${CPA_VERSION}"; \
  if [ "$tag" = latest ]; then \
    tag=$(git ls-remote --tags --refs "$repo" | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1); \
  fi; \
  echo "Building CPA $tag"; \
  git init -q . && git remote add origin "$repo" \
  && git fetch -q --depth 1 origin tag "$tag" && git checkout -q "$tag" \
  && printf '%s' "$tag" > /tmp/cpa-version
COPY activity /src/internal/sub2apiactivity
COPY patch-cpa /build/patch-cpa
COPY readiness-test/service_readiness_window_repro_test.go /src/sdk/cliproxy/service_readiness_window_repro_test.go
# Source drift fails the image build before any hook can be omitted. Tests exercise
# the real internal HTTP protocol, parent/child handoff, and synchronous-save ordering.
RUN go test /build/patch-cpa/main.go /build/patch-cpa/main_test.go \
  && go run /build/patch-cpa/main.go /src \
  && go test -race ./internal/sub2apiactivity \
  && go test ./sdk/cliproxy -run '^(TestReadinessWindowHealthIsNotModelReady|TestInitializationReadinessEmptyAndFailedBootstrap)$' -count=1
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false \
  -ldflags="-s -w -X 'main.Version=$(cat /tmp/cpa-version)' -X 'main.Commit=$(git rev-parse HEAD)'" \
  -o /out/CLIProxyAPI ./cmd/server/

FROM node:24-bookworm-slim AS panel
# Branding is a build-time transform. Node/TypeScript are absent from the runtime image.
ARG PANEL_VERSION=latest
ARG PANEL_SHA256=""
WORKDIR /branding
COPY brand-panel/package.json brand-panel/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY brand-panel/brand.mjs brand-panel/brand.test.mjs brand-panel/UPSTREAM_LICENSE ./
RUN node --test brand.test.mjs && node brand.mjs --fetch /out/management.html

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
  && rm -rf /var/lib/apt/lists/*
COPY --from=panel /out/management.html /panel/management.html
COPY --from=builder /src/LICENSE /usr/share/licenses/sub2api/provider-LICENSE
COPY brand-panel/UPSTREAM_LICENSE /usr/share/licenses/sub2api/dashboard-LICENSE
WORKDIR /CLIProxyAPI
COPY --from=builder /out/CLIProxyAPI ./CLIProxyAPI
COPY entrypoint.sh /entrypoint.sh
ENV MANAGEMENT_STATIC_PATH=/panel/management.html
# Defaults also cover a new image replacing an old container whose stored startup
# environment predates the activity protocol. The native lifecycle passes this too.
ENV SUB2API_ACTIVITY_ENDPOINT=http://r2.internal/__sub2api/activity
EXPOSE 8317
ENTRYPOINT ["/entrypoint.sh"]
